'use strict';
const fs = require('node:fs/promises');

function createRecovery({ restart, isAllowed, onSchedule, onLimit, onError, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, limit = 5, windowMs = 15 * 60 * 1000 }) {
  let timer = null, pending = false, running = false, queued = false, history = [], generation = 0;
  function request() {
    if (!isAllowed()) return;
    if (pending) { if (running) queued = true; return; }
    history = history.filter(time => now() - time < windowMs);
    if (history.length >= limit) { onLimit(); return; }
    const delay = Math.min(5000 * 2 ** history.length, 60000);
    history.push(now()); pending = true;
    const revision = generation;
    onSchedule(delay, history.length);
    timer = schedule(async () => {
      timer = null;
      if (revision !== generation || !isAllowed()) { pending = false; return; }
      let failure;
      running = true; queued = false;
      try { await restart(); }
      catch (error) { failure = error; onError(error); }
      finally { if (revision === generation) { pending = false; running = false; } }
      if ((failure || queued) && revision === generation) { queued = false; request(); }
    }, delay);
    timer?.unref?.();
  }
  function stop() { generation++; cancel(timer); timer = null; pending = false; running = false; queued = false; }
  return { request, stop, reset() { stop(); history = []; } };
}
async function closeClient(client, timeoutMs = 7000) {
  if (!client) return;
  let timer;
  const browserProcess = client.pupBrowser?.process?.();
  try {
    await Promise.race([
      Promise.resolve().then(() => client.destroy()).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) browserProcess.kill('SIGKILL');
  }
}
async function memorySnapshot() {
  const result = {};
  for (const name of ['memory.current','memory.peak','memory.max','memory.events']) {
    try { result[name] = (await fs.readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim(); }
    catch { result[name] = 'no disponible'; }
  }
  return result;
}
module.exports = { createRecovery, closeClient, memorySnapshot };
