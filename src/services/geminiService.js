require('dotenv').config();

class GeminiService {
    constructor() {
        // Use a chave nova que você criou após apagar as outras
        this.apiKey = process.env.GEMINI_API_KEY;
        // Usando a rota v1beta com o modelo flash estável
        this.url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${this.apiKey}`;
    }

    async gerarResposta(dadosNegocio, perguntaCliente) {
        const payload = {
            contents: [{
                parts: [{
                    text: `Contexto: ${dadosNegocio}\nPergunta: ${perguntaCliente}`
                }]
            }]
        };

        try {
            const response = await fetch(this.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            // Se ainda der erro de quota, ele vai aparecer aqui detalhado
            if (data.error) {
                console.log("Dica técnica: Verifique se sua nova chave já está ativa no Google AI Studio.");
                return `Erro da API: ${data.error.message}`;
            }

            return data.candidates[0].content.parts[0].text;
        } catch (error) {
            return `Erro na requisição: ${error.message}`;
        }
    }
}

module.exports = new GeminiService();