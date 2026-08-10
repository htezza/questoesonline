const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// Limite para rotas de autenticação (evita força bruta no login/registro)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10, // Limite de 10 tentativas por IP
    message: { erro: 'Muitas tentativas de login ou cadastro. Tente novamente mais tarde.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Limite para a geração de IA (evita esgotar a cota da API do Gemini)
const iaLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutos
    max: 20, // Limite de 20 requisições por IP
    message: { erro: 'Muitas requisições de IA em pouco tempo. Aguarde alguns minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});
const PORTA = process.env.PORT || 10000;

const SECRET_JWT = process.env.SECRET_JWT;
if (!SECRET_JWT) {
    console.error("ERRO CRÍTICO: A variável de ambiente SECRET_JWT não está definida.");
    process.exit(1);
}

const emProcessamento = new Set(); // Lista para controlar quem está gerando questões no momento

// COLE SUA CHAVE DO GEMINI AQUI:
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELO_GEMINI = "gemini-3.1-flash-lite";

// CONFIGURAÇÃO DO MERCADO PAGO (Cole seu Access Token do MP abaixo)
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

const META_CAPI_ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const META_PIXEL_ID = '1548997376693347';

if (!MP_ACCESS_TOKEN) {
    console.error("ERRO CRÍTICO: A variável de ambiente MP_ACCESS_TOKEN não está definida.");
    process.exit(1);
}

const mpClient = new MercadoPagoConfig({
    accessToken: MP_ACCESS_TOKEN
});
// ===============================
// META CONVERSIONS API - PURCHASE
// ===============================
async function enviarPurchaseMeta({ paymentId, email, valor }) {
    if (!META_CAPI_ACCESS_TOKEN) {
        console.error("META_CAPI_ACCESS_TOKEN não está configurado.");
        return;
    }

    try {
        const emailNormalizado = String(email || '').trim().toLowerCase();

        const emailHash = emailNormalizado
            ? crypto.createHash('sha256')
                .update(emailNormalizado)
                .digest('hex')
            : null;

        const userData = {};

        if (emailHash) {
            userData.em = [emailHash];
        }

        const evento = {
            event_name: "Purchase",
            event_time: Math.floor(Date.now() / 1000),
            event_id: `mp_${paymentId}`,
            event_source_url: "https://questoesonline.onrender.com/",
            action_source: "website",
            user_data: userData,
            custom_data: {
                currency: "BRL",
                value: Number(valor),
                order_id: String(paymentId)
            }
        };

        const respostaMeta = await fetch(
            `https://graph.facebook.com/v23.0/${META_PIXEL_ID}/events`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    data: [evento],
                    access_token: META_CAPI_ACCESS_TOKEN
                })
            }
        );

        const resultadoMeta = await respostaMeta.json();

        if (!respostaMeta.ok) {
            console.error(
                "Erro ao enviar Purchase para a Meta:",
                resultadoMeta
            );
            return;
        }

        console.log(
            `Purchase enviado para a Meta. Payment ID: ${paymentId}`,
            resultadoMeta
        );

    } catch (erro) {
        // O erro da Meta não pode desfazer uma compra já aprovada.
        console.error(
            "Erro na Conversions API da Meta:",
            erro.message || erro
        );
    }
}

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
        role TEXT DEFAULT 'user',
        cpf TEXT
    )`);

    // Atualização silenciosa para caso o banco já exista sem a coluna cpf
    db.run(`ALTER TABLE usuarios ADD COLUMN cpf TEXT`, (err) => {
        // O erro é ignorado caso a coluna já exista
    });

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

    // --- NOVAS TABELAS DE GESTÃO E MÉTRICAS (Invisível para o usuário) ---
    db.run(`CREATE TABLE IF NOT EXISTS compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    quantidade INTEGER,
    valor REAL,
    payment_id TEXT,
    data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Adiciona a coluna payment_id caso o banco já exista
db.run(`ALTER TABLE compras ADD COLUMN payment_id TEXT`, (err) => {
    // Ignora o erro caso a coluna já exista
});

// Garante que o mesmo pagamento do Mercado Pago
// nunca seja registrado duas vezes
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_compras_payment_id
        ON compras(payment_id)`);

    db.run(`CREATE TABLE IF NOT EXISTS geracoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        quantidade INTEGER,
        is_pago INTEGER DEFAULT 0,
        data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT
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
    let { pacoteId, cpf } = req.body;
    let usuarioId = req.usuarioId;

    const pacotes = {
        'pacote_50': { titulo: '50 Créditos - Simulador', quantidade: 50, preco: 9.90 },
        'pacote_200': { titulo: '200 Créditos - Simulador', quantidade: 200, preco: 19.90 },
        'pacote_500': { titulo: '500 Créditos - Simulador', quantidade: 500, preco: 29.90 },
        'pacote_1000': { titulo: '1000 Créditos - Simulador', quantidade: 1000, preco: 49.90 }
    };

    let pacote = pacotes[pacoteId];
    if (!pacote) return res.status(400).json({ erro: "Pacote inválido." });

    db.get(`SELECT cpf, email FROM usuarios WHERE id = ?`, [usuarioId], async (err, row) => {
    
        if (err) return res.status(500).json({ erro: "Erro ao verificar usuário." });

        let userCpf = row?.cpf || cpf;
        if (!userCpf) {
            return res.status(400).json({ erro: "CPF é obrigatório para realizar a compra." });
        }

        // Se informou o CPF agora e não tinha no banco, nós salvamos
        if (cpf && !row?.cpf) {
            db.run(`UPDATE usuarios SET cpf = ? WHERE id = ?`, [cpf, usuarioId]);
        }

        try {
            let preference = new Preference(mpClient);
            let hostUrl = 'https://' + req.get('host');

            let respostaMp = await preference.create({
                body: {
                    items: [{
                        title: pacote.titulo,
                        quantity: 1,
                        unit_price: Number(pacote.preco)
                    }],
                    payer: {
    email: row?.email,
    identification: {
        type: "CPF",
        number: userCpf.replace(/\D/g, '')
    }
},
                    // AQUI EMBUTIMOS O PREÇO PARA REGISTRO INTERNO NO WEBHOOK SEM ALTERAR O FUNCIONAMENTO
                    external_reference: `${usuarioId}_${pacote.quantidade}_${pacote.preco}`,
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
});

// WEBHOOK DO MERCADO PAGO
// WEBHOOK DO MERCADO PAGO
app.post('/api/webhook/pagamento', async (req, res) => {
    let event = req.body;

    try {
        if (event.type === 'payment' || event.action === 'payment.created' || event.action === 'payment.updated') {

            let paymentId = event.data?.id;

            if (paymentId) {

                let resposta = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                    headers: {
                        'Authorization': `Bearer ${mpClient.accessToken}`
                    }
                });

                let pagData = await resposta.json();

                if (pagData.status === 'approved' && pagData.external_reference) {

                    let partes = pagData.external_reference.split('_');

                    let usuarioId = partes[0];
                    let creditosComprados = Number(partes[1]);
                    let valorPago = Number(partes[2]) || 0;

                    // Usa uma transação para garantir que o pagamento
                    // e a liberação dos créditos aconteçam juntos.
                    db.run(`BEGIN IMMEDIATE TRANSACTION`, (err) => {

                        if (err) {
                            console.error("Erro ao iniciar transação do pagamento:", err);
                            return;
                        }

                        // Tenta registrar o pagamento.
                        // O índice UNIQUE impede que o mesmo payment_id
                        // seja processado novamente.
                        db.run(
                            `INSERT INTO compras
                            (usuario_id, quantidade, valor, payment_id)
                            VALUES (?, ?, ?, ?)`,
                            [
                                usuarioId,
                                creditosComprados,
                                valorPago,
                                String(paymentId)
                            ],
                            function(err) {

                                if (err) {

                                    // Se for pagamento duplicado, simplesmente
                                    // ignora sem adicionar créditos novamente.
                                    if (err.message.includes('UNIQUE constraint failed')) {

                                        console.log(
                                            `Pagamento ${paymentId} já processado. Nenhum crédito adicional foi concedido.`
                                        );

                                        db.run(`ROLLBACK`, () => {});
                                        return;
                                    }

                                    console.error(
                                        "Erro ao registrar pagamento:",
                                        err
                                    );

                                    db.run(`ROLLBACK`, () => {});
                                    return;
                                }

                                // Só adiciona os créditos depois que o pagamento
                                // foi registrado com sucesso.
                                db.run(
                                    `UPDATE usuarios
                                     SET creditos = creditos + ?
                                     WHERE id = ?`,
                                    [
                                        creditosComprados,
                                        usuarioId
                                    ],
                                    function(err) {

                                        if (err) {

                                            console.error(
                                                "Erro ao adicionar créditos:",
                                                err
                                            );

                                            db.run(`ROLLBACK`, () => {});
                                            return;
                                        }

                                        // Finaliza a transação
                                        db.run(`COMMIT`, async (err) => {

    if (err) {

        console.error(
            "Erro ao confirmar transação:",
            err
        );

        db.run(`ROLLBACK`, () => {});
        return;
    }

    console.log(
        `Pagamento ${paymentId} aprovado. ` +
        `${creditosComprados} créditos adicionados ao usuário ${usuarioId}.`
    );

    // Envia Purchase para a Meta somente depois
    // que o pagamento foi confirmado e a transação foi concluída.
    try {

        db.get(
            `SELECT email FROM usuarios WHERE id = ?`,
            [usuarioId],
            async (emailErr, usuario) => {

                if (emailErr) {
                    console.error(
                        "Erro ao buscar e-mail para a Meta:",
                        emailErr
                    );
                    return;
                }

                await enviarPurchaseMeta({
                    paymentId: paymentId,
                    email: usuario?.email,
                    valor: valorPago
                });

            }
        );

    } catch (erroMeta) {

        console.error(
            "Erro ao preparar Purchase da Meta:",
            erroMeta
        );

    }
});
                                    }
                                );
                            }
                        );
                    });
                }
            }
        }

        res.status(200).send("OK");

    } catch(e) {

        console.error(
            "Erro no Webhook do Mercado Pago:",
            e
        );

        res.status(500).send("Erro Webhook");
    }
});

app.post('/api/registrar', authLimiter, async (req, res) => {
    let { email, senha, confirmarSenha } = req.body;
    if (!email || !senha || !confirmarSenha) return res.status(400).json({ erro: "Preencha todos os campos." });
    if (senha !== confirmarSenha) return res.status(400).json({ erro: "As senhas não coincidem." });

    try {
        let senhaHash = await bcrypt.hash(senha, 10);
        db.run(`INSERT INTO usuarios (email, senha, creditos, role) VALUES (?, ?, 30, 'user')`, [email, senhaHash], function(err) {
            if (err) return res.status(400).json({ erro: "E-mail já cadastrado." });
            let token = jwt.sign({ id: this.lastID }, SECRET_JWT, { expiresIn: '7d' });
            res.json({ token, creditos: 30, role: 'user', temCpf: false });
        });
    } catch(e) {
        res.status(500).json({ erro: "Erro ao registrar usuário." });
    }
});

app.post('/api/login', authLimiter, (req, res) => {
    let { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: "Preencha todos os campos." });
    
    db.get(`SELECT * FROM usuarios WHERE email = ?`, [email], async (err, usuario) => {
        if (err || !usuario) return res.status(400).json({ erro: "E-mail ou senha inválidos." });
        let senhaValida = await bcrypt.compare(senha, usuario.senha);
        if (!senhaValida) return res.status(400).json({ erro: "E-mail ou senha inválidos." });
        
        let token = jwt.sign({ id: usuario.id }, SECRET_JWT, { expiresIn: '7d' });
        res.json({ token, creditos: usuario.creditos, role: usuario.role || 'user', temCpf: !!usuario.cpf });
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
    db.get(`SELECT creditos, role, cpf FROM usuarios WHERE id = ?`, [req.usuarioId], (err, row) => {
        if (err || !row) return res.status(500).json({ erro: "Erro ao buscar créditos." });
        res.json({ creditos: row.creditos, role: row.role || 'user', temCpf: !!row.cpf });
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

// === NOVO ENDPOINT DE ESTATÍSTICAS PARA O DASHBOARD ADMIN ===
app.get('/api/admin/estatisticas', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const getQuery = (query, params = []) => new Promise((resolve, reject) => {
            db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
        });
        
        let usuarios_cadastrados = (await getQuery(`SELECT COUNT(*) as c FROM usuarios`)).c || 0;
        let usuarios_ativos = (await getQuery(`SELECT COUNT(DISTINCT usuario_id) as c FROM geracoes WHERE data >= datetime('now', '-2 months')`)).c || 0;
        let pdfs_enviados = (await getQuery(`SELECT COUNT(*) as c FROM geracoes`)).c || 0;
        
        let q_gratis = (await getQuery(`SELECT SUM(quantidade) as c FROM geracoes WHERE is_pago = 0`)).c || 0;
        let q_pagas = (await getQuery(`SELECT SUM(quantidade) as c FROM geracoes WHERE is_pago = 1`)).c || 0;
        
        let comprasStats = await getQuery(`SELECT SUM(quantidade) as total_creditos, SUM(valor) as faturamento, COUNT(DISTINCT usuario_id) as compradores FROM compras`);
        let faturamento = comprasStats.faturamento || 0;
        let creditos_vendidos = comprasStats.total_creditos || 0;
        let compradores = comprasStats.compradores || 0;

        // Buscar investimento e calcular CAC corretamente
        let invRow = await getQuery(`SELECT valor FROM configuracoes WHERE chave = 'investimento_marketing'`);
        let investimentoMarketing = invRow ? Number(invRow.valor) : 0;
        let total_questoes = q_gratis + q_pagas;
        let custo_ia = total_questoes * 0.001; 
        let investimentoTotal = Number(investimentoMarketing) || 0;
        let cac = usuarios_cadastrados > 0 ? ((investimentoTotal + custo_ia) / usuarios_cadastrados) : 0;

        let ticket_medio = compradores > 0 ? (faturamento / compradores) : 0;
        let pct_compraram = usuarios_cadastrados > 0 ? ((compradores / usuarios_cadastrados) * 100) : 0;

        let rebuyStats = await getQuery(`SELECT COUNT(*) as c FROM (SELECT usuario_id FROM compras GROUP BY usuario_id HAVING COUNT(*) > 1)`);
        let compraram_novamente = rebuyStats.c || 0;

       
        
        let lucro_liquido = faturamento - custo_ia - investimentoTotal;
        let ltvQuery = await getQuery(`
            SELECT AVG(total_gasto) as ltv_medio FROM (
                SELECT SUM(valor) as total_gasto 
                FROM compras 
                GROUP BY usuario_id
            )
        `);
        let ltv = ltvQuery && ltvQuery.ltv_medio ? ltvQuery.ltv_medio : 0;

        res.json({
            usuarios_cadastrados,
            usuarios_ativos,
            pdfs_enviados,
            questoes_gratuitas_geradas: q_gratis,
            questoes_pagas_geradas: q_pagas,
            creditos_vendidos,
            faturamento,
            ticket_medio,
            pct_compraram,
            compraram_novamente,
            custo_ia,
            cac,
            ltv,
            lucro_liquido
        });
    } catch (error) {
        res.status(500).json({ erro: "Erro interno de métricas: " + error.message });
    }
});

app.post('/api/admin/investimento', verificarToken, verificarAdmin, (req, res) => {
    let { investimento } = req.body;
    db.run(`INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES ('investimento_marketing', ?)`, [investimento], (err) => {
        if (err) return res.status(500).json({ erro: "Erro ao salvar investimento." });
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

app.post('/api/gerar-questoes', verificarToken, iaLimiter, async (req, res) => {
    let { texto, quantidade, nivel } = req.body;
    const usuarioId = req.usuarioId;

    if (emProcessamento.has(usuarioId)) {
        return res.status(429).json({ erro: "Você já possui uma geração de questões em andamento. Aguarde terminar." });
    }
    emProcessamento.add(usuarioId);

    if (!texto || !quantidade || !nivel) {
        emProcessamento.delete(usuarioId);
        return res.status(400).json({ erro: "Parâmetros incompletos." });
    }
    if (quantidade > 50) {
        emProcessamento.delete(usuarioId);
        return res.status(400).json({ erro: "O limite máximo é de 50 questões por gerador." });
    }

    db.get(`SELECT creditos FROM usuarios WHERE id = ?`, [usuarioId], async (err, row) => {
        if (err || !row) {
            emProcessamento.delete(usuarioId);
            return res.status(500).json({ erro: "Erro ao consultar créditos." });
        }
        if (row.creditos < quantidade) {
            emProcessamento.delete(usuarioId);
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
                        generationConfig: { 
                            temperature: 0.5,
                            responseMimeType: "application/json",
                            responseSchema: {
                                type: "ARRAY",
                                description: "Lista de questões geradas",
                                items: {
                                    type: "OBJECT",
                                    properties: {
                                        tema: { type: "STRING" },
                                        pergunta: { type: "STRING" },
                                        opcoes: {
                                            type: "ARRAY",
                                            items: { type: "STRING" }
                                        },
                                        resposta: { type: "STRING" },
                                        explicacao: { type: "STRING" }
                                    },
                                    required: ["tema", "pergunta", "opcoes", "resposta", "explicacao"]
                                }
                            }
                        }
                    })
                }
            );

            if (!respostaApi.ok) throw new Error("A API recusou processar o arquivo.");

            let dados = await respostaApi.json();
            if (!dados.candidates || !dados.candidates[0]?.content?.parts[0]?.text) {
                throw new Error("A IA retornou uma estrutura vazia.");
            }

            let questoes = JSON.parse(dados.candidates[0].content.parts[0].text);
            questoes = questoes.slice(0, quantidade);

            // TIRA OS CRÉDITOS DO USUÁRIO
            db.run(`UPDATE usuarios SET creditos = creditos - ? WHERE id = ?`, [questoes.length, usuarioId], () => {
                
                // REGISTRA A GERAÇÃO DE FORMA OCULTA PARA O DASHBOARD
                db.get(`SELECT COUNT(id) as c FROM compras WHERE usuario_id = ?`, [usuarioId], (err, resCompras) => {
                    let isPago = (resCompras && resCompras.c > 0) ? 1 : 0;
                    db.run(`INSERT INTO geracoes (usuario_id, quantidade, is_pago) VALUES (?, ?, ?)`, [usuarioId, questoes.length, isPago]);
                    
                    db.get(`SELECT creditos FROM usuarios WHERE id = ?`, [usuarioId], (err, rowAtualizado) => {
                        res.json({ sucesso: true, questoes, creditosRestantes: rowAtualizado ? rowAtualizado.creditos : 0 });
                    });
                });
            });

        } catch (error) {
            res.status(500).json({ erro: "Erro ao processar: " + error.message });
        } finally {
            emProcessamento.delete(usuarioId);
        }
    });
});


app.listen(PORTA, () => {
    console.log(`Servidor rodando online na porta ${PORTA}`);
});
