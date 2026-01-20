const db = require('../config/database');

class HistoryService {
    async salvarMensagem(idEmpresa, clienteNumero, papel, mensagem) {
        const sql = 'INSERT INTO historico_mensagens (id_empresa, cliente_numero, papel, mensagem) VALUES (?, ?, ?, ?)';
        await db.execute(sql, [
            Number(idEmpresa),
            String(clienteNumero),
            String(papel),
            String(mensagem)
        ]);
    }

    async buscarUltimasMensagens(idEmpresa, clienteNumero, limite = 6) {
        // Mudança crucial: Injetamos o limite como número para evitar erro de Prepared Statement no MySQL 8.0
        const sql = `SELECT papel, mensagem FROM historico_mensagens WHERE id_empresa = ? AND cliente_numero = ? ORDER BY data_envio DESC LIMIT ${Number(limite)}`;

        const [rows] = await db.execute(sql, [
            Number(idEmpresa),
            String(clienteNumero)
        ]);

        return rows.reverse(); 
    }
}

module.exports = new HistoryService();
