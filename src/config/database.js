const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS, // Ajustado para ler DB_PASS do seu .env
    database: process.env.DB_NAME || 'nexuschat',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Teste de conexão
pool.getConnection()
    .then(conn => {
        console.log("✅ BANCO DE DADOS CONECTADO: " + process.env.DB_NAME);
        conn.release();
    })
    .catch(err => {
        console.error("❌ ERRO NO BANCO (Verifique DB_PASS):", err.message);
    });

module.exports = pool;
