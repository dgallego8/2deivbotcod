'use strict';

(() => {
  const byId = (id) => document.getElementById(id);
  const token = document.querySelector('meta[name="api-token"]').content;
  let currentStatus = null;
  let initializedSettings = false;
  let settingsEdited = false;
  let stopped = false;
  let pollTimer = null;
  let polling = false;
  const pending = new Set();

  const stateLabels = {
    starting: 'Iniciando', qr: 'Escanea el QR', authenticated: 'Vinculado',
    ready: 'Conectado', disconnected: 'Desconectado', error: 'Revisar conexión', offline: 'Sin conexión'
  };

  async function api(path, body) {
    const options = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Bot-Token': token },
      cache: 'no-store'
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`/api/${path}`, options);
    let result;
    try { result = await response.json(); }
    catch { throw new Error('El bot no devolvió una respuesta válida. Recarga el panel.'); }
    if (!response.ok || result.error) throw new Error(result.error || 'No se pudo completar la operación.');
    return result;
  }

  function feedback(id, message, tone = '') {
    const element = byId(id);
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function updateControls() {
    byId('connect-button').disabled = stopped || pending.has('connect') || ['starting', 'qr', 'authenticated'].includes(currentStatus?.state);
    byId('connect-button').textContent = pending.has('connect') ? 'Conectando…' : currentStatus?.state === 'ready' ? 'Reconectar WhatsApp' : 'Conectar WhatsApp';
    byId('toggle-button').disabled = stopped || pending.has('toggle') || !currentStatus;
    byId('toggle-button').textContent = pending.has('toggle') ? 'Guardando…' : currentStatus?.enabled === false ? 'Activar respuestas' : 'Pausar respuestas';
    byId('save-button').disabled = stopped || pending.has('config');
    byId('save-button').textContent = pending.has('config') ? 'Guardando…' : 'Guardar configuración';
    byId('lookup-button').disabled = stopped || pending.has('lookup');
    byId('lookup-button').textContent = pending.has('lookup') ? 'Buscando…' : 'Consultar';
    byId('shutdown-button').disabled = stopped || pending.has('shutdown');
    byId('shutdown-button').textContent = stopped ? 'Bot apagado' : pending.has('shutdown') ? 'Apagando…' : 'Apagar bot';
  }

  function showConnection(state, qr, enabled) {
    const image = byId('qr-code');
    const showQr = state === 'qr' && typeof qr === 'string' && qr.startsWith('data:image/');
    image.hidden = !showQr;
    byId('qr-placeholder').hidden = showQr;
    if (showQr && image.getAttribute('src') !== qr) image.src = qr;
    if (!showQr) image.removeAttribute('src');
    const views = {
      starting: ['↗', 'Preparando WhatsApp', 'La primera conexión puede tardar un poco.'],
      qr: ['↗', 'Preparando el código QR', 'Aparecerá aquí cuando esté listo.'],
      authenticated: ['✓', 'Cuenta vinculada', 'Terminando de preparar la conexión…'],
      ready: enabled ? ['✓', 'Todo listo para consultar', 'Envía una key desde tu WhatsApp Business al personal.'] : ['Ⅱ', 'Respuestas en pausa', 'Activa las respuestas para volver a consultar por WhatsApp.'],
      disconnected: ['↗', 'Vuelve a conectar tu cuenta', 'Pulsa «Conectar WhatsApp» para continuar.'],
      error: ['!', 'La conexión necesita atención', 'Revisa el detalle y vuelve a conectar tu cuenta.'],
      offline: ['○', 'El bot no está conectado', 'Puedes iniciar la conexión con el botón de abajo.']
    };
    const view = views[state] || views.offline;
    byId('connection-symbol').textContent = view[0];
    byId('connection-message').textContent = view[1];
    byId('connection-hint').textContent = view[2];
  }

  function render(status) {
    currentStatus = status;
    const state = status.state || 'offline';
    byId('status-badge').dataset.state = state;
    byId('status-label').textContent = state === 'ready' && !status.enabled ? 'En pausa' : stateLabels[state] || 'Sin conexión';
    byId('status-detail').textContent = status.detail || 'Conecta tu cuenta para recibir consultas.';
    showConnection(state, status.qrDataUrl, status.enabled);
    byId('account-label').textContent = status.account || '—';
    byId('replies-label').textContent = String(status.replies ?? 0);
    const lastReplyDate = status.lastReplyAt && new Date(status.lastReplyAt);
    byId('last-reply').textContent = lastReplyDate && !Number.isNaN(lastReplyDate.getTime())
      ? `Última respuesta: ${lastReplyDate.toLocaleString('es-CO')}`
      : 'Sin respuestas enviadas en esta sesión.';
    byId('last-error').textContent = status.lastError || '';
    byId('last-error').hidden = !status.lastError;

    const dictionary = status.dictionary || {};
    byId('dictionary-count').textContent = dictionary.error ? 'No se pudo leer el archivo' : `${Number(dictionary.count || 0).toLocaleString('es-CO')} keys disponibles`;
    byId('dictionary-detail').textContent = dictionary.error || dictionary.path || 'Diccionario en Railway';
    byId('dictionary-count').closest('.dictionary-info').dataset.error = String(Boolean(dictionary.error));
    if (!initializedSettings && status.config) {
      if (!settingsEdited) {
        const number = status.config.allowedNumbers?.[0] || '';
        byId('personal-number').value = number ? `+${number.replace(/^\+/, '')}` : '';
        byId('dictionary-path').value = status.config.dictionaryPath || dictionary.path || '';
      }
      initializedSettings = true;
    }
    updateControls();
  }

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      const status = await api('status');
      if (!stopped) render(status);
    } catch (error) {
      if (!stopped) {
        byId('status-badge').dataset.state = 'offline';
        byId('status-label').textContent = 'Panel sin conexión';
        byId('status-detail').textContent = 'No se puede contactar con el bot en Railway. Comprueba que siga abierto.';
        showConnection('offline', null, false);
        byId('connection-message').textContent = 'No se pudo contactar con el bot';
        byId('connection-hint').textContent = 'Si cerraste el programa, vuelve a abrirlo y recarga este panel.';
      }
    } finally {
      polling = false;
      if (!stopped) pollTimer = window.setTimeout(poll, 2500);
    }
  }

  async function action(name, work, errorFeedback) {
    if (stopped || pending.has(name)) return;
    pending.add(name);
    updateControls();
    try { await work(); }
    catch (error) { feedback(errorFeedback, error.message || 'No se pudo completar la operación.', 'error'); }
    finally { pending.delete(name); updateControls(); }
  }

  byId('connect-button').addEventListener('click', () => action('connect', async () => {
    feedback('connection-feedback', 'Iniciando conexión…');
    await api('connect', {});
    feedback('connection-feedback', 'Conexión solicitada. El estado se actualizará aquí.');
  }, 'connection-feedback'));

  byId('toggle-button').addEventListener('click', () => action('toggle', async () => {
    const enabled = !currentStatus?.enabled;
    await api('toggle', { enabled });
    if (currentStatus) render({ ...currentStatus, enabled });
    feedback('connection-feedback', enabled ? 'Respuestas activadas.' : 'Respuestas en pausa. La cuenta sigue vinculada.', 'success');
  }, 'connection-feedback'));

  byId('settings-form').addEventListener('input', () => { settingsEdited = true; });
  byId('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action('config', async () => {
      const number = byId('personal-number').value.trim().replace(/[\s()+-]/g, '');
      const dictionaryPath = byId('dictionary-path').value.trim();
      if (!/^\d{7,15}$/.test(number)) throw new Error('Escribe un número válido con código de país.');
      if (!dictionaryPath) throw new Error('Escribe la ruta completa del diccionario JSON.');
      feedback('settings-feedback', 'Guardando configuración…');
      await api('config', { allowedNumbers: [number], dictionaryPath });
      feedback('settings-feedback', 'Configuración guardada.', 'success');
    }, 'settings-feedback');
  });

  byId('lookup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action('lookup', async () => {
      const key = byId('lookup-key').value;
      byId('lookup-result').hidden = true;
      if (!key.length) throw new Error('Escribe una key para consultar.');
      feedback('lookup-feedback', 'Consultando el diccionario…');
      const result = await api('lookup', { key });
      if (!result.found) {
        feedback('lookup-feedback', 'No se encontró esa key. Comprueba que coincida exactamente con el archivo.');
        return;
      }
      byId('result-key').textContent = String(result.key ?? key);
      if (typeof result.imageDataUrl !== 'string' || !result.imageDataUrl.startsWith('data:image/png;base64,')) throw new Error('Reinicia el bot para activar la respuesta con QR.');
      byId('result-image').src = result.imageDataUrl;
      byId('lookup-result').hidden = false;
      feedback('lookup-feedback', 'QR verificado. Esta es la imagen que se enviará por WhatsApp.', 'success');
    }, 'lookup-feedback');
  });

  byId('shutdown-button').addEventListener('click', () => action('shutdown', async () => {
    await api('shutdown', {});
    stopped = true;
    window.clearTimeout(pollTimer);
    byId('status-badge').dataset.state = 'offline';
    byId('status-label').textContent = 'Apagado';
    byId('status-detail').textContent = 'El bot está apagado y ya no responde consultas.';
    showConnection('offline', null, false);
    byId('connection-message').textContent = 'Bot apagado';
    byId('connection-hint').textContent = 'Para volver a usarlo, abre de nuevo el programa.';
    feedback('shutdown-feedback', 'Bot apagado. Puedes cerrar esta pestaña.', 'success');
  }, 'shutdown-feedback'));

  byId('upload-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('upload-button');
    button.disabled = true;
    try {
      const file = byId('dictionary-file').files[0];
      if (!file || file.size > 10 * 1024 * 1024) throw new Error('Selecciona un JSON de hasta 10 MiB.');
      const dictionary = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      const result = await api('dictionary', { dictionary });
      feedback('upload-feedback', `Guardado: ${result.count} keys. Ya puedes consultarlas.`, 'success');
    } catch (error) { feedback('upload-feedback', error.message, 'error'); }
    finally { button.disabled = false; }
  });
  poll();
})();
