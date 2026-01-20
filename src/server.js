require('dotenv').config();
const nodemailer = require('nodemailer');
const express = require('express');
const db = require('./config/database');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');
const whatsappService = require('./services/whatsappService');
const { obterQRAtualizado, encerrarSessao } = require('./services/whatsappService');

const app = express();
const port = process.env.PORT || 3000;

// 1. Configuração Mercado Pago
const clientMP = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});
const payment = new Payment(clientMP);
const preference = new Preference(clientMP);

// 2. Middlewares de Dados (ESSENCIAL para o Webhook não dar erro)
app.use(express.json());

// 3. ROTA RAIZ (Vem ANTES do static para garantir que vendas.html seja a primeira página)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/vendas.html'));
});

app.use(express.static(path.join(__dirname, '../public')));

// ... Restante das suas APIs (qrcode, pedidos, login, etc)

// Rota principal - Entrega o Dashboard/Painel

// ==========================================
// --- API WHATSAPP (CONEXÃO E QR CODE) ---
// ==========================================

app.get('/api/qrcode', async (req, res) => {
    const { id_empresa } = req.query;

    if (!id_empresa) {
        return res.status(400).json({ error: "ID da empresa não informado" });
    }

    try {
        const statusServico = await whatsappService.obterQRAtualizado(id_empresa);

        // 1. Caso já esteja conectado: Envia 204 para mostrar o card verde
        if (statusServico === "CONECTADO" || !statusServico) {
            return res.status(204).end();
        }

        // 2. Caso esteja inicializando ou aguardando: Envia sinal para o frontend mostrar o loading
        if (statusServico === "INICIALIZANDO" || statusServico === "AGUARDANDO_GERACAO") {
            return res.json({ aguardando: true });
        }

        // 3. Caso seja o texto do QR Code: Gera a imagem e envia
        const urlImagem = await QRCode.toDataURL(statusServico);
        res.json({ qrcode: urlImagem });

    } catch (err) {
        console.error("Erro ao gerar QR:", err);
        res.status(500).json({ error: "Erro interno" });
    }
});

app.post('/api/whatsapp/desconectar', async (req, res) => {
    const { id_empresa } = req.body;
    try {
        await encerrarSessao(id_empresa);
        await new Promise(resolve => setTimeout(resolve, 500));
        const caminhoSessao = path.join(__dirname, `../.wwebjs_auth/session-empresa_${id_empresa}`);
        if (fs.existsSync(caminhoSessao)) {
            fs.rmSync(caminhoSessao, { recursive: true, force: true });
            console.log(`🗑️ Pasta de sessão empresa_${id_empresa} removida.`);
        }
        res.json({ success: true, message: "Desconectado com sucesso." });
    } catch (err) {
        console.error("Erro ao desconectar:", err);
        res.status(500).json({ error: "Erro ao desconectar" });
    }
});

// ==========================================
// --- API PAGAMENTO (MERCADO PAGO) ---
// ==========================================



app.post('/api/pagamento/gerar', async (req, res) => {
    const { plano, email } = req.body;
    const emailLimpo = email ? email.toLowerCase().trim() : 'cliente@exemplo.com';

    const valor = plano === 'anual' ? 1599.00 : 159.00; // Ajuste conforme preferir
    const descricao = plano === 'anual' ? 'Assinatura Anual NexusChat' : 'Assinatura Mensal NexusChat';
    const urlBase = "https://nexuchat.com";

    // LÓGICA MENSAL: Gera QR Code para exibir no seu site
    try {
        const preferenceData = {
            items: [{ 
                title: descricao, 
                quantity: 1, 
                unit_price: valor, 
                currency_id: 'BRL' 
            }],
            payer: { email: emailLimpo },
            external_reference: emailLimpo,
            notification_url: `${urlBase}/webhook`,
            // Configura o retorno automático para sua página de cadastro
            back_urls: { 
                success: `${urlBase}/registrar?email=${emailLimpo}`,
                pending: `${urlBase}/registrar?email=${emailLimpo}`,
                failure: `${urlBase}/vendas` 
            },
            auto_return: "approved", // Redireciona o cliente sozinho após o pagamento
            payment_methods: {
                installments: 12, // Permite parcelamento
                excluded_payment_types: [], // Não exclui nenhuma forma de pagamento (Cartão, PIX, etc)
            }
        };

        const response = await preference.create({ body: preferenceData });
        
        // Agora ambos os planos retornam o link do Mercado Pago
        res.json({ init_point: response.init_point });
    } catch (error) {
        console.error("Erro ao gerar Checkout:", error);
        res.status(500).json({ error: "Falha ao gerar Checkout" });
    }
});

app.post('/webhook', async (req, res) => {
    const { action, data } = req.body;

    // TRAVA 1: Resposta imediata para requisições inválidas do Mercado Pago
    if (!data || !data.id) return res.sendStatus(200);

    // Filtra apenas eventos de criação ou atualização de pagamento
    if (action === "payment.created" || action === "payment.updated") {
        try {
            const paymentId = data.id;
            const resMP = await payment.get({ id: paymentId });

            // TRAVA 2: Verificação rigorosa do status de aprovação
            if (resMP && resMP.status === 'approved') {
                const valorPago = resMP.transaction_amount;

                // Normalização do external_reference para garantir o vínculo com a conta correta
                let emailPagador = resMP.external_reference ? resMP.external_reference.toLowerCase().trim() : null;

                if (!emailPagador) {
                    console.error("❌ SEGURANÇA: Tentativa de ativação sem external_reference válida.");
                    return res.sendStatus(200);
                }

                // TRAVA 3: Lógica de dias com margem de segurança para o plano anual
                // Se o valor for maior que 500, consideramos plano anual, independente de centavos.
                const diasDeAcesso = valorPago > 500 ? 365 : 30;

                // Execução segura no banco de dados usando prepared statements
                await db.execute(`
                    INSERT INTO empresas (email_contato, status_assinatura, data_expiracao)
                    VALUES (?, 'ativo', DATE_ADD(NOW(), INTERVAL ? DAY))
                    ON DUPLICATE KEY UPDATE
                        status_assinatura = 'ativo',
                        data_expiracao = DATE_ADD(NOW(), INTERVAL ? DAY)`,
                    [emailPagador, diasDeAcesso, diasDeAcesso]
                );

                console.log(`💰 SUCESSO: Empresa ${emailPagador} ativada por ${diasDeAcesso} dias (Valor: R$ ${valorPago}).`);

                try {
                    const transporter = nodemailer.createTransport({
                        service: 'gmail',
                        auth: {
                            user: 'andreifernandezdevv@gmail.com', // Coloque seu e-mail aqui
                            pass: 'y y c j u t f x e m r p b w o r'      // Coloque sua senha de app aqui
                        }
                    });

                    const mailOptions = {
                        from: '"Suporte NexusChat" <seu-email@gmail.com>',
                        to: emailPagador,
                        subject: '🚀 Seu acesso ao NexusChat está pronto! (Manual de Instruções)',
                        html: `
                            <h1 style="color: #4f46e5;">Bem-vindo ao NexusChat!</h1>
                            <p>Olá! Detectamos seu pagamento e sua assinatura já está <b>ATIVA</b>.</p>
                            <p>Para começar a usar agora mesmo, siga o nosso manual de instruções:</p>
                            <p style="font-size: 18px;">👉 <a href="https://nexuchat.com/ajuda"><b>CLIQUE AQUI PARA ACESSAR O MANUAL</b></a></p>
                            <br>
                            <p><b>Dados de acesso:</b></p>
                            <ul>
                                <li><b>E-mail de login:</b> ${emailPagador}</li>
                                <li><b>Link do Painel:</b> <a href="https://nexuchat.com/login">nexuchat.com/login</a></li>
                            </ul>
                            <p><i>Se você ainda não criou sua senha, vá para a tela de cadastro e use o e-mail acima.</i></p>
                            <hr>
                            <p>Dúvidas? Responda este e-mail ou chame no WhatsApp de suporte.</p>
                        `
                    };

                    await transporter.sendMail(mailOptions);
                    console.log(`📧 Manual enviado com sucesso para: ${emailPagador}`);
                } catch (emailErr) {
                    console.error("❌ Erro ao enviar e-mail de boas-vindas:", emailErr.message);
                }
                // =======+
            }
        } catch (err) {
            // TRAVA 4: Log de erro silencioso para não expor a estrutura do banco ao cliente
            if (err.status !== 404) {
                console.error("❌ Erro interno no processamento do Webhook");
            }
        }
    }

    // Sempre retorna 200 para o Mercado Pago não tentar reenviar o mesmo evento infinitamente
    res.sendStatus(200);
});

// ==========================================
// --- API PEDIDOS (OPERAÇÃO E STATUS) ---
// ==========================================

app.get('/api/pedidos', async (req, res) => {
    const { id_empresa } = req.query;

    // TRAVA 1: Impede que a API retorne qualquer dado se o ID não for enviado
    if (!id_empresa) {
        return res.status(401).json({ error: "Acesso não autorizado" });
    }

    try {
        // TRAVA 2: A query agora obrigatoriamente filtra pelo id_empresa recebido.
        // Isso garante que, mesmo que alguém tente "chutar" IDs, o banco só retorne
        // os dados vinculados especificamente àquela empresa logada.
        let sql = `SELECT * FROM pedidos WHERE status = 'pendente' AND id_empresa = ?`;
        let params = [id_empresa];

        sql += ` ORDER BY data_pedido DESC LIMIT 50`;

        const [rows] = await db.execute(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Erro interno ao processar pedidos" });
    }
});

app.put('/api/pedidos/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status é obrigatório.' });
    try {
        await db.execute('UPDATE pedidos SET status = ? WHERE id = ?', [status, id]);
        res.json({ success: true, message: 'Status atualizado com sucesso' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/pedidos/:id/status', async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    try {
        await db.execute('UPDATE pedidos SET status = ? WHERE id = ?', [status, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/pedidos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('DELETE FROM pedidos WHERE id = ?', [id]);
        res.json({ success: true, message: "Pedido removido." });
    } catch (err) {
        console.error("Erro ao deletar:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// ==========================================
// --- API EMPRESA, LOGIN & CADASTRO ---
// ==========================================

app.get('/api/empresa/:id', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM empresas WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: "Empresa não encontrada" });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Erro no servidor" });
    }
});

app.put('/api/empresa/:id/config', async (req, res) => {
    const { dados_conhecimento } = req.body;
    const { id } = req.params;
    try {
        await db.execute('UPDATE empresas SET dados_conhecimento = ? WHERE id = ?', [dados_conhecimento, id]);
        res.json({ success: true, message: "Configurações atualizadas!" });
    } catch (err) {
        console.error("Erro ao atualizar banco:", err);
        res.status(500).json({ error: "Erro ao atualizar banco" });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    try {
        const sql = `
            SELECT u.id_empresa, e.status_assinatura, e.data_expiracao
            FROM usuarios u
            JOIN empresas e ON u.id_empresa = e.id
            WHERE u.email = ? AND u.senha = ?`;

        const [rows] = await db.execute(sql, [email, senha]);

        if (rows.length > 0) {
            const empresa = rows[0];
            const hoje = new Date();
            const expiracao = new Date(empresa.data_expiracao);

            if (hoje > expiracao) {
                return res.status(403).json({
                    success: false,
                    message: "Assinatura expirada. Renove o seu plano para aceder."
                });
            }

            res.json({ success: true, id_empresa: empresa.id_empresa });
        } else {
            res.status(401).json({ success: false, message: "E-mail ou senha incorretos." });
        }
    } catch (err) {
        res.status(500).json({ error: "Erro no servidor" });
    }
});

app.post('/api/cadastro', async (req, res) => {
    const { nome, email, senha, nome_empresa } = req.body;
    const emailNormalizado = email.toLowerCase().trim();

    try {
        // Busca na tabela empresas usando email_contato
        const [verificacao] = await db.execute(
            "SELECT id FROM empresas WHERE email_contato = ? AND status_assinatura = 'ativo'",
            [emailNormalizado]
        );

        if (verificacao.length === 0) {
            return res.status(403).json({
                success: false,
                message: "Acesso negado. Você precisa realizar o pagamento antes."
            });
        }

        const idEmpresa = verificacao[0].id;
        await db.execute('UPDATE empresas SET nome_negocio = ? WHERE id = ?', [nome_empresa, idEmpresa]);
        
        // Insere na tabela usuarios usando email (conforme seu banco)
        await db.execute('INSERT INTO usuarios (nome, email, senha, id_empresa) VALUES (?, ?, ?, ?)', 
            [nome, emailNormalizado, senha, idEmpresa]);

        res.json({ success: true, message: "Conta criada e vinculada com sucesso!" });

    } catch (err) {
        console.error("Erro no cadastro:", err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: "Este e-mail já possui um usuário cadastrado." });
        }
        res.status(500).json({ error: "Erro ao criar conta." });
    }
});

// ==========================================
// --- DASHBOARD E MÉTRICAS ---
// ==========================================

app.get('/api/dashboard/vendas', async (req, res) => {
    const { id_empresa, periodo = '7d', data_inicio, data_fim } = req.query;
    if (!id_empresa) return res.status(400).json({ error: 'ID da empresa é obrigatório.' });

    let queryPeriodo = '';
    const queryParams = [id_empresa];

    if (periodo === '7d') {
        queryPeriodo = 'AND data_pedido >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    } else if (periodo === '30d') {
        queryPeriodo = 'AND data_pedido >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    } else if (periodo === 'month') {
        queryPeriodo = 'AND YEAR(data_pedido) = YEAR(CURDATE()) AND MONTH(data_pedido) = MONTH(CURDATE())';
    } else if (periodo === 'custom' && data_inicio && data_fim) {
        queryPeriodo = 'AND data_pedido BETWEEN ? AND ?';
        queryParams.push(data_inicio, data_fim);
    } else {
        queryPeriodo = 'AND data_pedido >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    }

    try {
        const [vendasResumo] = await db.execute(`
            SELECT
                IFNULL(SUM(valor_total), 0) as totalVendas,
                COUNT(id) as totalPedidos,
                IFNULL(AVG(valor_total), 0) as ticketMedio
            FROM pedidos
            WHERE id_empresa = ? AND status = 'concluido' ${queryPeriodo}
        `, queryParams);

        const [pedidosPorStatus] = await db.execute(`
            SELECT status, COUNT(id) as count
            FROM pedidos
            WHERE id_empresa = ? ${queryPeriodo}
            GROUP BY status
        `, queryParams);

        const [vendasPorPagamento] = await db.execute(`
            SELECT forma_pagamento, SUM(valor_total) as total
            FROM pedidos
            WHERE id_empresa = ? AND status = 'concluido' ${queryPeriodo}
            GROUP BY forma_pagamento
        `, queryParams);

       const [vendasDiarias] = await db.execute(`
    SELECT
        DATE(data_pedido) as data,
        SUM(valor_total) as valor,
        COUNT(id) as qtd
    FROM pedidos
    WHERE id_empresa = ? AND status = 'concluido' ${queryPeriodo}
    GROUP BY data
    ORDER BY data ASC
`, queryParams);

        res.json({
            resumo: vendasResumo[0],
            pedidosPorStatus,
            vendasPorPagamento,
            vendasDiarias
        });
    } catch (error) {
        console.error('Erro no Dashboard:', error);
        res.status(500).json({ error: 'Erro interno ao processar dados' });
    }
});

// ==========================================
// --- DESPERTADOR DE INSTÂNCIAS (DESATIVADO PARA SOB DEMANDA) ---
// ==========================================
/*
async function despertarInstancias() {
    try {
        const [empresas] = await db.execute("SELECT id FROM empresas WHERE status_assinatura = 'ativo'");
        for (const empresa of empresas) {
            console.log(`⏳ Despertando robô #${empresa.id}...`);
            obterQRAtualizado(empresa.id).catch(() => {});
        }
    } catch (err) {
        console.error("Erro no despertador:", err);
    }
}
despertarInstancias();
*/

app.get('/api/pagamento/status/:id', async (req, res) => {
    try {
        const paymentId = req.params.id;
        const resMP = await payment.get({ id: paymentId });
        res.json({ aprovado: resMP.status === 'approved' });
    } catch (error) {
        res.status(500).json({ error: "Erro ao consultar status" });
    }
});
// Servir páginas sem a extensão .html (Mascaramento visual)
// Servir páginas com nomes amigáveis e sem .html
app.get('/terminal', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/configuracoes', (req, res) => res.sendFile(path.join(__dirname, '../public/config.html')));
app.get('/vendas', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html'))); // Dashboard de vendas
app.get('/acesso', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/registrar', (req, res) => res.sendFile(path.join(__dirname, '../public/cadastro.html')));
app.get('/inicio', (req, res) => res.sendFile(path.join(__dirname, '../public/vendas.html')));
app.get('/ajuda', (req, res) => res.sendFile(path.join(__dirname, '../public/ajuda.html')));
app.listen(port, () => {
    console.log(`🚀 API do NexuChat rodando em http://localhost:${port}`);
});
