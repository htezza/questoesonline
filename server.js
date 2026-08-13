const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const { GoogleAuth } = require('google-auth-library');
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
async function enviarPurchaseMeta({ paymentId, email, valor, fbp, fbc }) {
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

        // Identificadores de atribuição da Meta
        if (fbp) {
            userData.fbp = fbp;
        }

        if (fbc) {
            userData.fbc = fbc;
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
// ===============================
// GOOGLE ADS - DATA MANAGER API
// ===============================

const GOOGLE_SERVICE_ACCOUNT_FILE =
    '/etc/secrets/google-service-account.json';

const GOOGLE_ADS_CUSTOMER_ID = '3452253646';
const GOOGLE_ADS_CONVERSION_ACTION_ID = '7715948072';

const googleAuth = new GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/datamanager']
});

async function enviarConversaoGoogleAds({
    paymentId,
    valor,
    gclid,
    gbraid,
    wbraid,
    eventTimestamp
}) {
    console.log('===== GOOGLE ADS - INÍCIO =====');
    console.log('Payment ID:', paymentId);
    console.log('GCLID:', gclid);
    console.log('GBRAID:', gbraid);
    console.log('WBRAID:', wbraid);

    if (!gclid && !gbraid && !wbraid) {
        console.log(
            `Compra ${paymentId} sem GCLID/GBRAID/WBRAID. ` +
            `Conversão não enviada ao Google Ads.`
        );
        return;
    }

    try {
        const client = await googleAuth.getClient();
console.log('Google Ads: autenticação obtida.');

const tokenResponse = await client.getAccessToken();
const accessToken = tokenResponse?.token || tokenResponse;

console.log(
    'Google Ads: token obtido:',
    accessToken ? 'SIM' : 'NÃO'
);

        const adIdentifiers = {};

        if (gclid) adIdentifiers.gclid = gclid;
        if (gbraid) adIdentifiers.gbraid = gbraid;
        if (wbraid) adIdentifiers.wbraid = wbraid;

        const corpo = {
            destinations: [
                {
                    reference: 'compra_google_ads',
                    operatingAccount: {
                        accountType: 'GOOGLE_ADS',
                        accountId: GOOGLE_ADS_CUSTOMER_ID
                    },
                    productDestinationId:
                        GOOGLE_ADS_CONVERSION_ACTION_ID
                }
            ],

            events: [
                {
                    destinationReferences: [
                        'compra_google_ads'
                    ],

                    transactionId: String(paymentId),

                    eventTimestamp:
                        eventTimestamp || new Date().toISOString(),

                    adIdentifiers,

                    currency: 'BRL',

                    conversionValue: Number(valor) || 0,

                    eventSource: 'WEB'
                }
            ]
        };

        const respostaGoogle = await fetch(
            'https://datamanager.googleapis.com/v1/events:ingest',
            {
                method: 'POST',

                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },

                body: JSON.stringify(corpo)
            }
        );

        const resultadoGoogle = await respostaGoogle.json();

        if (!respostaGoogle.ok) {
            console.error(
                'Erro ao enviar conversão para o Google Ads:',
                resultadoGoogle
            );
            return;
        }

        console.log(
            `Compra enviada ao Google Ads. Payment ID: ${paymentId}`
        );

    } catch (erro) {
        console.error(
            'Erro na Data Manager API do Google Ads:',
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
    cpf TEXT,
    origem TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    gclid TEXT,
    gbraid TEXT,
    wbraid TEXT,
    visitor_id TEXT
)`);

    // Atualização silenciosa para caso o banco já exista sem a coluna cpf
    db.run(`ALTER TABLE usuarios ADD COLUMN cpf TEXT`, (err) => {
        // O erro é ignorado caso a coluna já exista
    });

    // ============================================================
// ATRIBUIÇÃO DE ORIGEM DOS CADASTROS
// Compatibilidade com bancos já existentes
// ============================================================

db.run(`ALTER TABLE usuarios ADD COLUMN origem TEXT`, () => {});
db.run(`ALTER TABLE usuarios ADD COLUMN utm_source TEXT`, () => {});
db.run(`ALTER TABLE usuarios ADD COLUMN utm_medium TEXT`, () => {});
db.run(`ALTER TABLE usuarios ADD COLUMN utm_campaign TEXT`, () => {});
db.run(`ALTER TABLE usuarios ADD COLUMN gclid TEXT`, () => {});
db.run(`ALTER TABLE usuarios ADD COLUMN gbraid TEXT`, () => {});
db.run(`ALTER TABLE usuarios ADD COLUMN wbraid TEXT`, () => {});
db.run(`ALTER TABLE usuarios ADD COLUMN visitor_id TEXT`, () => {});

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
    gclid TEXT,
    gbraid TEXT,
    wbraid TEXT,
    data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Adiciona a coluna payment_id caso o banco já exista
db.run(`ALTER TABLE compras ADD COLUMN payment_id TEXT`, (err) => {
    // Ignora o erro caso a coluna já exista
});

    db.run(`ALTER TABLE compras ADD COLUMN gclid TEXT`, (err) => {
    // Ignora o erro caso a coluna já exista
});

db.run(`ALTER TABLE compras ADD COLUMN gbraid TEXT`, (err) => {
    // Ignora o erro caso a coluna já exista
});

db.run(`ALTER TABLE compras ADD COLUMN wbraid TEXT`, (err) => {
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

    // ============================================================
    // REGISTRO DE ACESSOS / ORIGEM DOS VISITANTES
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS acessos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origem TEXT NOT NULL,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    gclid TEXT,
    gbraid TEXT,
    wbraid TEXT,
    visitor_id TEXT,
    data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Compatibilidade com bancos já existentes
db.run(`ALTER TABLE acessos ADD COLUMN visitor_id TEXT`, () => {});
    
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
    let {
        pacoteId,
        cpf,
        fbp,
        fbc,
        gclid,
        gbraid,
        wbraid
    } = req.body;

    console.log('===== GOOGLE ADS - TESTE =====');
console.log('GCLID recebido:', gclid);
console.log('GBRAID recebido:', gbraid);
console.log('WBRAID recebido:', wbraid);
console.log('================================');

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
                    external_reference: `${usuarioId}_${pacote.quantidade}_${pacote.preco}_${encodeURIComponent(fbp || '')}_${encodeURIComponent(fbc || '')}_${encodeURIComponent(gclid || '')}_${encodeURIComponent(gbraid || '')}_${encodeURIComponent(wbraid || '')}`,
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

let fbp = partes[3] ? decodeURIComponent(partes[3]) : null;
let fbc = partes[4] ? decodeURIComponent(partes[4]) : null;

let gclid = partes[5] ? decodeURIComponent(partes[5]) : null;
let gbraid = partes[6] ? decodeURIComponent(partes[6]) : null;
let wbraid = partes[7] ? decodeURIComponent(partes[7]) : null;

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
    (usuario_id, quantidade, valor, payment_id, gclid, gbraid, wbraid)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
        usuarioId,
        creditosComprados,
        valorPago,
        String(paymentId),
        gclid,
        gbraid,
        wbraid
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
    valor: valorPago,
    fbp: fbp,
    fbc: fbc
});

                await enviarConversaoGoogleAds({
    paymentId: paymentId,
    valor: valorPago,
    gclid: gclid,
    gbraid: gbraid,
    wbraid: wbraid,
    eventTimestamp: pagData.date_approved
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

// ============================================================
// VERIFICAR COMPRA PARA GOOGLE ADS
// ============================================================
app.get('/api/verificar-compra/:paymentId', verificarToken, (req, res) => {
    const paymentId = String(req.params.paymentId || '').trim();

    if (!paymentId) {
        return res.status(400).json({
            confirmada: false
        });
    }

    db.get(
        `SELECT payment_id, valor, quantidade
 FROM compras
 WHERE payment_id = ?
   AND usuario_id = ?`,
        [paymentId, req.usuarioId],
        (err, compra) => {

            if (err) {
                console.error(
                    "Erro ao verificar compra para Google Ads:",
                    err
                );

                return res.status(500).json({
                    confirmada: false
                });
            }

            if (!compra) {
                return res.json({
                    confirmada: false
                });
            }

            return res.json({
    confirmada: true,
    paymentId: String(compra.payment_id),
    valor: Number(compra.valor) || 0,
    quantidade: Number(compra.quantidade) || 0
});
        }
    );
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

// ============================================================
// REGISTRAR ACESSO / ORIGEM DO VISITANTE
// ============================================================
app.post('/api/registrar-acesso', (req, res) => {
    try {
        const {
    origem,
    utm_source,
    utm_medium,
    utm_campaign,
    gclid,
    gbraid,
    wbraid,
    visitor_id
} = req.body || {};

        const origemFinal = String(origem || 'direto').toLowerCase();

        const origensPermitidas = [
            'google_ads',
            'instagram',
            'direto',
            'outros'
        ];

        const origemValida = origensPermitidas.includes(origemFinal)
            ? origemFinal
            : 'outros';

        db.run(
    `INSERT INTO acessos
    (origem, utm_source, utm_medium, utm_campaign, gclid, gbraid, wbraid, visitor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
        origemValida,
        utm_source || null,
        utm_medium || null,
        utm_campaign || null,
        gclid || null,
        gbraid || null,
        wbraid || null,
        visitor_id || null
    ],
            function(err) {
                if (err) {
                    console.error("Erro ao registrar acesso:", err.message);
                    return res.status(500).json({
                        erro: "Erro ao registrar acesso."
                    });
                }

                res.json({
                    sucesso: true,
                    id: this.lastID
                });
            }
        );

    } catch (erro) {
        console.error("Erro no registro de acesso:", erro);
        res.status(500).json({
            erro: "Erro interno."
        });
    }
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
// === ESTATÍSTICAS DO DASHBOARD ADMIN ===
app.get('/api/admin/estatisticas', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const getQuery = (query, params = []) => new Promise((resolve, reject) => {
            db.get(query, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        // USUÁRIOS DE TESTE - NÃO ENTRAM NAS MÉTRICAS
        const usuariosTeste = [
            'hugo.tezza@gmail.com',
            'hugo.tezza1@gmail.com',
            'hugo.tezza2@gmail.com',
            'hugo.tezza3@gmail.com',
            'isabela.cf.decarvalho@gmail.com'
        ];

        const placeholders = usuariosTeste.map(() => '?').join(',');

        // ==========================================================
        // 1. USUÁRIOS CADASTRADOS
        // ==========================================================
        const usuarios_cadastrados = (await getQuery(`
            SELECT COUNT(*) AS c
            FROM usuarios
            WHERE LOWER(email) NOT IN (${placeholders})
        `, usuariosTeste)).c || 0;

        // ==========================================================
        // 2. USUÁRIOS QUE JÁ UTILIZARAM O SISTEMA
        // Pelo menos uma geração de questões
        // ==========================================================
        const usuarios_que_usaram = (await getQuery(`
            SELECT COUNT(DISTINCT g.usuario_id) AS c
            FROM geracoes g
            INNER JOIN usuarios u ON u.id = g.usuario_id
            WHERE LOWER(u.email) NOT IN (${placeholders})
        `, usuariosTeste)).c || 0;

        // ==========================================================
        // 3. USUÁRIOS ATIVOS NOS ÚLTIMOS 7 DIAS
        // ==========================================================
        const usuarios_ativos = (await getQuery(`
            SELECT COUNT(DISTINCT g.usuario_id) AS c
            FROM geracoes g
            INNER JOIN usuarios u ON u.id = g.usuario_id
            WHERE g.data >= datetime('now', '-7 days')
              AND LOWER(u.email) NOT IN (${placeholders})
        `, usuariosTeste)).c || 0;

        // ==========================================================
        // 4. TAXA DE ATIVAÇÃO
        // ==========================================================
        const taxa_ativacao = usuarios_cadastrados > 0
            ? (usuarios_que_usaram / usuarios_cadastrados) * 100
            : 0;

        // ==========================================================
        // 5. GERAÇÕES DE QUESTÕES
        // IMPORTANTE: não chamar isso de "PDFs enviados"
        // ==========================================================
        const geracoes = (await getQuery(`
            SELECT COUNT(*) AS c
            FROM geracoes g
            INNER JOIN usuarios u ON u.id = g.usuario_id
            WHERE LOWER(u.email) NOT IN (${placeholders})
        `, usuariosTeste)).c || 0;

        // ==========================================================
        // 6. QUESTÕES GRATUITAS
        // ==========================================================
        const questoes_gratuitas = (await getQuery(`
            SELECT COALESCE(SUM(g.quantidade), 0) AS c
            FROM geracoes g
            INNER JOIN usuarios u ON u.id = g.usuario_id
            WHERE g.is_pago = 0
              AND LOWER(u.email) NOT IN (${placeholders})
        `, usuariosTeste)).c || 0;

        // ==========================================================
        // 7. QUESTÕES PAGAS
        // ==========================================================
        const questoes_pagas = (await getQuery(`
            SELECT COALESCE(SUM(g.quantidade), 0) AS c
            FROM geracoes g
            INNER JOIN usuarios u ON u.id = g.usuario_id
            WHERE g.is_pago = 1
              AND LOWER(u.email) NOT IN (${placeholders})
        `, usuariosTeste)).c || 0;

        // ==========================================================
        // 8. COMPRAS
        // ==========================================================
        const comprasStats = await getQuery(`
            SELECT
                COALESCE(SUM(c.quantidade), 0) AS total_creditos,
                COALESCE(SUM(c.valor), 0) AS faturamento,
                COUNT(DISTINCT c.usuario_id) AS compradores
            FROM compras c
            INNER JOIN usuarios u ON u.id = c.usuario_id
            WHERE LOWER(u.email) NOT IN (${placeholders})
        `, usuariosTeste);

        const creditos_vendidos = Number(comprasStats.total_creditos) || 0;
        const faturamento = Number(comprasStats.faturamento) || 0;
        const compradores = Number(comprasStats.compradores) || 0;

        // ==========================================================
        // 9. TICKET MÉDIO
        // ==========================================================
        const ticket_medio = compradores > 0
            ? faturamento / compradores
            : 0;

        // ==========================================================
        // 10. CONVERSÃO EM COMPRA
        // ==========================================================
        const pct_compraram = usuarios_cadastrados > 0
            ? (compradores / usuarios_cadastrados) * 100
            : 0;

        // ==========================================================
        // 11. COMPRARAM NOVAMENTE
        // ==========================================================
        const rebuyStats = await getQuery(`
            SELECT COUNT(*) AS c
            FROM (
                SELECT c.usuario_id
                FROM compras c
                INNER JOIN usuarios u ON u.id = c.usuario_id
                WHERE LOWER(u.email) NOT IN (${placeholders})
                GROUP BY c.usuario_id
                HAVING COUNT(*) > 1
            )
        `, usuariosTeste);

        const compraram_novamente = Number(rebuyStats.c) || 0;

        // ==========================================================
        // 12. TAXA DE RECOMPRA
        // ==========================================================
        const taxa_recompra = compradores > 0
            ? (compraram_novamente / compradores) * 100
            : 0;

        // ==========================================================
        // 13. INVESTIMENTO EM MARKETING
        // ==========================================================
        const invRow = await getQuery(`
            SELECT valor
            FROM configuracoes
            WHERE chave = 'investimento_marketing'
        `);

        const investimento_marketing = invRow
            ? Number(invRow.valor) || 0
            : 0;

        // ==========================================================
        // 14. CUSTO ESTIMADO DA IA
        // ==========================================================
        const total_questoes = questoes_gratuitas + questoes_pagas;
        const custo_ia = total_questoes * 0.001;

        // ==========================================================
        // 15. CAC
        // Custo para adquirir um CLIENTE PAGANTE
        // ==========================================================
        const cac = compradores > 0
            ? (investimento_marketing / compradores)
            : 0;

        // ==========================================================
        // 16. CUSTO POR CADASTRO
        // ==========================================================
        const custo_por_cadastro = usuarios_cadastrados > 0
            ? (investimento_marketing / usuarios_cadastrados)
            : 0;

        // ==========================================================
        // 17. LTV
        // Média do total gasto por comprador
        // ==========================================================
        const ltvQuery = await getQuery(`
            SELECT AVG(total_gasto) AS ltv_medio
            FROM (
                SELECT
                    c.usuario_id,
                    SUM(c.valor) AS total_gasto
                FROM compras c
                INNER JOIN usuarios u ON u.id = c.usuario_id
                WHERE LOWER(u.email) NOT IN (${placeholders})
                GROUP BY c.usuario_id
            )
        `, usuariosTeste);

        const ltv = ltvQuery && ltvQuery.ltv_medio
            ? Number(ltvQuery.ltv_medio)
            : 0;

        // ==========================================================
        // 18. LTV / CAC
        // ==========================================================
        const ltv_cac = cac > 0
            ? ltv / cac
            : 0;

        // ==========================================================
        // 19. RESULTADO
        // ==========================================================
        const lucro_liquido =
            faturamento -
            custo_ia -
            investimento_marketing;

        // ==========================================================
        // RESPOSTA
        // ==========================================================
        res.json({
            usuarios_cadastrados,
            usuarios_que_usaram,
            usuarios_ativos,
            taxa_ativacao,

            geracoes,
            questoes_gratuitas,
            questoes_pagas,

            compradores,
            creditos_vendidos,
            faturamento,
            ticket_medio,
            pct_compraram,

            compraram_novamente,
            taxa_recompra,

            investimento_marketing,
            custo_ia,
            custo_por_cadastro,
            cac,
            ltv,
            ltv_cac,
            lucro_liquido
        });

    } catch (error) {
        console.error("Erro nas estatísticas administrativas:", error);

        res.status(500).json({
            erro: "Erro interno de métricas: " + error.message
        });
    }
});

// ============================================================
// ESTATÍSTICAS DE ACESSOS POR ORIGEM - ADMIN
// ============================================================
app.get('/api/admin/acessos', verificarToken, verificarAdmin, (req, res) => {

    const queries = {
        visitantes_unicos: `
    SELECT COUNT(DISTINCT visitor_id) AS total
    FROM acessos
    WHERE visitor_id IS NOT NULL
`,
        
        total: `
            SELECT COUNT(*) AS total
            FROM acessos
        `,

        google_ads: `
            SELECT COUNT(*) AS total
            FROM acessos
            WHERE origem = 'google_ads'
        `,

        instagram: `
            SELECT COUNT(*) AS total
            FROM acessos
            WHERE origem = 'instagram'
        `,

        direto: `
            SELECT COUNT(*) AS total
            FROM acessos
            WHERE origem = 'direto'
        `,

        outros: `
            SELECT COUNT(*) AS total
            FROM acessos
            WHERE origem = 'outros'
        `,

        ultimos: `
    SELECT
        origem,
        utm_source,
        utm_medium,
        utm_campaign,
        data
    FROM acessos
    ORDER BY id DESC
    LIMIT 10
`
    };

    const executarQuery = (query) => {
        return new Promise((resolve, reject) => {
            db.all(query, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    };

    const executarGet = (query) => {
        return new Promise((resolve, reject) => {
            db.get(query, [], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    };

    Promise.all([
        executarGet(queries.total),
executarGet(queries.visitantes_unicos),
executarGet(queries.google_ads),
executarGet(queries.instagram),
executarGet(queries.direto),
executarGet(queries.outros),
executarQuery(queries.ultimos)
    ])
    .then(([total, visitantesUnicos, googleAds, instagram, direto, outros, ultimos]) => {

        res.json({
    total: Number(total?.total || 0),
    visitantes_unicos: Number(visitantesUnicos?.total || 0),
    google_ads: Number(googleAds?.total || 0),
    instagram: Number(instagram?.total || 0),
    direto: Number(direto?.total || 0),
    outros: Number(outros?.total || 0),
    ultimos
});

    })
    .catch(err => {
        console.error("Erro nas estatísticas de acessos:", err);

        res.status(500).json({
            erro: "Erro ao carregar acessos."
        });
    });
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
