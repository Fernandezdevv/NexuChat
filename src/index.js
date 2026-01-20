const geminiService = require('./services/geminiService');
const historyService = require('./services/historyService');
const db = require('./config/database');

async function processarMensagem(idEmpresa, numeroCliente, pergunta) {
    console.log(`\n--- [Empresa ID: ${idEmpresa}] Mensagem de: ${numeroCliente} ---`);

    try {
        const [empresas] = await db.execute('SELECT * FROM empresas WHERE id = ?', [Number(idEmpresa)]);
        if (empresas.length === 0) return "Desculpe, empresa não cadastrada.";
        
        const empresa = empresas[0];
        const dadosEmpresa = empresa.dados_conhecimento;
        const personalidadeDono = empresa.personalidade || 'um atendente prestativo e profissional.';

        // --- BUSCA AGENDAMENTOS ATIVOS PARA EVITAR CONFLITOS (MEMÓRIA DO SISTEMA) ---
       const [pedidosAtivos] = await db.execute(
    "SELECT resumo_pedido FROM pedidos WHERE id_empresa = ? AND status = 'pendente' AND DATE(data_pedido) >= CURDATE()",
    [Number(idEmpresa)] // Garanta que é número
);
        const listaAgendamentos = pedidosAtivos.map(p => `- ${p.resumo_pedido}`).join('\n') || "Nenhum horário ocupado hoje.";

        const historicoRaw = await historyService.buscarUltimasMensagens(idEmpresa, numeroCliente);
        const formatarHistorico = historicoRaw.map(h => `${h.papel === 'user' ? 'Cliente' : 'Atendente'}: ${h.mensagem}`).join('\n');

        await historyService.salvarMensagem(Number(idEmpresa), String(numeroCliente), 'user', String(pergunta));

        const agora = new Date();
        const dataHoraAtual = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

        const promptFinal = `
Você é o atendente virtual humano e profissional da empresa ${empresa.nome_negocio}.
HORA ATUAL DO SISTEMA: ${dataHoraAtual}

### AGENDA ATUAL (OCUPADOS NO SISTEMA) ###
${listaAgendamentos}

PERSONALIDADE CONFIGURADA:
${personalidadeDono}

BASE DE CONHECIMENTO (CARDÁPIO E REGRAS):
${dadosEmpresa}

HISTÓRICO DA CONVERSA:
${formatarHistorico}

DIRETRIZES DE FLUXO (3 ETAPAS OBRIGATÓRIAS - NÃO PULE):
1. DESCOBRIR O SERVIÇO: Identifique o desejo do cliente e pergunte o nome no início.
2. LOGÍSTICA: 
   - Se for DELIVERY: Descubra o endereço completo da entrega.
   - Se for AGENDAMENTO: Pergunte o dia/horário e valide se não conflita com a "AGENDA ATUAL" acima.
3. PAGAMENTO: Pergunte a forma de pagamento (PIX, Cartão ou Dinheiro).

REGRAS TÉCNICAS DE TAGS (SISTEMA NEXUSCHAT):
- VERIFICAÇÃO DE NICHO: Observe as "ESPECIFICAÇÕES" na base de conhecimento.
  1. Se contiver a palavra "agendamento": No fechamento, você DEVE listar cada serviço individualmente por linha usando a tag ITEM:
     ITEM: [Nome do Serviço + Horário] | VALOR: R$ 00,00
  2. Se NÃO contiver "agendamento" (Hamburgueria/Pizzaria): No fechamento, você DEVE agrupar tudo em um resumo e usar apenas a tag TOTAL:
     TOTAL: R$ 00,00

- GATILHO DE FECHAMENTO (CRÍTICO): Você está PROIBIDO de enviar as tags [PEDIDO_FINALIZADO], "ITEM:" ou "TOTAL:" nos Passos 1 e 2. Elas só podem ser enviadas APÓS a confirmação do pagamento no Passo 3.

- FORMATO DE SAÍDA (APENAS NO PASSO 3):
Agradeça, confirme que o pagamento será feito via [Forma escolhida] e anexe o bloco técnico:
(Exemplo Agendamento):
ITEM: Serviço A (Data/Hora) | VALOR: R$ 00,00
ITEM: Serviço B (Data/Hora) | VALOR: R$ 00,00
[PEDIDO_FINALIZADO]

(Exemplo Delivery):
Resumo: 1x Burger X, 1x Coca-Cola. Endereço: Rua X, 123.
TOTAL: R$ 00,00
[PEDIDO_FINALIZADO]

- CANCELAMENTO: 
  - Se cancelar um item individual (Agendamento), use: CANCELAR_ITEM: [Nome exato do item] [PEDIDO_CANCELADO].
  - Se cancelar o pedido inteiro (Delivery), use apenas: [PEDIDO_CANCELADO].

REGRAS DE FORMATAÇÃO:
1. MINIMALISMO: Use no máximo 2 frases curtas por balão de mensagem.
2. VALORES: Sempre use o formato "R$ 00,00".
3. SEPARAÇÃO: No agendamento, nunca agrupe serviços em uma única linha ITEM. Cada serviço = um card no painel.

PERGUNTA ATUAL DO CLIENTE: ${pergunta}
RESPOSTA HUMANA, CURTA E DIRETA:`;

        const respostaIA = await geminiService.gerarResposta(dadosEmpresa, promptFinal);

        // 6. Salva resposta da IA (Blindado com Number e String)
        if (respostaIA) {
            await historyService.salvarMensagem(Number(idEmpresa), String(numeroCliente), 'model', String(respostaIA));
        }

        console.log(`IA [Empresa ${idEmpresa}]:`, respostaIA);
        return respostaIA; 

    } catch (error) {
        console.error("ERRO TÉCNICO NO INDEX:", error.message);
        return "Tive um problema técnico, mas já estou de volta! Pode repetir?";
    }

}
module.exports = { processarMensagem };
