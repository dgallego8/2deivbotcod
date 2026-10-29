'use strict';
function browserSnapshot(since) {
  const collection = window.require('WAWebCollections').Msg;
  if (!collection?.getModelsArray) throw new Error('La colección de mensajes aún no está disponible.');
  const all = collection.getModelsArray();
  const candidates = all.filter(message => {
    const sender = message.from?._serialized || message.from || message.id?.remote?._serialized;
    return message.id?.fromMe === false && message.type === 'chat' && Number.isFinite(message.t) && message.t >= since && /^\d+@(?:c\.us|lid)$/.test(sender);
  }).sort((a,b) => a.t - b.t).slice(-200);
  const serializeId = id => typeof id === 'string' ? id : id?._serialized || null;
  return { loaded: all.length, messages: candidates.map(message => ({
    id: { id: message.id.id, _serialized: message.id._serialized },
    type: message.type, from: serializeId(message.from) || serializeId(message.id.remote),
    to: serializeId(message.to), fromMe: message.id.fromMe,
    timestamp: message.t, body: typeof message.body === 'string' ? message.body : '',
    hasMedia: Boolean(message.directPath), isStatus: Boolean(message.isStatusV3)
  })) };
}
const sessions = new WeakMap();
async function evaluateSmall(session, expression, stage) {
  try {
    const response = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, timeout: 10000 }, {timeout:15000});
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  } catch (error) { throw new Error(`Diagnóstico v3 — ${stage}: ${error.message}`); }
}
async function readCachedMessages(client, since) {
  let session = sessions.get(client);
  if (!session) {
    session = await client.pupPage.createCDPSession();
    sessions.set(client,session);
    const basic = await evaluateSmall(session, 'JSON.stringify({js:1+1,ready:document.readyState,visible:document.visibilityState,require:typeof window.require})', 'prueba básica del navegador');
    console.log(`Diagnóstico v3 navegador: ${basic}`);
  }
  const raw = await evaluateSmall(session, `JSON.stringify((${browserSnapshot.toString()})(${Number(since)}))`, 'lectura mínima de mensajes');
  return JSON.parse(raw);
}
function createInboundPoll({ client, getConfig, isActive, receive, onError, interval = 5000, readMessages = readCachedMessages, onSnapshot = () => {}, startedAt = Date.now() }) {
  let stopped = false, running = false, timer;
  async function tick() {
    if (stopped || running || !isActive()) return;
    const config = getConfig();
    if (!config.enabled || config.mode !== 'allowed') return;
    running = true;
    try {
      const snapshot = await readMessages(client, Math.floor(startedAt / 1000) - 2);
      if (stopped || !isActive()) return;
      onSnapshot({ loaded: snapshot.loaded, recent: snapshot.messages.length });
      for (const message of snapshot.messages) {
        if (stopped || !isActive()) break;
        await receive(message, 'consulta periódica');
      }
    } catch (error) { if (!stopped && isActive()) onError(error); }
    finally { running = false; }
  }
  return {
    tick,
    start() { if (!timer && !stopped) { timer = setInterval(() => void tick(), interval); timer.unref?.(); } },
    stop() { stopped = true; clearInterval(timer); timer = null; }
  };
}
module.exports = { createInboundPoll, browserSnapshot, readCachedMessages, evaluateSmall };
