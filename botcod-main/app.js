'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Dictionary } = require('./lib/dictionary');
const { loadConfig, saveConfig, validateConfig } = require('./lib/config');
const { createMessageHandler } = require('./lib/router');
const { renderQrCard } = require('./lib/qr-card');
const { ensureMediaCompatibility } = require('./lib/media-compat');
const { createInboundPoll } = require('./lib/inbound-poll');
const { createRecovery, closeClient, memorySnapshot } = require('./lib/browser-recovery');

const ROOT = __dirname;
const { settings, authorized, bootstrap } = require('./lib/cloud');
const cloud = settings();
let CONFIG_PATH = path.join(cloud.data, 'config.json');
const TOKEN = crypto.randomBytes(32).toString('hex');
const panelOnly = process.argv.includes('--panel-only');
let config, dictionary, client, connectPromise, server, shuttingDown = false;
let inboundPoll;
let lastPollLog = 0;
let selfIds = [];
let configRevision = 0;
let configTail = Promise.resolve();
const state = { state: 'offline', detail: 'Preparando el bot.', qrDataUrl: null, account: null, replies: 0, lastReplyAt: null, lastError: null };
const recovery = createRecovery({
  restart: async () => {
    const active = client;
    client = null;
    await closeClient(active);
    if (connectPromise) await connectPromise;
    if (!shuttingDown) await connect(true);
  },
  isAllowed: () => !shuttingDown && !panelOnly,
  onSchedule: (delay, attempt) => setState('starting', `Recuperación v5: reconectando en ${delay / 1000} segundos (intento ${attempt}/5).`),
  onLimit: () => setState('error', 'Chrome falló varias veces. Revisa los logs y pulsa Reconectar para volver a intentar.'),
  onError: recordError
});
function browserFailure(active, error) {
  if (client !== active || shuttingDown) return;
  inboundPoll?.stop();
  recordError(error instanceof Error ? error : new Error('Chrome se desconectó.'));
  void memorySnapshot().then(snapshot => console.log(`Recursos al fallar Chrome: ${JSON.stringify(snapshot)}`)).catch(recordError);
  recovery.request();
}

function setState(name, detail) {
  state.state = name;
  state.detail = detail;
  if (name !== 'qr') state.qrDataUrl = null;
  console.log(`[${new Date().toISOString()}] ${detail}`);
}
function recordError(error) {
  // No registrar mensajes, claves, valores ni números de contactos.
  state.lastError = error instanceof Error ? error.message : 'Ocurrió un error de conexión.';
  console.error(`[${new Date().toISOString()}] Error del bot: ${error?.stack || state.lastError}`);
}
function browserPath() {
  if (process.platform === 'linux') {
    const compatible = require('puppeteer').executablePath();
    if (!fs.existsSync(compatible)) throw new Error('No se instaló Chrome compatible. Despliega el Dockerfile v4 actualizado.');
    return compatible;
  }
  const candidates = [
    process.env.BOT_BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

async function connect(force = false) {
  if (connectPromise) return connectPromise;
  if (state.state === 'ready' && !force) return;
  connectPromise = (async () => {
    inboundPoll?.stop();
    if (client) {
      const previous = client;
      client = null;
      await closeClient(previous);
    }
    selfIds = [];
    state.account = null;
    state.lastError = null;
    setState('starting', 'Abriendo la conexión con WhatsApp.');
    const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
    class GuardedLocalAuth extends LocalAuth {
      async afterBrowserInitialized() {
        await super.afterBrowserInitialized();
        this.client.pupPage.on('dialog', dialog => {
          console.log(`Navegador v4: aviso ${dialog.type()} cerrado para desbloquear JavaScript.`);
          void dialog.dismiss().catch(recordError);
        });
        this.client.pupPage.on('error', error => browserFailure(this.client, error));
        this.client.pupBrowser.on('disconnected', () => browserFailure(this.client, new Error('Chrome se desconectó del bot.')));
        console.log(`Navegador v4: ${await this.client.pupBrowser.version()}`);
      }
    }
    const QRCode = require('qrcode');
    const executablePath = browserPath();
    if (!executablePath) throw new Error('Instala Google Chrome o Microsoft Edge para vincular WhatsApp.');
    const current = new Client({
      authStrategy: new GuardedLocalAuth({ clientId: 'diccionario-personal', dataPath: path.join(cloud.data, '.session') }),
      puppeteer: { headless: true, executablePath, timeout: 60000, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
      webVersionCache: { type: 'local', path: path.join(cloud.data, '.wwebjs_cache') },
      authTimeoutMs: 120000,
      deviceName: 'Diccionario Railway',
      browserName: 'Chrome'
    });
    client = current;
    let handleMessage = null;
    let qrRevision = 0;
    current.on('qr', async qr => {
      if (client !== current) return;
      const revision = ++qrRevision;
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
        if (client !== current || revision !== qrRevision) return;
        setState('qr', 'Escanea el QR con tu WhatsApp personal.');
        state.qrDataUrl = qrDataUrl;
      } catch (error) { recordError(error); }
    });
    current.on('authenticated', () => {
      if (client !== current) return;
      qrRevision++;
      setState('authenticated', 'Teléfono vinculado. Sincronizando WhatsApp.');
    });
    current.on('ready', async () => {
      if (client !== current) return;
      const wid = current.info?.wid?._serialized;
      selfIds = wid ? [wid] : [];
      try {
        if (wid) {
          const pairs = await current.getContactLidAndPhone([wid]);
          for (const pair of pairs || []) selfIds.push(pair.lid, pair.pn);
        }
      } catch { /* Las consultas entrantes autorizadas no necesitan el LID propio. */ }
      if (client !== current) return;
      selfIds = [...new Set(selfIds.filter(id => typeof id === 'string'))];
      state.account = current.info?.wid?.user || null;
      handleMessage = createMessageHandler({
        getConfig: () => ({ ...config, configRevision, enabled: config.enabled && state.state === 'ready' && client === current && !shuttingDown }),
        getSelfIds: () => selfIds,
        startedAt: Date.now(),
        lookup: key => dictionary.lookup(key),
        resolvePhone: async id => {
          const pairs = await current.getContactLidAndPhone([id]);
          return pairs?.find(pair => pair.lid === id)?.pn || null;
        },
        send: (chatId, text) => current.sendMessage(chatId, text, { sendSeen: false, linkPreview: false }),
        prepareValue: renderQrCard,
        sendValue: (chatId, png) => current.sendMessage(chatId, new MessageMedia('image/png', png.toString('base64'), 'qr.png'), {sendSeen:false,sendMediaAsHd:true}),
        onResult: () => { state.replies++; state.lastReplyAt = new Date().toISOString(); console.log(`[${state.lastReplyAt}] Respuesta enviada.`); },
        onError: recordError
      });
      setState('ready', 'WhatsApp conectado. El bot está listo para consultar.');
      console.log('Recuperación v5 activada.');
      inboundPoll?.stop();
      inboundPoll = createInboundPoll({
        client: current, getConfig: () => config,
        isActive: () => client === current && state.state === 'ready' && !shuttingDown,
        receive, onError: error => {
          if (error.message.startsWith('Diagnóstico v3')) {
            browserFailure(current, error);
          } else recordError(error);
        },
        onSnapshot: snapshot => { if (Date.now() - lastPollLog > 60000) { lastPollLog = Date.now(); console.log(`Recepción v3: ${snapshot.loaded} mensajes cargados; ${snapshot.recent} textos recientes.`); } }
      });
      inboundPoll.start();
      console.log('Recepción v3 activada (diagnóstico y lectura mínima).');
    });
    async function receive(message, source = 'evento') {
      if (client !== current || !handleMessage) return;
      const result = await handleMessage(message);
      if (message.type === 'chat' && !['duplicate-id', 'old-or-invalid-time', 'outgoing-message'].includes(result?.ignored)) {
        console.log(`[${new Date().toISOString()}] Mensaje recibido por ${source}; resultado: ${result?.ignored || 'procesado'}.`);
      }
    }
    current.on('message_create', message => { void receive(message).catch(recordError); });
    current.on('message', message => { void receive(message).catch(recordError); });
    current.on('auth_failure', () => {
      if (client !== current) return;
      qrRevision++;
      handleMessage = null;
      inboundPoll?.stop();
      setState('error', 'No se pudo vincular. Pulsa Volver a conectar para intentarlo de nuevo.');
    });
    current.on('disconnected', () => {
      if (client !== current || shuttingDown) return;
      qrRevision++;
      handleMessage = null;
      inboundPoll?.stop();
      state.account = null;
      setState('disconnected', 'WhatsApp se desconectó. Pulsa Volver a conectar.');
    });
    await current.initialize();
  })().catch(error => {
    recordError(error);
    setState('error', 'No se pudo conectar. Revisa la conexión y vuelve a intentarlo.');
  }).finally(() => { connectPromise = null; });
  return connectPromise;
}

async function status() {
  let count = 0, error = null;
  try { count = Object.keys(await dictionary.read()).length; }
  catch (err) { error = err.message; }
  return { ...state, enabled: config.enabled, dictionary: { path: config.dictionaryPath, count, error }, config: { mode: config.mode, allowedNumbers: config.allowedNumbers, dictionaryPath: config.dictionaryPath } };
}
function headers(res, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function json(res, code, value) {
  headers(res, 'application/json; charset=utf-8');
  res.writeHead(code);
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('Envía la solicitud como JSON.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 10 * 1024 * 1024 + 8192) throw new Error('La solicitud es demasiado grande.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('La solicitud no contiene JSON válido.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('La solicitud no es válida.');
  return body;
}
function updateConfig(patch) {
  const pending = configTail.then(async () => {
    const next = validateConfig({ ...config, ...patch });
    const source = new Dictionary(next.dictionaryPath);
    await source.read();
    await saveConfig(CONFIG_PATH, next);
    config = next;
    configRevision++;
    dictionary = source;
  });
  configTail = pending.catch(() => {});
  return pending;
}
async function route(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true });
  const origin = cloud.origin;
  if (req.headers.host !== cloud.host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Abre el dominio de tu panel.' });
  if (!authorized(req.headers.authorization, cloud)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Mi bot", charset="UTF-8"');
    return json(res, 401, { error: 'Introduce el usuario y contraseña del panel.' });
  }
  const url = new URL(req.url, origin);
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    if (req.headers['x-bot-token'] !== TOKEN) return json(res, 403, { error: 'Recarga el panel para renovar la conexión.' });
    if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, await status());
    if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido.' });
    const body = await readBody(req);
    if (pathname === '/api/lookup') {
      if (typeof body.key !== 'string' || !body.key.trim() || body.key.length > 200) throw new Error('Escribe una clave de hasta 200 caracteres.');
      const result = await dictionary.lookup(body.key);
      if (!result.found) return json(res, 200, result);
      const png = await renderQrCard(result.value);
      return json(res, 200, {found:true,key:result.key,imageDataUrl:'data:image/png;base64,'+png.toString('base64')});
    }
    if (pathname === '/api/dictionary') {
      if (!body.dictionary) throw new Error('Selecciona un diccionario JSON.');
      const saved = await dictionary.save(body.dictionary);
      configRevision++;
      return json(res, 200, { ok: true, count: Object.keys(saved).length });
    }
    if (pathname === '/api/config') {
      await updateConfig({ allowedNumbers: body.allowedNumbers });
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/toggle') {
      if (typeof body.enabled !== 'boolean') throw new Error('El estado no es válido.');
      if (!body.enabled) {
        // Se puede pausar aunque el diccionario haya sido borrado o esté inválido.
        const pending = configTail.then(async () => { config = await saveConfig(CONFIG_PATH, { ...config, enabled: false }); configRevision++; });
        configTail = pending.catch(() => {});
        await pending;
      } else await updateConfig({ enabled: true });
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/connect') {
      if (panelOnly) throw new Error('El panel está en modo de prueba.');
      recovery.reset();
      void connect(true);
      return json(res, 202, { ok: true });
    }
    return json(res, 404, { error: 'Acción no encontrada.' });
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Método no permitido.' });
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const file = files[pathname];
  if (!file) return json(res, 404, { error: 'Página no encontrada.' });
  let content = await fsp.readFile(path.join(ROOT, 'public', file[0]), 'utf8');
  if (pathname === '/') content = content.replace('__API_TOKEN__', TOKEN);
  headers(res, file[1]);
  res.writeHead(200);
  res.end(content);
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  recovery.stop();
  inboundPoll?.stop();
  const timeout = setTimeout(() => process.exit(0), 8000);
  timeout.unref();
  if (server) server.close();
  const active = client;
  client = null;
  await closeClient(active);
  await fsp.unlink(path.join(ROOT, 'runtime', 'bot.pid')).catch(() => {});
  process.exit(0);
}
async function main() {
  ensureMediaCompatibility();
  const initialized = await bootstrap(ROOT, cloud);
  CONFIG_PATH = initialized.configPath;
  config = initialized.config;
  dictionary = new Dictionary(config.dictionaryPath);
  await fsp.mkdir(path.join(ROOT, 'runtime'), { recursive: true });
  server = http.createServer((req, res) => { route(req, res).catch(error => { if (!res.writableEnded) json(res, 400, { error: error.message }); }); });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'El bot ya está abierto o el puerto está ocupado. Abre http://127.0.0.1:8877' : error.message);
    process.exit(1);
  });
  await new Promise(resolve => server.listen(config.port, '0.0.0.0', resolve));
  await fsp.writeFile(path.join(ROOT, 'runtime', 'bot.pid'), String(process.pid));
  console.log(`Panel protegido listo: ${cloud.origin}`);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (!panelOnly) void connect();
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
