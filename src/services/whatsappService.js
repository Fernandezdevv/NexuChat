
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const { processarMensagem } = require('../index');
const db = require('../config/database');
const fs = require('fs');

const instancias = {};
const qrCodesAtivos = {};
const usuariosProcessando = new Set();

/**
 * Inicializa uma nova conexão de WhatsApp para uma empresa específica
 */
async function inicializarInstancia(idEmpresaRaw) {
    const idEmpresa = Number(idEmpresaRaw);
    if (instancias[idEmpresa]) return instancias[idEmpresa];

    console.log(`🚀 Inicializando instância para Empresa ID: ${idEmpresa}`);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `empresa_${idEmpresa}` }),
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1014133453-alpha.html',
        },
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-extensions',
                '--disable-dev-shm-usage',
                '--no-zygote',
                '--disable-gpu',
                '--single-process',
                '--no-first-run',
                '--disable-accelerated-2d-canvas',
                '--disable-session-crashed-bubble'
            ],
        }
    });
    client.options.ackTimeoutMs = 0;

    client.on('qr', (qr) => {
        if (qrCodesAtivos[idEmpresa] !== qr) {
            qrCodesAtivos[idEmpresa] = qr;
            console.log(`✨ [Empresa ${idEmpresa}] Novo QR Code pronto no painel web.`);
        }
    });

    client.on('ready', async () => {
        try {
            console.log(`✅ WhatsApp pronto para Empresa: ${idEmpresa}`);
            delete qrCodesAtivos[idEmpresa];

            // Ajuste crucial: Garantir que o número seja String para o Banco de Dados
            const numeroConectado = client.info.wid.user.toString();
            await db.execute(
                'UPDATE empresas SET whatsapp_numero = ? WHERE id = ?',
                [numeroConectado, idEmpresa]
            );
            console.log(`💾 Número ${numeroConectado} salvo para a empresa ${idEmpresa}`);
        } catch (err) {
            console.error("Erro no Ready/Banco:", err.message);
        }
    });

    let desconectando = false;

    client.on('disconnected', async (reason) => {
        if (desconectando) return;
        desconectando = true;
        console.log(`❌ Empresa ${idEmpresa} desconectada:`, reason);
        delete instancias[idEmpresa];
        delete qrCodesAtivos[idEmpresa];
        try {
            await new Promise(res => setTimeout(res, 3000));
            if (client) {
                client.removeAllListeners();
                await client.destroy().catch(() => {});
            }
        } catch (e) {
            console.log(`ℹ️ Instância ${idEmpresa} limpa.`);
        } finally {
            desconectando = false;
        }
    });

    client.on('message', async (msg) => {

    if (msg.from.includes('@newsletter') || msg.from.includes('@g.us') || msg.from === 'status@broadcast') {
        return; 
    }
    msg.askForPresence = false;
    const chaveProcesso = `${idEmpresa}:${msg.from}`;

    try {
        // 1. FILTROS INSTANTÂNEOS (Não gastam processamento)
        if (msg.fromMe || msg.from.includes('@g.us') || msg.isStatus || !msg.body) return;
        if (usuariosProcessando.has(chaveProcesso)) return;

        // 2. FILTRO DE TEMPO (Mensagens com mais de 20s de atraso são ignoradas)
        const agora = Math.floor(Date.now() / 1000);
        if (agora - msg.timestamp > 20) return;

        // 3. DETECÇÃO DE OUTROS ROBÔS (Filtra saudações comerciais comuns)
        const gatilhosBots = [/bem-vindo/i, /atendimento/i, /direcionando/i, /olá!/i];
        const eOutroBot = gatilhosBots.some(regex => regex.test(msg.body.toLowerCase()));

        if (eOutroBot) {
             try{
            const contato = await msg.getContact();

            // Se parecer robô e NÃO estiver nos contatos do celular, ignore 100%

            if (contato && !contato.isMyContact) {
                console.log(`🤖 [Empresa ${idEmpresa}] Robô de terceiro detectado em ${msg.from}. Ignorando.`);
                return;
            }
        } catch (e){
             console.log("Erro ao verificar contato, ignorando filtro de robo")
         }
       }

        // Se passou em todos os testes, marca como "em processamento"
        usuariosProcessando.add(chaveProcesso);

            const [empresas] = await db.execute('SELECT * FROM empresas WHERE id = ?', [idEmpresa]);
            if (empresas.length === 0) return;

            //const chat = await msg.getChat();
            let respostaIA = await processarMensagem(idEmpresa, msg.from, msg.body);

            if (!respostaIA || respostaIA.includes("Erro da API")) return;

            const eCancelamento = respostaIA.toLowerCase().includes('[pedido_cancelado]');
            const ePedidoFinalizado = respostaIA.toLowerCase().includes('[pedido_finalizado]');

            if (eCancelamento) {
                const numeroLimpo = msg.from.split('@')[0];
                const itemMatch = respostaIA.match(/CANCELAR_ITEM:\s*(.*)/i);
                const servicoParaDeletar = itemMatch ? itemMatch[1].trim() : null;

                if (servicoParaDeletar) {
                    await db.execute(
                        "DELETE FROM pedidos WHERE (cliente_numero = ? OR cliente_numero = ?) AND resumo_pedido LIKE ? AND status = 'pendente' LIMIT 1",
                        [numeroLimpo, msg.from, `%${servicoParaDeletar}%`]
                    );
                } else {
                    await db.execute(
                        "DELETE FROM pedidos WHERE (cliente_numero = ? OR cliente_numero = ?) AND status = 'pendente' ORDER BY id DESC LIMIT 1",
                        [numeroLimpo, msg.from]
                    );
                }
            }

            let respostaLimpa = respostaIA.replace(/\[PEDIDO_FINALIZADO\]|\[PEDIDO_CANCELADO\]|ITEM:.*|CANCELAR_ITEM:.*/gi, '').trim();
            let partes = respostaLimpa.split('\n\n').filter(p => p.trim().length > 1);
            if (partes.length === 1) partes = respostaLimpa.split('\n').filter(p => p.trim().length > 1);

           for (const parte of partes) {
                 if (!instancias[idEmpresa]) break;

                 await new Promise(res => setTimeout(res, 2000));

               try {
                  // Usamos o ID da mensagem para responder de forma mais "bruta"
                  // Isso evita que a biblioteca tente carregar o chat completo
                  await client.sendMessage(msg.from, parte.trim(), { 
                      sendSeen: false // DESATIVA O CHECK AZUL QUE ESTÁ DANDO ERRO
                  });
                  console.log(`✅ [SUCESSO] Enviado para ${msg.from}`);
             } catch (e) {
                  console.error(`❌ Erro no envio: ${e.message}`);
               }
             }

            if (ePedidoFinalizado && !eCancelamento) {
                try {
                    const regexItens = /ITEM:\s*(.*?)\s*\|\s*VALOR:\s*R\$\s*(\d+(?:[.,]\d{2})?)/gi;
                    let match;
                    let registrosCriados = 0;

                    while ((match = regexItens.exec(respostaIA)) !== null) {
                        const nomeServico = match[1].trim();
                        const valorServico = parseFloat(match[2].replace(',', '.'));
                        const [ultimo] = await db.execute('SELECT MAX(numero_pedido_loja) as u FROM pedidos WHERE id_empresa = ? AND DATE(data_pedido) = CURDATE()', [idEmpresa]);

                        await db.execute(
                            `INSERT INTO pedidos (id_empresa, numero_pedido_loja, cliente_numero, resumo_pedido, valor_total, forma_pagamento, status)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [idEmpresa, (ultimo[0].u || 0) + 1, msg.from, nomeServico, valorServico, 'A combinar', 'pendente']
                        );
                        registrosCriados++;
                    }

                    if (registrosCriados === 0) {
                        const extrairValorTotal = (t) => {
                            const r = /TOTAL:\s*R\$\s*(\d+(?:[.,]\d{2})?)/i;
                            const m = t.match(r);
                            return m ? parseFloat(m[1].replace(',', '.')) : 0.00;
                        };
                        const vTotal = extrairValorTotal(respostaIA);
                        const [ultimo] = await db.execute('SELECT MAX(numero_pedido_loja) as u FROM pedidos WHERE id_empresa = ?', [idEmpresa]);
                        await db.execute(
                            `INSERT INTO pedidos (id_empresa, numero_pedido_loja, cliente_numero, resumo_pedido, valor_total, forma_pagamento, status)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [idEmpresa, (ultimo[0].u || 0) + 1, msg.from, respostaLimpa, vTotal, 'A combinar', 'pendente']
                        );
                    }
                } catch (dbErr) {
                    console.error("Erro ao salvar pedido:", dbErr.message);
                }
            }
        } catch (err) {
            console.error(`Erro Empresa ${idEmpresa}:`, err);
        } finally {
            usuariosProcessando.delete(chaveProcesso);
        }
    });

    client.initialize().catch(err => {
        console.error(`Erro ao inicializar empresa ${idEmpresa}:`, err.message);
        delete instancias[idEmpresa];
    });

    instancias[idEmpresa] = client;
    return client;
}

module.exports = {
    getQR: (idEmpresa) => qrCodesAtivos[Number(idEmpresa)] || null,

    obterQRAtualizado: async (idEmpresaRaw) => {
        const idEmpresa = Number(idEmpresaRaw);
        const [empresa] = await db.execute('SELECT whatsapp_numero FROM empresas WHERE id = ?', [idEmpresa]);

        if (empresa[0]?.whatsapp_numero && instancias[idEmpresa] && instancias[idEmpresa].info) {
            return "CONECTADO";
        }

        if (!instancias[idEmpresa]) {
            console.log(`🎯 Gatilho de inicialização ativado para Empresa: ${idEmpresa}`);
            inicializarInstancia(idEmpresa);
            return "INICIALIZANDO";
        }

        return qrCodesAtivos[idEmpresa] || "AGUARDANDO_GERACAO";
    },

    encerrarSessao: async (idEmpresaRaw) => {
        const idEmpresa = Number(idEmpresaRaw);
        if (instancias[idEmpresa]) {
            try {
                console.log(`⏳ Encerrando processo da Empresa ${idEmpresa}...`);
                instancias[idEmpresa].removeAllListeners();
                await instancias[idEmpresa].destroy().catch(() => {});
            } finally {
                delete instancias[idEmpresa];
                delete qrCodesAtivos[idEmpresa];
                console.log(`📴 Recursos da Empresa ${idEmpresa} liberados.`);
            }
        }
    }
};
