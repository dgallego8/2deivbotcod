'use strict';

// Backup to WhatsApp Web events. Uses the same router, authorization and
// duplicate cache as live events; it cannot bypass access checks.
function createInboundPoll({ client, getConfig, isActive, receive, onError, interval = 5000 }) {
  let stopped = false, running = false, timer;
  async function tick() {
    if (stopped || running || !isActive()) return;
    const config = getConfig();
    if (!config.enabled || config.mode !== 'allowed') return;
    running = true;
    try {
      const phones = [...new Set(config.allowedNumbers)].filter(number => /^[1-9]\d{6,14}$/.test(number));
      const ids = new Set(phones.map(phone => phone + '@c.us'));
      if (ids.size) {
        try {
          const pairs = await client.getContactLidAndPhone([...ids]);
          for (const pair of pairs || []) {
            if (ids.has(pair.pn) && /^\d+@lid$/.test(pair.lid)) ids.add(pair.lid);
          }
        } catch { /* Phone chat remains available; router verifies any LID. */ }
      }
      let lastError, fetched = false;
      for (const id of ids) {
        if (stopped || !isActive()) break;
        let chat, messages;
        try {
          chat = await client.getChatById(id);
          if (!chat || chat.isGroup) continue;
          messages = await chat.fetchMessages({ limit: 10, fromMe: false });
          fetched = true;
        } catch (error) { lastError = error; continue; }
        if (!chat || chat.isGroup) continue;
        for (const message of messages) {
          if (stopped || !isActive()) break;
          await receive(message, 'consulta periódica');
        }
      }
      if (!fetched && lastError) throw lastError;
    } catch (error) { if (!stopped && isActive()) onError(error); }
    finally { running = false; }
  }
  return {
    tick,
    start() { if (!timer && !stopped) { timer = setInterval(() => void tick(), interval); timer.unref?.(); } },
    stop() { stopped = true; clearInterval(timer); timer = null; }
  };
}
module.exports = { createInboundPoll };
