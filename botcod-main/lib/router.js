'use strict';

const BOT_PREFIX = '🤖 ';
const MAX_CACHE_ENTRIES = 2000;
const MAX_KEY_LENGTH = 200;
const COOLDOWN_MS = 750;
const INDIVIDUAL_ID = /^\d+@(?:c\.us|lid)$/;

function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const digits = value.trim().replace(/^\+/, '');
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

function normalizeResolvedPhone(value) {
  if (typeof value !== 'string') return null;
  // whatsapp-web.js returns pn as a serialized @c.us identifier. A LID is
  // deliberately never accepted here, even if its digits resemble a phone.
  return normalizePhone(value.endsWith('@c.us') ? value.slice(0, -5) : value);
}

function configFingerprint(config) {
  return JSON.stringify([
    config?.enabled,
    config?.mode,
    [...new Set((Array.isArray(config?.allowedNumbers) ? config.allowedNumbers : [])
      .map(normalizePhone).filter(Boolean))].sort(),
    config?.dictionaryPath ?? null,
    config?.configRevision ?? null,
  ]);
}

function messageId(message) {
  const id = message?.id;
  if (typeof id === 'string' && id) return id;
  if (typeof id?._serialized === 'string' && id._serialized) return id._serialized;
  // Recent WhatsApp Web serializers expose the structured MsgKey without its
  // computed _serialized property. Use the real message ID and conversation,
  // never the message body, to retain duplicate protection.
  if (typeof id?.id === 'string' && id.id && typeof message?.from === 'string') {
    return JSON.stringify([message.fromMe === true, message.from, message.to ?? null, id.id]);
  }
  return null;
}

/**
 * Route only explicitly authorized, fresh, individual text messages.
 * WhatsApp timestamps are seconds; startedAt and now() are milliseconds.
 * resolvePhone must return a verified international phone number (digits or
 * serialized @c.us), never a LID. Optional configRevision cancels pending work
 * after config changes, including pause/resume cycles.
 * onResult receives { chatId, key, found, kind, sent: true } after a successful send.
 */
function createMessageHandler({
  getConfig,
  getSelfIds,
  lookup,
  send,
  prepareValue = null,
  sendValue = null,
  onResult = () => {},
  onError = () => {},
  resolvePhone = async () => null,
  now = Date.now,
  startedAt = Date.now(),
}) {
  const processed = new Map();
  const lastReply = new Map();

  function remember(cache, key, value) {
    cache.set(key, value);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  async function reportError(error) {
    try { await onError(error); } catch { /* Logging must not crash the client. */ }
  }

  async function reply(chatId, text, result, isCurrent, isValue = false) {
    try {
      if (!isCurrent()) return;
      const asMedia = isValue && prepareValue && sendValue;
      const payload = asMedia ? await prepareValue(text) : BOT_PREFIX + text;
      if (!isCurrent()) return;
      const sent = await (asMedia ? sendValue : send)(chatId, payload);
      const sentId = messageId(sent);
      if (sentId) remember(processed, sentId, now());
      await onResult({ chatId, ...result, sent: true });
    } catch (error) {
      await reportError(error);
      if (isValue && prepareValue && isCurrent()) {
        try { await send(chatId, BOT_PREFIX + 'No pude generar o enviar el QR. Revisa el panel local.'); }
        catch (sendError) { await reportError(sendError); }
      }
    }
  }

  return async function handle(message) {
    try {
      const config = getConfig();
      if (!config || config.enabled !== true) return { ignored: 'paused-or-not-ready' };
      const fingerprint = configFingerprint(config);
      if (!message || message.type !== 'chat' || message.hasMedia || message.isStatus) return { ignored: 'not-text-chat' };
      if (typeof message.from !== 'string' || !INDIVIDUAL_ID.test(message.from)) return { ignored: 'sender-format' };
      if (message.to != null && (typeof message.to !== 'string' || !INDIVIDUAL_ID.test(message.to))) return { ignored: 'recipient-format' };
      if (typeof message.body !== 'string') return { ignored: 'no-text' };

      const key = message.body.trim();
      if (!key || key.startsWith('🤖') || [...key].length > MAX_KEY_LENGTH) return { ignored: 'empty-long-or-bot-text' };
      const timestamp = message.timestamp;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) ||
          timestamp * 1000 < startedAt - 2000) return { ignored: 'old-or-invalid-time' };

      const id = messageId(message);
      if (!id) return { ignored: 'missing-id' };
      if (processed.has(id)) return { ignored: 'duplicate-id' };
      // Reserve before awaiting phone resolution or lookup: duplicate concurrent
      // events must not produce two replies.
      remember(processed, id, now());

      let chatId;
      if (config.mode === 'self') {
        const selfIds = new Set(getSelfIds().filter(value =>
          typeof value === 'string' && INDIVIDUAL_ID.test(value)));
        if (message.fromMe !== true || !selfIds.has(message.from) || !selfIds.has(message.to)) return;
        chatId = message.to;
      } else if (config.mode === 'allowed') {
        if (message.fromMe !== false) return { ignored: 'outgoing-message' };
        const allowedNumbers = new Set((Array.isArray(config.allowedNumbers) ? config.allowedNumbers : [])
          .map(normalizePhone).filter(Boolean));
        if (!allowedNumbers.size) return;
        const phone = message.from.endsWith('@c.us')
          ? normalizePhone(message.from.slice(0, -5))
          : normalizeResolvedPhone(await resolvePhone(message.from));
        if (!phone || !allowedNumbers.has(phone)) return { ignored: phone ? 'number-not-authorized' : 'phone-unresolved' };
        chatId = message.from;
      } else {
        return;
      }

      function isCurrent() {
        if (configFingerprint(getConfig()) !== fingerprint) return false;
        if (config.mode === 'self') {
          const ids = new Set(getSelfIds());
          if (!ids.has(message.from) || !ids.has(message.to)) return false;
        }
        return true;
      }
      // A contact resolution or dictionary read can finish after the user
      // pauses the bot or revokes access. Never send using stale authorization.
      if (!isCurrent()) return;

      const time = now();
      if (lastReply.has(chatId) && time - lastReply.get(chatId) < COOLDOWN_MS) return;
      remember(lastReply, chatId, time);

      if (key.toLocaleLowerCase('es') === '/ayuda') {
        await reply(chatId, prepareValue ? 'Escribe una clave del diccionario para recibir su QR.' : 'Escribe una clave del diccionario para consultar su valor.',
          { key, found: null, kind: 'help' }, isCurrent);
        return;
      }
      // Never list the local dictionary through chat.
      if (key.toLocaleLowerCase('es') === '/claves') return;

      let result;
      try {
        result = await lookup(key);
        if (!result || typeof result.found !== 'boolean' ||
            (result.found && result.value == null)) {
          throw new Error('Respuesta inválida del diccionario.');
        }
      } catch (error) {
        await reportError(error);
        await reply(chatId, 'No pude consultar el diccionario. Revisa el panel local.',
          { key, found: null, kind: 'error' }, isCurrent);
        return;
      }

      await reply(chatId, result.found ? String(result.value) : 'No encontré esa clave.',
        { key: result.key ?? key, found: result.found, kind: 'lookup' }, isCurrent, result.found);
    } catch (error) {
      await reportError(error);
    }
  };
}

module.exports = { createMessageHandler };
