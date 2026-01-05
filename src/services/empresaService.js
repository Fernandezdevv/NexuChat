const db = require('../config/database');

class EmpresaService {
    async buscarPorNumeroWhatsApp(numeroBot) {
        // O numeroBot é o seu número que está rodando o sistema
        const [rows] = await db.execute(
            'SELECT * FROM empresas WHERE whatsapp_numero = ?', 
            [numeroBot]
        );
        return rows[0]; // Retorna a empresa encontrada
    }
}

module.exports = new EmpresaService();