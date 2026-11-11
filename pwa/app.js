'use strict';

// Versión estática del "Haz una consulta aquí" del panel (botcod-main/public/ui.js).
// Replica en el navegador lo que hacen botcod-main/lib/dictionary.js (búsqueda y validación)
// y botcod-main/lib/qr-card.js (plantilla + QR) en el servidor.
(() => {
  const byId = (id) => document.getElementById(id);
  const DICTIONARY_URL = 'data/payloads_generados.json';
  const TEMPLATE_URL = 'assets/plantilla-original.jpeg';
  const AREA = { left: 184, top: 450, width: 526, height: 526 };
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_VALUE_LENGTH = 3500;
  const RESPONSE_PREFIX = '🤖 ';
  const pending = new Set();
  let dictionaryPromise = null;
  let templatePromise = null;
  let lastResult = null;

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
    byId('upload-button').disabled = pending.has('upload');
    byId('upload-button').textContent = pending.has('upload') ? 'Cargando…' : 'Cargar JSON';
    byId('reset-button').disabled = pending.has('upload');
    byId('share-button').disabled = pending.has('share');
  }

  async function action(name, work, errorFeedback) {
    if (pending.has(name)) return;
    pending.add(name);
    updateControls();
    try { await work(); }
    catch (error) { feedback(errorFeedback, error.message || 'No se pudo completar la operación.', 'error'); }
    finally { pending.delete(name); updateControls(); }
  }

  // ---------- Diccionario guardado en este dispositivo (IndexedDB) ----------
  const DB_NAME = 'mi-bot';
  const STORE = 'dictionary';
  const LOCAL_ID = 'local';

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbRequest(mode, run) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('No se pudo usar el almacenamiento del dispositivo.'));
      });
    } finally { db.close(); }
  }

  const readLocal = () => dbRequest('readonly', (store) => store.get(LOCAL_ID)).catch(() => undefined);
  const saveLocal = (record) => dbRequest('readwrite', (store) => store.put(record, LOCAL_ID));
  const deleteLocal = () => dbRequest('readwrite', (store) => store.delete(LOCAL_ID));

  // ---------- Validación (igual que validateDictionary() en lib/dictionary.js) ----------
  function assertJsonValue(value) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object') throw new Error('Los valores deben ser texto, números finitos, booleanos o datos JSON.');
    for (const item of Object.values(value)) assertJsonValue(item);
  }

  function parseDictionary(source) {
    let data;
    try { data = JSON.parse(source.replace(/^﻿/, '')); }
    catch { throw new Error('El archivo del diccionario no contiene JSON válido.'); }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('El diccionario debe ser un objeto JSON de claves y valores.');
    }
    assertJsonValue(data);
    const index = new Map();
    for (const [key, value] of Object.entries(data)) {
      const normalized = normalizeKey(key);
      if (!normalized) throw new Error('El diccionario no puede contener claves vacías.');
      if (key.normalize('NFC').trimStart().startsWith(RESPONSE_PREFIX)) {
        throw new Error('Las claves no pueden empezar con el prefijo reservado «🤖 ».');
      }
      if (index.has(normalized)) throw new Error(`Hay claves repetidas al ignorar mayúsculas y espacios: «${key}».`);
      const rendered = renderValue(value);
      if (rendered.length > MAX_VALUE_LENGTH) {
        throw new Error(`El valor de «${key}» supera el máximo de ${MAX_VALUE_LENGTH} caracteres.`);
      }
      index.set(normalized, { key, value: rendered });
    }
    return index;
  }

  async function loadPublished() {
    let response;
    try { response = await fetch(DICTIONARY_URL); }
    catch { throw new Error('No se pudo leer el diccionario. Abre la app una vez con internet para guardarlo.'); }
    if (!response.ok) throw new Error('No se encontró el archivo del diccionario.');
    return { index: parseDictionary(await response.text()), source: 'published' };
  }

  function loadDictionary() {
    if (!dictionaryPromise) {
      dictionaryPromise = (async () => {
        const local = await readLocal();
        if (local?.text) {
          try { return { index: parseDictionary(local.text), source: 'local', name: local.name, savedAt: local.savedAt }; }
          catch { /* Si lo guardado se dañó, usa el publicado. */ }
        }
        return loadPublished();
      })();
      dictionaryPromise.catch(() => { dictionaryPromise = null; });
    }
    return dictionaryPromise;
  }

  async function showDictionaryInfo() {
    const info = byId('dictionary-count').closest('.dictionary-info');
    try {
      const dictionary = await loadDictionary();
      byId('dictionary-count').textContent = `${dictionary.index.size.toLocaleString('es-CO')} keys disponibles`;
      if (dictionary.source === 'local') {
        const date = new Date(dictionary.savedAt);
        const when = Number.isNaN(date.getTime()) ? '' : ` · ${date.toLocaleString('es-CO')}`;
        byId('dictionary-detail').textContent = `Cargado en este dispositivo: ${dictionary.name || 'archivo JSON'}${when}`;
      } else {
        byId('dictionary-detail').textContent = 'Diccionario publicado en GitHub';
      }
      byId('reset-button').hidden = dictionary.source !== 'local';
      info.dataset.error = 'false';
    } catch (error) {
      byId('dictionary-count').textContent = 'No se pudo leer el archivo';
      byId('dictionary-detail').textContent = error.message;
      info.dataset.error = 'true';
    }
  }

  byId('upload-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action('upload', async () => {
      const file = byId('dictionary-file').files[0];
      if (!file) throw new Error('Selecciona un diccionario JSON.');
      if (file.size > MAX_FILE_BYTES) throw new Error('El diccionario supera el máximo de 10 MiB.');
      feedback('upload-feedback', 'Leyendo el archivo…');
      const text = await file.text();
      const index = parseDictionary(text);
      await saveLocal({ text, name: file.name, savedAt: new Date().toISOString() });
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      dictionaryPromise = null;
      byId('dictionary-file').value = '';
      byId('lookup-result').hidden = true;
      await showDictionaryInfo();
      feedback('upload-feedback', `Diccionario cargado: ${index.size.toLocaleString('es-CO')} keys. Las consultas usarán este archivo.`, 'success');
    }, 'upload-feedback');
  });

  byId('reset-button').addEventListener('click', () => action('upload', async () => {
    await deleteLocal();
    dictionaryPromise = null;
    byId('lookup-result').hidden = true;
    await showDictionaryInfo();
    feedback('upload-feedback', 'Se volvió a usar el diccionario publicado.', 'success');
  }, 'upload-feedback'));

  // ---------- Plantilla + QR ----------
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
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('No se pudo crear la imagen.'))), 'image/png');
    });
    return blob;
  }

  byId('lookup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action('lookup', async () => {
      const key = byId('lookup-key').value;
      byId('lookup-result').hidden = true;
      if (!key.length) throw new Error('Escribe una key para consultar.');
      if (!key.trim() || key.length > 200) throw new Error('Escribe una clave de hasta 200 caracteres.');
      feedback('lookup-feedback', 'Consultando el diccionario…');
      const { index } = await loadDictionary();
      const result = index.get(normalizeKey(key));
      if (!result) {
        feedback('lookup-feedback', 'No se encontró esa key. Comprueba que coincida exactamente con el archivo.');
        return;
      }
      const blob = await renderQrCard(result.value);
      const image = byId('result-image');
      if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
      image.src = URL.createObjectURL(blob);
      lastResult = { key: result.key, blob };
      byId('result-key').textContent = String(result.key ?? key);
      byId('lookup-result').hidden = false;
      feedback('share-feedback', '');
      feedback('lookup-feedback', 'QR verificado. Esta es la imagen que se enviará por WhatsApp.', 'success');
    }, 'lookup-feedback');
  });

  // ---------- Compartir imagen ----------
  byId('share-button').addEventListener('click', () => action('share', async () => {
    if (!lastResult) return;
    const safeKey = lastResult.key.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'qr';
    const file = new File([lastResult.blob], `qr-${safeKey}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); }
      catch (error) { if (error.name !== 'AbortError') throw new Error('No se pudo compartir la imagen.'); }
      return;
    }
    // Navegadores sin menú de compartir: descarga la imagen.
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    feedback('share-feedback', 'Imagen descargada.', 'success');
  }, 'share-feedback'));

  // ---------- Estado de conexión y service worker ----------
  function updateOnlineLabel() {
    byId('offline-tag').lastChild.textContent = navigator.onLine ? ' Funciona sin internet' : ' Sin internet';
  }
  window.addEventListener('online', updateOnlineLabel);
  window.addEventListener('offline', updateOnlineLabel);
  updateOnlineLabel();
  updateControls();
  showDictionaryInfo();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
    });
  }
})();
