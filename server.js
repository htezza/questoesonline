const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const PORTA = process.env.PORT || 10000;
const SECRET_JWT = "Tezzah917!";

// COLE SUA CHAVE DO GEMINI AQUI:
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELO_GEMINI = "gemini-3.1-flash-lite";

// CONFIGURAÇÃO DO MERCADO PAGO (Cole seu Access Token do MP abaixo)
const mpClient = new MercadoPagoConfig({ accessToken: 'APP_USR-5232629439354822-080414-00c1e350ba8fd72cacb2aafa69f6d94b-109548169' });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));


// Se estiver no Render, usa o diretório do disco persistente (/data). Caso contrário, usa a pasta local.
const dbPath = process.env.RENDER ? '/data/banco.db' : './banco.db';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Erro ao abrir o banco:", err.message);
    else console.log(`Conectado ao banco de dados SQLite em: ${dbPath}`);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        senha TEXT,
        creditos INTEGER DEFAULT 30,
        role TEXT DEFAULT 'user'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS historico (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        acertos INTEGER,
        total INTEGER,
        nota REAL,
        data TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS recuperacao_senha (
        email TEXT,
        token TEXT,
        expiracao INTEGER
    )`);
});

function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ erro: "Token não fornecido." });
    const token = authHeader.split(' ')[1];
    jwt.verify(token, SECRET_JWT, (err, decoded) => {
        if (err) return res.status(403).json({ erro: "Token inválido ou expirado." });
        req.usuarioId = decoded.id;
        next();
    });
}

function verificarAdmin(req, res, next) {
    db.get(`SELECT role FROM usuarios WHERE id = ?`, [req.usuarioId], (err, row) => {
        if (err || !row || row.role !== 'admin') {
            return res.status(403).json({ erro: "Acesso negado. Apenas administradores." });
        }
        next();
    });
}

async function fetchComRetry(url, opciones, maxTentativas = 5) { 
    let tentativa = 0;
    while (tentativa < maxTentativas) {
        tentativa++;
        try {
            const resposta = await fetch(url, opciones);
            if (resposta.ok) return resposta;
            
            if (resposta.status === 429 || resposta.status === 503) {
                if (tentativa >= maxTentativas) {
                    throw new Error(`HTTP ${resposta.status}: Limite de requisições excedido.`);
                }
                let tempoEspera = Math.pow(3, tentativa) * 1000 + (Math.random() * 1500);
                await new Promise(resolve => setTimeout(resolve, tempoEspera));
                continue;
            }
            return resposta; 
        } catch (erro) {
            if (tentativa >= maxTentativas) {
                throw new Error(`Falha de conexão com a IA.`);
            }
            let tempoEspera = Math.pow(3, tentativa) * 1000;
            await new Promise(resolve => setTimeout(resolve, tempoEspera));
        }
    }
}

// ROTA DE PAGAMENTO (MERCADO PAGO)
app.post('/api/criar-pagamento', verificarToken, async (req, res) => {
    let { pacoteId } = req.body;
    let usuarioId = req.usuarioId;

    const pacotes = {
        'pacote_50': { titulo: '50 Créditos - Simulador', quantidade: 50, preco: 9.90 },
        'pacote_200': { titulo: '200 Créditos - Simulador', quantidade: 200, preco: 19.90 },
        'pacote_500': { titulo: '500 Créditos - Simulador', quantidade: 500, preco: 29.90 },
        'pacote_1000': { titulo: '1000 Créditos - Simulador', quantidade: 1000, preco: 49.90 }
    };

    let pacote = pacotes[pacoteId];
    if (!pacote) return res.status(400).json({ erro: "Pacote inválido." });

    try {
        let preference = new Preference(mpClient);
        
        // Garante que a URL utilize https:// obrigatoriamente para o Mercado Pago aceitar
        let hostUrl = 'https://' + req.get('host');

        let respostaMp = await preference.create({
            body: {
                items: [{
                    title: pacote.titulo,
                    quantity: 1,
                    unit_price: Number(pacote.preco)
                }],
                external_reference: `${usuarioId}_${pacote.quantidade}`,
                back_urls: {
                    success: `${hostUrl}/?pagamento=sucesso`,
                    failure: `${hostUrl}/?pagamento=falha`,
                    pending: `${hostUrl}/?pagamento=pendente`
                },
                notification_url: `${hostUrl}/api/webhook/pagamento`,
                auto_return: "approved"
            }
        });

        res.json({ init_point: respostaMp.init_point });
    } catch(e) {
        console.error("Erro detalhado do MP:", e);
        res.status(500).json({ erro: "Erro ao criar preferência de pagamento: " + (e.message || JSON.stringify(e)) });
    }
});

// WEBHOOK DO MERCADO PAGO (Acredita automaticamente)
app.post('/api/webhook/pagamento', async (req, res) => {
    let event = req.body;
    try {
        if (event.type === 'payment' || event.action === 'payment.created' || event.action === 'payment.updated') {
            let paymentId = event.data?.id;
            if (paymentId) {
                let resposta = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                    headers: { 'Authorization': `Bearer ${mpClient.accessToken}` }
                });
                let pagData = await resposta.json();
                
                if (pagData.status === 'approved' && pagData.external_reference) {
                    let partes = pagData.external_reference.split('_');
                    let usuarioId = partes[0];
                    let creditosComprados = Number(partes[1]);

                    db.run(`UPDATE usuarios SET creditos = creditos + ? WHERE id = ?`, [creditosComprados, usuarioId]);
                }
            }
        }
        res.status(200).send("OK");
    } catch(e) {
        res.status(500).send("Erro Webhook");
    }
});

app.post('/api/registrar', async (req, res) => {
    let { email, senha, confirmarSenha } = req.body;
    if (!email || !senha || !confirmarSenha) return res.status(400).json({ erro: "Preencha todos os campos." });
    if (senha !== confirmarSenha) return res.status(400).json({ erro: "As senhas não coincidem." });

    try {
        let senhaHash = await bcrypt.hash(senha, 10);
        db.run(`INSERT INTO usuarios (email, senha, creditos, role) VALUES (?, ?, 30, 'user')`, [email, senhaHash], function(err) {
            if (err) return res.status(400).json({ erro: "E-mail já cadastrado." });
            let token = jwt.sign({ id: this.lastID }, SECRET_JWT, { expiresIn: '7d' });
            res.json({ token, creditos: 30, role: 'user' });
        });
    } catch(e) {
        res.status(500).json({ erro: "Erro ao registrar usuário." });
    }
});

app.post('/api/login', (req, res) => {
    let { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: "Preencha todos os campos." });
    
    db.get(`SELECT * FROM usuarios WHERE email = ?`, [email], async (err, usuario) => {
        if (err || !usuario) return res.status(400).json({ erro: "E-mail ou senha inválidos." });
        let senhaValida = await bcrypt.compare(senha, usuario.senha);
        if (!senhaValida) return res.status(400).json({ erro: "E-mail ou senha inválidos." });
        
        let token = jwt.sign({ id: usuario.id }, SECRET_JWT, { expiresIn: '7d' });
        res.json({ token, creditos: usuario.creditos, role: usuario.role || 'user' });
    });
});

app.post('/api/esqueci-senha', (req, res) => {
    let { email } = req.body;
    if (!email) return res.status(400).json({ erro: "Informe o e-mail." });

    db.get(`SELECT id FROM usuarios WHERE email = ?`, [email], (err, usuario) => {
        if (err || !usuario) {
            return res.json({ mensagem: "Se o e-mail estiver cadastrado, um token foi gerado." });
        }

        let tokenSimulado = Math.floor(100000 + Math.random() * 900000).toString();
        let expiracao = Date.now() + 15 * 60 * 1000;

        db.run(`DELETE FROM recuperacao_senha WHERE email = ?`, [email], () => {
            db.run(`INSERT INTO recuperacao_senha (email, token, expiracao) VALUES (?, ?, ?)`, [email, tokenSimulado, expiracao], (err) => {
                if (err) return res.status(500).json({ erro: "Erro ao gerar token." });
                res.json({ mensagem: "Token gerado com sucesso!", tokenSimuladoParaTeste: tokenSimulado });
            });
        });
    });
});

app.post('/api/redefinir-senha', async (req, res) => {
    let { email, token, novaSenha } = req.body;
    if (!email || !token || !novaSenha) return res.status(400).json({ erro: "Preencha tudo." });

    db.get(`SELECT * FROM recuperacao_senha WHERE email = ? AND token = ?`, [email, token], async (err, registro) => {
        if (err || !registro || Date.now() > registro.expiracao) {
            return res.status(400).json({ erro: "Token inválido ou expirado." });
        }

        try {
            let senhaHash = await bcrypt.hash(novaSenha, 10);
            db.run(`UPDATE usuarios SET senha = ? WHERE email = ?`, [senhaHash, email], (err) => {
                if (err) return res.status(500).json({ erro: "Erro ao atualizar senha." });
                db.run(`DELETE FROM recuperacao_senha WHERE email = ?`, [email]);
                res.json({ mensagem: "Senha alterada com sucesso!" });
            });
        } catch (e) {
            res.status(500).json({ erro: "Erro interno." });
        }
    });
});

app.post('/api/alterar-senha', verificarToken, async (req, res) => {
    let { senhaAtual, novaSenha, confirmarNovaSenha } = req.body;
    if (!senhaAtual || !novaSenha || !confirmarNovaSenha) return res.status(400).json({ erro: "Preencha tudo." });
    if (novaSenha !== confirmarNovaSenha) return res.status(400).json({ erro: "Senhas não conferem." });

    db.get(`SELECT senha FROM usuarios WHERE id = ?`, [req.usuarioId], async (err, usuario) => {
        if (err || !usuario) return res.status(400).json({ erro: "Usuário não encontrado." });
        let senhaValida = await bcrypt.compare(senhaAtual, usuario.senha);
        if (!senhaValida) return res.status(400).json({ erro: "Senha atual incorreta." });

        let senhaHash = await bcrypt.hash(novaSenha, 10);
        db.run(`UPDATE usuarios SET senha = ? WHERE id = ?`, [senhaHash, req.usuarioId], (err) => {
            if (err) return res.status(500).json({ erro: "Erro ao alterar." });
            res.json({ sucesso: true, mensagem: "Senha alterada com sucesso!" });
        });
    });
});

app.get('/api/creditos', verificarToken, (req, res) => {
    db.get(`SELECT creditos, role FROM usuarios WHERE id = ?`, [req.usuarioId], (err, row) => {
        if (err || !row) return res.status(500).json({ erro: "Erro ao buscar créditos." });
        res.json({ creditos: row.creditos, role: row.role || 'user' });
    });
});

app.get('/api/admin/usuarios', verificarToken, verificarAdmin, (req, res) => {
    db.all(`SELECT id, email, creditos, role FROM usuarios`, [], (err, rows) => {
        if (err) return res.status(500).json({ erro: "Erro ao listar." });
        res.json(rows);
    });
});

app.post('/api/admin/creditos', verificarToken, verificarAdmin, (req, res) => {
    let { usuarioId, creditos } = req.body;
    db.run(`UPDATE usuarios SET creditos = ? WHERE id = ?`, [creditos, usuarioId], function(err) {
        if (err) return res.status(500).json({ erro: "Erro ao atualizar." });
        res.json({ sucesso: true });
    });
});

app.get('/api/historico', verificarToken, (req, res) => {
    db.all(`SELECT acertos, total, nota, data FROM historico WHERE usuario_id = ? ORDER BY id ASC`, [req.usuarioId], (err, rows) => {
        if (err) return res.status(500).json({ erro: "Erro ao buscar histórico." });
        res.json(rows);
    });
});

app.post('/api/historico', verificarToken, (req, res) => {
    let { acertos, total, nota } = req.body;
    db.run(`INSERT INTO historico (usuario_id, acertos, total, nota) VALUES (?, ?, ?, ?)`, 
        [req.usuarioId, acertos, total, nota], function(err) {
        if (err) return res.status(500).json({ erro: "Erro ao salvar." });
        res.json({ sucesso: true });
    });
});

app.delete('/api/historico', verificarToken, (req, res) => {
    db.run(`DELETE FROM historico WHERE usuario_id = ?`, [req.usuarioId], function(err) {
        if (err) return res.status(500).json({ erro: "Erro ao limpar." });
        res.json({ sucesso: true });
    });
});

app.post('/api/gerar-questoes', verificarToken, async (req, res) => {
    let { texto, quantidade, nivel } = req.body;
    const usuarioId = req.usuarioId;

    if (!texto || !quantidade || !nivel) return res.status(400).json({ erro: "Parâmetros incompletos." });
    if (quantidade > 50) return res.status(400).json({ erro: "O limite máximo é de 50 questões por gerador." });

    db.get(`SELECT creditos FROM usuarios WHERE id = ?`, [usuarioId], async (err, row) => {
        if (err || !row) return res.status(500).json({ erro: "Erro ao consultar créditos." });
        if (row.creditos < quantidade) {
            return res.status(400).json({ erro: `Créditos insuficientes! Você precisa de ${quantidade}, mas possui ${row.creditos}. Adquira mais créditos na aba correspondente.` });
        }

        try {
            texto = texto.replace(/https?:\/\/[^\s]+/g, '').replace(/["`]/g, "'").replace(/\s+/g, ' ').trim();

            let trechos = [];
            let tamanhoTrecho = 2000;
            if (texto.length <= tamanhoTrecho) {
                trechos.push(texto);
            } else {
                for (let i = 0; i < quantidade; i++) {
                    let maxIndice = texto.length - tamanhoTrecho;
                    let indiceAleatorio = Math.floor(Math.random() * maxIndice);
                    trechos.push(texto.substring(indiceAleatorio, indiceAleatorio + tamanhoTrecho));
                }
            }
            let textoDistribuido = trechos.join("\n\n");

                      
            let prompt = `Atue como uma banca examinadora de alto nível especializada em concursos públicos para carreiras jurídicas e fiscais 
(como Auditor Fiscal, Procurador Municipal/Estadual, Analista Jurídico e Controlador). 
Crie exatamente ${quantidade} questões inéditas e de alto nível de múltipla escolha com base no texto fornecido, 
focando na interpretação rigorosa de leis, jurisprudência, doutrina, legislação tributária, direito administrativo e financeiro.
REGRAS:
1. Nível: ${nivel}.
2. Cada questão DEVE ter 4 alternativas (A, B, C, D).
3. Retorne EXCLUSIVAMENTE um JSON array válido (sem markdown, sem \`\`\`json).
Formato:
[
  {
    "tema": "Nome do tópico jurídico/fiscal",
    "pergunta": "Enunciado complexo e aprofundado...",
    "opcoes": ["A) ...", "B) ...", "C) ...", "D) ..."],
    "resposta": "A",
    "explicacao": "Fundamentação legal ou doutrinária detalhada..."
  }
]
Texto: ${textoDistribuido}`;

            let respostaApi = await fetchComRetry(
                `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
                    })
                }
            );

            if (!respostaApi.ok) throw new Error("A API recusou processar o arquivo.");

            let dados = await respostaApi.json();
            let resultado = dados.candidates[0].content.parts[0].text;
            let inicioJson = resultado.indexOf('[');
            let fimJson = resultado.lastIndexOf(']');
            let questoes = JSON.parse(resultado.substring(inicioJson, fimJson + 1)).slice(0, quantidade);

            db.run(`UPDATE usuarios SET creditos = creditos - ? WHERE id = ?`, [questoes.length, usuarioId]);

            db.get(`SELECT creditos FROM usuarios WHERE id = ?`, [usuarioId], (err, rowAtualizado) => {
                res.json({ sucesso: true, questoes, creditosRestantes: rowAtualizado ? rowAtualizado.creditos : 0 });
            });

        } catch (error) {
            res.status(500).json({ erro: "Erro ao processar: " + error.message });
        }
    });
});


app.listen(PORTA, () => {
    console.log(`Servidor rodando online na porta ${PORTA}`);
});
