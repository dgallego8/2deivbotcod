'use strict';

// Versión estática del "Haz una consulta aquí" del panel (botcod-main/public/ui.js).
// Replica en el navegador lo que hacen botcod-main/lib/dictionary.js (búsqueda y validación)
// y botcod-main/lib/qr-card.js (plantilla + QR) en el servidor.
(() => {
  const byId = (id) => document.getElementById(id);
  const DICTIONARY_URL = 'data/payloads_generados.json';
  const ACCESS_URL = 'data/acceso.json';
  // Plantilla redibujada en alta resolución (el doble de botcod-main/assets/plantilla-original.jpeg).
  const TEMPLATE_URL = 'assets/plantilla-hd.png';
  const SCALE = 2;
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
    byId('lock-button').disabled = pending.has('unlock');
    byId('lock-button').textContent = pending.has('unlock') ? 'Abriendo…' : 'Entrar';
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

  const ACCESS_ID = 'access';
  const readRecord = (id) => dbRequest('readonly', (store) => store.get(id)).catch(() => undefined);
  const saveRecord = (id, record) => dbRequest('readwrite', (store) => store.put(record, id));
  const deleteRecord = (id) => dbRequest('readwrite', (store) => store.delete(id));
  const readLocal = () => readRecord(LOCAL_ID);
  const saveLocal = (record) => saveRecord(LOCAL_ID, record);
  const deleteLocal = () => deleteRecord(LOCAL_ID);

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

  // ---------- Contraseña de acceso (en el sitio solo se publica su hash) ----------
  const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

  async function fetchAccess() {
    try {
      const response = await fetch(ACCESS_URL);
      if (!response.ok) return null;
      const file = await response.json();
      return file.v === 1 && file.salt && file.hash && file.iterations ? file : null;
    } catch { return null; }
  }

  async function hashPassword(password, access) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromBase64(access.salt), iterations: access.iterations, hash: 'SHA-256' }, material, 256);
    return toBase64(new Uint8Array(bits));
  }

  async function isUnlocked() {
    const local = await readLocal();
    if (local?.text) return true;
    const access = await fetchAccess();
    const saved = await readRecord(ACCESS_ID);
    // Sin archivo de contraseña (aún no configurada): la app queda abierta.
    if (!access) return true;
    return saved?.hash === access.hash;
  }

  async function unlock(password) {
    const access = await fetchAccess();
    if (!access) throw new Error('No se pudo leer la configuración de la contraseña. Abre la app con internet.');
    if (await hashPassword(password, access) !== access.hash) throw new Error('Contraseña incorrecta.');
    await saveRecord(ACCESS_ID, { hash: access.hash, savedAt: new Date().toISOString() });
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
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
      await start();
      feedback('upload-feedback', `Diccionario cargado: ${index.size.toLocaleString('es-CO')} keys. Las consultas usarán este archivo.`, 'success');
    }, 'upload-feedback');
  });

  byId('reset-button').addEventListener('click', () => action('upload', async () => {
    await deleteLocal();
    dictionaryPromise = null;
    byId('lookup-result').hidden = true;
    await start();
    if (!byId('main-cards').hidden) feedback('upload-feedback', 'Se volvió a usar el diccionario publicado.', 'success');
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
    // Mismo límite que el servidor (calculado a 900x1600); luego se dibuja al doble de resolución.
    if (Math.floor(AREA.width / (size + 8)) < 3) throw new Error('El valor es demasiado largo para el espacio de esta plantilla.');
    const template = await loadTemplate();
    if (template.naturalWidth !== 900 * SCALE || template.naturalHeight !== 1600 * SCALE) throw new Error('La plantilla no tiene las dimensiones esperadas.');

    const area = { left: AREA.left * SCALE, top: AREA.top * SCALE, width: AREA.width * SCALE, height: AREA.height * SCALE };
    const scale = Math.floor(area.width / (size + 8));
    const canvas = document.createElement('canvas');
    canvas.width = template.naturalWidth;
    canvas.height = template.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(template, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(area.left, area.top, area.width, area.height);
    const qrSize = (size + 8) * scale;
    const offset = Math.floor((area.width - qrSize) / 2);
    const originX = area.left + offset + 4 * scale;
    const originY = area.top + offset + 4 * scale;
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

  // ---------- Búsqueda flexible de montos ----------
  // Si la key exacta no existe, compara solo los dígitos: "150000", "$150,000" o "150 mil"
  // encuentran "150.000"; y un número corto como "150" se prueba también en miles.
  const digitIndexes = new WeakMap();
  const onlyDigits = (text) => text.replace(/\D/g, '');

  function digitIndex(index) {
    if (!digitIndexes.has(index)) {
      const map = new Map();
      const repeated = new Set();
      for (const entry of index.values()) {
        const digits = onlyDigits(entry.key);
        if (!digits) continue;
        if (map.has(digits)) repeated.add(digits);
        map.set(digits, entry);
      }
      for (const digits of repeated) map.delete(digits);
      digitIndexes.set(index, map);
    }
    return digitIndexes.get(index);
  }

  function findEntry(index, key) {
    const exact = index.get(normalizeKey(key));
    if (exact) return exact;
    const digits = onlyDigits(key).replace(/^0+/, '');
    if (!digits) return undefined;
    const map = digitIndex(index);
    return map.get(digits) || map.get(`${digits}000`);
  }

  function nearestKeys(index, key) {
    const digits = onlyDigits(key);
    if (!digits || digits.length > 15) return [];
    const target = Number(digits);
    const options = [];
    for (const [entryDigits, entry] of digitIndex(index)) {
      const value = Number(entryDigits);
      options.push({ key: entry.key, distance: Math.min(Math.abs(value - target), Math.abs(value - target * 1000)) });
    }
    return options.sort((a, b) => a.distance - b.distance).slice(0, 3).map((option) => option.key);
  }

  function showSuggestions(keys) {
    const box = byId('lookup-suggestions');
    box.replaceChildren(...keys.map((key) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-secondary';
      button.textContent = key;
      button.addEventListener('click', () => {
        byId('lookup-key').value = key;
        byId('lookup-form').requestSubmit();
      });
      return button;
    }));
    box.hidden = !keys.length;
  }

  // Teclado numérico cuando todas las keys son montos.
  async function updateKeyboard() {
    try {
      const { index } = await loadDictionary();
      let numeric = index.size > 0;
      for (const entry of index.values()) if (!/^[\d.,\s$]+$/.test(entry.key)) { numeric = false; break; }
      byId('lookup-key').inputMode = numeric ? 'numeric' : 'text';
    } catch { byId('lookup-key').inputMode = 'text'; }
  }

  byId('lookup-key').addEventListener('focus', (event) => event.target.select());

  // ---------- Mantener la pantalla encendida mientras se muestra el QR ----------
  let wakeLock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || wakeLock || byId('lookup-result').hidden) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  byId('lookup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action('lookup', async () => {
      const key = byId('lookup-key').value;
      byId('lookup-result').hidden = true;
      if (!key.length) throw new Error('Escribe una key para consultar.');
      if (!key.trim() || key.length > 200) throw new Error('Escribe una clave de hasta 200 caracteres.');
      feedback('lookup-feedback', 'Consultando el diccionario…');
      const { index } = await loadDictionary();
      showSuggestions([]);
      const result = findEntry(index, key);
      if (!result) {
        const near = nearestKeys(index, key);
        showSuggestions(near);
        feedback('lookup-feedback', near.length ? 'No se encontró esa key. Las más cercanas son:' : 'No se encontró esa key. Comprueba que coincida exactamente con el archivo.');
        return;
      }
      byId('lookup-key').value = result.key;
      const blob = await renderQrCard(result.value);
      const image = byId('result-image');
      if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
      image.src = URL.createObjectURL(blob);
      lastResult = { key: result.key, blob };
      byId('result-key').textContent = String(result.key ?? key);
      byId('lookup-result').hidden = false;
      byId('lookup-key').blur();
      keepAwake();
      requestAnimationFrame(() => byId('lookup-result').scrollIntoView({ behavior: 'smooth', block: 'start' }));
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

  // ---------- Pantalla de contraseña ----------
  async function start() {
    const open = await isUnlocked();
    byId('lock-card').hidden = open;
    byId('main-cards').hidden = !open;
    if (open) { await showDictionaryInfo(); await updateKeyboard(); }
  }

  const ATTEMPTS_KEY = 'mi-bot-intentos';
  function attempts() {
    try { return { count: 0, until: 0, ...JSON.parse(localStorage.getItem(ATTEMPTS_KEY)) }; }
    catch { return { count: 0, until: 0 }; }
  }
  function saveAttempts(value) {
    try { value ? localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(value)) : localStorage.removeItem(ATTEMPTS_KEY); }
    catch { /* Sin almacenamiento: no se limita. */ }
  }

  byId('lock-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action('unlock', async () => {
      const password = byId('lock-password').value;
      if (!password) throw new Error('Escribe la contraseña.');
      const wait = Math.ceil((attempts().until - Date.now()) / 1000);
      if (wait > 0) throw new Error(`Demasiados intentos. Espera ${wait} s y vuelve a probar.`);
      feedback('lock-feedback', 'Abriendo el diccionario…');
      try { await unlock(password); }
      catch (error) {
        if (error.message === 'Contraseña incorrecta.') {
          const count = attempts().count + 1;
          // Desde el tercer fallo: 5 s, 10 s, 20 s… hasta 5 minutos.
          const delay = count >= 3 ? Math.min(5000 * 2 ** (count - 3), 300000) : 0;
          saveAttempts({ count, until: Date.now() + delay });
        }
        throw error;
      }
      saveAttempts(null);
      byId('lock-password').value = '';
      feedback('lock-feedback', '');
      await start();
    }, 'lock-feedback');
  });

  byId('lock-now-button').addEventListener('click', () => action('lock', async () => {
    await Promise.all([deleteRecord(ACCESS_ID), deleteLocal()]);
    dictionaryPromise = null;
    lastResult = null;
    byId('lookup-result').hidden = true;
    feedback('upload-feedback', '');
    await start();
  }, 'upload-feedback'));

  // ---------- Estado de conexión y service worker ----------
  function updateOnlineLabel() {
    byId('offline-tag').lastChild.textContent = navigator.onLine ? ' Funciona sin internet' : ' Sin internet';
  }
  window.addEventListener('online', updateOnlineLabel);
  window.addEventListener('offline', updateOnlineLabel);
  updateOnlineLabel();
  updateControls();
  start();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
    });
  }
})();
