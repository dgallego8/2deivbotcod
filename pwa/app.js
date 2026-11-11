'use strict';

// Versión estática del "Haz una consulta aquí" del panel (botcod-main/public/ui.js).
// Replica en el navegador lo que hacen botcod-main/lib/dictionary.js (búsqueda)
// y botcod-main/lib/qr-card.js (plantilla + QR) en el servidor.
(() => {
  const byId = (id) => document.getElementById(id);
  const DICTIONARY_URL = 'data/payloads_generados.json';
  const TEMPLATE_URL = 'assets/plantilla-original.jpeg';
  const AREA = { left: 184, top: 450, width: 526, height: 526 };
  const pending = new Set();
  let dictionaryPromise = null;
  let templatePromise = null;

  // Igual que normalizeKey() en lib/dictionary.js.
  const normalizeKey = (key) => key.normalize('NFC').trim().toLowerCase().normalize('NFC');
  // Igual que renderValue() en lib/dictionary.js.
  const renderValue = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

  function feedback(id, message, tone = '') {
    const element = byId(id);
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function updateControls() {
    byId('lookup-button').disabled = pending.has('lookup');
    byId('lookup-button').textContent = pending.has('lookup') ? 'Buscando…' : 'Consultar';
  }

  async function action(name, work, errorFeedback) {
    if (pending.has(name)) return;
    pending.add(name);
    updateControls();
    try { await work(); }
    catch (error) { feedback(errorFeedback, error.message || 'No se pudo completar la operación.', 'error'); }
    finally { pending.delete(name); updateControls(); }
  }

  function loadDictionary() {
    if (!dictionaryPromise) {
      dictionaryPromise = (async () => {
        let response;
        try { response = await fetch(DICTIONARY_URL); }
        catch { throw new Error('No se pudo leer el diccionario. Abre la app una vez con internet para guardarlo.'); }
        if (!response.ok) throw new Error('No se encontró el archivo del diccionario.');
        let data;
        try { data = JSON.parse((await response.text()).replace(/^﻿/, '')); }
        catch { throw new Error('El archivo del diccionario no contiene JSON válido.'); }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('El diccionario debe ser un objeto JSON de claves y valores.');
        }
        const index = new Map();
        for (const [key, value] of Object.entries(data)) {
          const normalized = normalizeKey(key);
          if (!index.has(normalized)) index.set(normalized, { key, value: renderValue(value) });
        }
        return index;
      })();
      dictionaryPromise.catch(() => { dictionaryPromise = null; });
    }
    return dictionaryPromise;
  }

  function loadTemplate() {
    if (!templatePromise) {
      templatePromise = new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('No se pudo cargar la plantilla.'));
        image.src = TEMPLATE_URL;
      });
      templatePromise.catch(() => { templatePromise = null; });
    }
    return templatePromise;
  }

  // Igual que renderQrCard() en lib/qr-card.js, dibujado en un <canvas>.
  async function renderQrCard(value) {
    if (typeof value !== 'string' || !value.length) throw new Error('El valor está vacío; no se puede generar el QR.');
    let symbol;
    try { symbol = window.QRCodeCore.create([{ data: value, mode: 'byte' }], { errorCorrectionLevel: 'M' }); }
    catch { throw new Error('El valor no cabe en un código QR.'); }
    const size = symbol.modules.size;
    const scale = Math.floor(AREA.width / (size + 8));
    if (scale < 3) throw new Error('El valor es demasiado largo para el espacio de esta plantilla.');
    const template = await loadTemplate();
    if (template.naturalWidth !== 900 || template.naturalHeight !== 1600) throw new Error('La plantilla no tiene las dimensiones esperadas.');

    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 1600;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(template, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(AREA.left, AREA.top, AREA.width, AREA.height);
    const qrSize = (size + 8) * scale;
    const offset = Math.floor((AREA.width - qrSize) / 2);
    const originX = AREA.left + offset + 4 * scale;
    const originY = AREA.top + offset + 4 * scale;
    ctx.fillStyle = '#000000';
    const data = symbol.modules.data;
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (data[row * size + col]) ctx.fillRect(originX + col * scale, originY + row * scale, scale, scale);
      }
    }

    // Verifica la imagen final, como hace el servidor.
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
    if (decoded?.data !== value) throw new Error('No se pudo verificar el contenido del QR generado.');
    return canvas.toDataURL('image/png');
  }

  byId('lookup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action('lookup', async () => {
      const key = byId('lookup-key').value;
      byId('lookup-result').hidden = true;
      if (!key.length) throw new Error('Escribe una key para consultar.');
      if (!key.trim() || key.length > 200) throw new Error('Escribe una clave de hasta 200 caracteres.');
      feedback('lookup-feedback', 'Consultando el diccionario…');
      const index = await loadDictionary();
      const result = index.get(normalizeKey(key));
      if (!result) {
        feedback('lookup-feedback', 'No se encontró esa key. Comprueba que coincida exactamente con el archivo.');
        return;
      }
      const imageDataUrl = await renderQrCard(result.value);
      byId('result-key').textContent = String(result.key ?? key);
      byId('result-image').src = imageDataUrl;
      byId('lookup-result').hidden = false;
      feedback('lookup-feedback', 'QR verificado. Esta es la imagen que se enviará por WhatsApp.', 'success');
    }, 'lookup-feedback');
  });

  function updateOnlineLabel() {
    byId('offline-tag').lastChild.textContent = navigator.onLine ? ' Funciona sin internet' : ' Sin internet';
  }
  window.addEventListener('online', updateOnlineLabel);
  window.addEventListener('offline', updateOnlineLabel);
  updateOnlineLabel();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
    });
  }
})();
