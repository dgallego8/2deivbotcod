'use strict';

// App estática: escribe un monto y genera la tarjeta con su QR de pago.
// Parte de un único "código base" (pwa/data/codigo-base.txt): un código EMV en el que
// solo cambian el monto (campo 54) y el CRC16 final (campo 63).
(() => {
  const byId = (id) => document.getElementById(id);
  const BASE_URL = 'data/codigo-base.txt';
  const ACCESS_URL = 'data/acceso.json';
  // Plantilla propia de la app, a 1800x3200 (el doble de las medidas de AREA y NAME).
  const TEMPLATE_URL = 'assets/plantilla-hd.png';
  const SCALE = 2;
  const AREA = { left: 187, top: 420, width: 526, height: 526 };
  // Nombre del comercio, escrito por la app debajo de «PAGAS A».
  const NAME = { centerX: 450, baseline: 1140, maxWidth: 600, size: 44, minSize: 24, color: '#2a0b52' };
  const FONT_URL = 'assets/fonts/montserrat-700.woff2';
  const MIN_AMOUNT = 1000;
  // Un número menor que esto se entiende en miles: "150" es 150.000.
  const SHORTHAND_BELOW = 1000;
  const MAX_AMOUNT = 3000000;
  const pending = new Set();
  let accountsPromise = null;
  let templatePromise = null;
  let lastResult = null;

  function feedback(id, message, tone = '') {
    const element = byId(id);
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function updateControls() {
    byId('lookup-button').disabled = pending.has('lookup');
    byId('lookup-button').textContent = pending.has('lookup') ? 'Generando…' : 'Consultar';
    byId('base-button').disabled = pending.has('base');
    byId('base-button').textContent = pending.has('base') ? 'Guardando…' : 'Guardar cuenta';
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

  // ---------- Datos guardados en este dispositivo (IndexedDB) ----------
  const DB_NAME = 'mi-bot';
  const STORE = 'dictionary';
  const BASE_ID = 'base'; // versión anterior (un solo código); se migra a ACCOUNTS_ID
  const ACCOUNTS_ID = 'accounts';
  const ACCESS_ID = 'access';

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

  const readRecord = (id) => dbRequest('readonly', (store) => store.get(id)).catch(() => undefined);
  const saveRecord = (id, record) => dbRequest('readwrite', (store) => store.put(record, id));
  const deleteRecord = (id) => dbRequest('readwrite', (store) => store.delete(id));

  // ---------- Código EMV: campos "id + longitud + valor" ----------
  const onlyDigits = (text) => text.replace(/\D/g, '');
  const formatAmount = (amount) => String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  function crc16(text) {
    let crc = 0xFFFF;
    for (const byte of new TextEncoder().encode(text)) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  // Revisa un código y dice hasta dónde llegó: 0 estructura, 1 final, 2 verificación, 3 monto, 4 correcto.
  function analyze(payload) {
    const fields = [];
    let position = 0;
    while (position < payload.length) {
      const id = payload.slice(position, position + 2);
      const lengthText = payload.slice(position + 2, position + 4);
      const length = Number(lengthText);
      if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lengthText) || position + 4 + length > payload.length) {
        return { stage: 0, message: 'Ese texto no es un código de pago QR válido. Revisa que esté completo y sin espacios ni saltos de línea de más.' };
      }
      fields.push({ id, value: payload.slice(position + 4, position + 4 + length) });
      position += 4 + length;
    }
    const last = fields[fields.length - 1];
    if (!last || last.id !== '63' || last.value.length !== 4) return { stage: 1, message: 'El código no termina con su campo de verificación.' };
    if (crc16(payload.slice(0, -4)) !== last.value.toUpperCase()) {
      return { stage: 2, message: 'El código está incompleto o alterado: su verificación no coincide. Léelo desde la imagen del QR para evitar errores al copiar.' };
    }
    if (!fields.some((field) => field.id === '54')) return { stage: 3, message: 'El código no tiene un monto que se pueda cambiar. Usa uno generado con un valor.' };
    return { stage: 4, payload, fields };
  }

  // Devuelve los campos del código o lanza un error que explica qué está mal.
  function parseBase(text) {
    const payload = String(text).replace(/^\uFEFF/, '').trim();
    if (!payload) throw new Error('El código está vacío.');
    let best = analyze(payload);
    if (best.stage < 4 && /\s/.test(payload)) {
      // Un espacio o salto de línea de más (típico al copiar) se prueba quitándolo; solo se
      // acepta si el código resultante pasa la verificación.
      for (let index = 0; index < payload.length; index++) {
        if (!/\s/.test(payload[index])) continue;
        const attempt = analyze(payload.slice(0, index) + payload.slice(index + 1));
        if (attempt.stage === 4) { best = attempt; break; }
        if (attempt.stage > best.stage) best = attempt;
      }
    }
    if (best.stage < 4) throw new Error(best.message);
    return { payload: best.payload, fields: best.fields, merchant: best.fields.find((field) => field.id === '59')?.value.trim() || 'Comercio sin nombre' };
  }

  // El monto se escribe con el mismo formato que trae el código base: si el original lleva
  // decimales ("970000.00"), el nuevo también ("150000.00"); si no ("150000"), sin ellos.
  function amountText(fields, amount) {
    const original = fields.find((field) => field.id === '54')?.value || '';
    return /^\d+\.\d{2}$/.test(original) ? `${amount}.00` : String(amount);
  }

  function buildCode(fields, amount) {
    const body = fields.slice(0, -1).map((field) => {
      const value = field.id === '54' ? amountText(fields, amount) : field.value;
      return field.id + String(value.length).padStart(2, '0') + value;
    }).join('') + '6304';
    return body + crc16(body);
  }

  // ---------- Cuentas (códigos base) ----------
  // La cuenta publicada (pwa/data/codigo-base.txt) siempre está; además se pueden guardar otras
  // en este dispositivo y elegir con cuál cobrar.
  const PUBLISHED = 'published';

  function subfield(fields, id, subId) {
    const field = fields.find((item) => item.id === id);
    if (!field) return '';
    let position = 0;
    while (position + 4 <= field.value.length) {
      const length = Number(field.value.slice(position + 2, position + 4));
      if (!Number.isInteger(length)) return '';
      if (field.value.slice(position, position + 2) === subId) return field.value.slice(position + 4, position + 4 + length);
      position += 4 + length;
    }
    return '';
  }

  // Nombre del comercio y los últimos 4 dígitos de su cuenta, para distinguir cuentas con el mismo nombre.
  function accountLabel(account) {
    const tag = onlyDigits(subfield(account.fields, '50', '01')).slice(-4);
    return tag ? `${account.merchant} · …${tag}` : account.merchant;
  }

  async function readAccountsRecord() {
    let record = await readRecord(ACCOUNTS_ID);
    if (!record) {
      record = { saved: [], selected: PUBLISHED };
      const old = await readRecord(BASE_ID); // versión de un solo código
      if (old?.code) {
        const id = `cuenta-${Date.now()}`;
        record = { saved: [{ id, code: old.code, savedAt: old.savedAt }], selected: id };
        await saveRecord(ACCOUNTS_ID, record);
      }
      if (old) await deleteRecord(BASE_ID);
    }
    return record;
  }

  function loadAccounts() {
    if (!accountsPromise) {
      accountsPromise = (async () => {
        const record = await readAccountsRecord();
        const list = [];
        let publishedError = null;
        try {
          let response;
          try { response = await fetch(BASE_URL); }
          catch { throw new Error('No se pudo leer el código base. Abre la app una vez con internet para guardarlo.'); }
          if (!response.ok) throw new Error('No se encontró el código base publicado (pwa/data/codigo-base.txt).');
          list.push({ id: PUBLISHED, source: 'published', ...parseBase(await response.text()) });
        } catch (error) { publishedError = error; }
        for (const item of record.saved) {
          try { list.push({ id: item.id, source: 'local', savedAt: item.savedAt, ...parseBase(item.code) }); }
          catch { /* Una cuenta guardada que se dañó se omite. */ }
        }
        if (!list.length) throw publishedError || new Error('No hay ninguna cuenta disponible.');
        for (const account of list) account.label = accountLabel(account);
        const current = list.find((account) => account.id === record.selected) || list[0];
        return { list, current, record };
      })();
      accountsPromise.catch(() => { accountsPromise = null; });
    }
    return accountsPromise;
  }

  async function loadBase() { return (await loadAccounts()).current; }

  async function writeAccounts(record) {
    await saveRecord(ACCOUNTS_ID, record);
    accountsPromise = null;
    byId('lookup-result').hidden = true;
    await showBaseInfo();
  }

  async function selectAccount(id) {
    const { record } = await loadAccounts();
    await writeAccounts({ ...record, selected: id });
  }

  async function removeAccount(id) {
    const { record } = await loadAccounts();
    await writeAccounts({ saved: record.saved.filter((item) => item.id !== id), selected: record.selected === id ? PUBLISHED : record.selected });
  }

  function accountButton(text, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-quiet';
    button.textContent = text;
    button.setAttribute('aria-label', `${text} ${label}`);
    button.addEventListener('click', onClick);
    return button;
  }

  function accountRow(account, selected) {
    const row = document.createElement('div');
    row.className = 'dictionary-info';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'QR';
    const body = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = account.label;
    const detail = document.createElement('span');
    const date = new Date(account.savedAt);
    const when = account.source === 'local' && !Number.isNaN(date.getTime()) ? ` · ${date.toLocaleDateString('es-CO')}` : '';
    detail.textContent = (account.source === 'published' ? 'Publicada en GitHub' : `Guardada en este dispositivo${when}`) + (selected ? ' · En uso' : '');
    const actions = document.createElement('div');
    actions.className = 'account-actions';
    if (!selected) actions.append(accountButton('Usar', account.label, () => action('base', () => selectAccount(account.id), 'base-feedback')));
    if (account.source === 'local') {
      actions.append(accountButton('Quitar', account.label, () => action('base', async () => {
        if (!window.confirm(`¿Quitar «${account.label}» de este dispositivo?`)) return;
        await removeAccount(account.id);
        feedback('base-feedback', 'Cuenta quitada.', 'success');
      }, 'base-feedback')));
    }
    body.append(name, detail, actions);
    row.append(icon, body);
    return row;
  }

  async function showBaseInfo() {
    const box = byId('account-list');
    const picker = byId('account-picker');
    try {
      const { list, current } = await loadAccounts();
      box.replaceChildren(...list.map((account) => accountRow(account, account.id === current.id)));
      const select = byId('account-select');
      select.replaceChildren(...list.map((account) => {
        const option = document.createElement('option');
        option.value = account.id;
        option.textContent = account.label;
        return option;
      }));
      select.value = current.id;
      picker.hidden = list.length < 2;
    } catch (error) {
      const row = document.createElement('div');
      row.className = 'dictionary-info';
      row.dataset.error = 'true';
      const body = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = 'No se pudo leer el código base';
      const detail = document.createElement('span');
      detail.textContent = error.message;
      body.append(name, detail);
      row.append(body);
      box.replaceChildren(row);
      picker.hidden = true;
    }
  }

  byId('account-select').addEventListener('change', (event) => {
    action('base', () => selectAccount(event.target.value), 'lookup-feedback');
  });

  // ---------- Agregar una cuenta ----------
  async function decodeImageFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('No se pudo abrir esa imagen.'));
        element.src = url;
      });
      // Prueba varios tamaños: las fotos grandes se leen mejor reducidas.
      for (const side of [1600, 1000, 2400, 700]) {
        const ratio = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = window.jsQR(pixels.data, pixels.width, pixels.height);
        if (found?.data) return found.data;
      }
      throw new Error('No se encontró un código QR en esa imagen.');
    } finally { URL.revokeObjectURL(url); }
  }

  byId('base-image').addEventListener('change', () => action('base', async () => {
    const file = byId('base-image').files[0];
    if (!file) return;
    feedback('base-feedback', 'Leyendo el QR de la imagen…');
    const code = await decodeImageFile(file);
    const base = parseBase(code);
    byId('base-code').value = base.payload;
    feedback('base-feedback', `QR leído: ${base.merchant}. Pulsa «Guardar cuenta» para añadirla.`, 'success');
  }, 'base-feedback').finally(() => { byId('base-image').value = ''; }));

  byId('base-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action('base', async () => {
      const base = parseBase(byId('base-code').value);
      const { list, record } = await loadAccounts();
      const existing = list.find((account) => account.payload === base.payload);
      byId('base-code').value = '';
      if (existing) {
        await writeAccounts({ ...record, selected: existing.id });
        feedback('base-feedback', `Esa cuenta ya estaba guardada (${existing.label}). Ahora está en uso.`, 'success');
        return;
      }
      const id = `cuenta-${Date.now()}`;
      await writeAccounts({ saved: [...record.saved, { id, code: base.payload, savedAt: new Date().toISOString() }], selected: id });
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      feedback('base-feedback', `Cuenta guardada: ${base.merchant}. Los QR nuevos se generan con ella; puedes cambiar de cuenta arriba, en «Cobrar a».`, 'success');
    }, 'base-feedback');
  });

  // ---------- Monto ----------
  // Acepta "150000", "150.500", "$ 99,999" o "75 mil". Un número corto se entiende en miles.
  function amountFrom(text) {
    if (!/^[\s$]*\d[\d.,\s]*(mil|k)?\s*$/i.test(text)) return null;
    const digits = onlyDigits(text).replace(/^0+/, '');
    if (!digits || digits.length > 9) return null;
    const amount = Number(digits);
    return amount < SHORTHAND_BELOW && amount * 1000 <= MAX_AMOUNT ? amount * 1000 : amount;
  }

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

  // Igual que renderQrCard() en botcod-main/lib/qr-card.js, dibujado en un <canvas>.
  let fontPromise = null;
  function loadFont() {
    if (!fontPromise) {
      fontPromise = (async () => {
        try {
          const face = new FontFace('MiBotTitulo', `url(${FONT_URL})`, { weight: '700' });
          document.fonts.add(await face.load());
          return 'MiBotTitulo';
        } catch { return null; }
      })();
    }
    return fontPromise;
  }

  async function drawMerchant(ctx, merchant) {
    const family = await loadFont();
    const stack = `${family ? `"${family}", ` : ''}-apple-system, "Helvetica Neue", Arial, sans-serif`;
    let size = NAME.size * SCALE;
    const setFont = () => { ctx.font = `700 ${size}px ${stack}`; };
    setFont();
    while (size > NAME.minSize * SCALE && ctx.measureText(merchant).width > NAME.maxWidth * SCALE) { size -= 2; setFont(); }
    let label = merchant;
    while (label.length > 4 && ctx.measureText(label).width > NAME.maxWidth * SCALE) label = `${label.slice(0, -2).trimEnd()}…`;
    ctx.fillStyle = NAME.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, NAME.centerX * SCALE, NAME.baseline * SCALE);
  }

  async function renderQrCard(value, merchant) {
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
    await drawMerchant(ctx, merchant);
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

    // Verifica la imagen final leyendo el QR ya dibujado.
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
    if (decoded?.data !== value) throw new Error('No se pudo verificar el contenido del QR generado.');
    return new Promise((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('No se pudo crear la imagen.'))), 'image/png');
    });
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
      const text = byId('lookup-key').value;
      byId('lookup-result').hidden = true;
      if (!text.trim()) throw new Error('Escribe un monto.');
      const amount = amountFrom(text);
      if (amount === null) throw new Error('Escribe el monto solo con números, por ejemplo 150000.');
      if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
        throw new Error(`Solo se generan montos entre $${formatAmount(MIN_AMOUNT)} y $${formatAmount(MAX_AMOUNT)}.`);
      }
      feedback('lookup-feedback', 'Generando el QR…');
      const base = await loadBase();
      const key = formatAmount(amount);
      const blob = await renderQrCard(buildCode(base.fields, amount), base.merchant);
      const image = byId('result-image');
      if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
      image.src = URL.createObjectURL(blob);
      lastResult = { key, blob };
      byId('lookup-key').value = key;
      byId('result-key').textContent = key;
      byId('lookup-result').hidden = false;
      byId('lookup-key').blur();
      keepAwake();
      requestAnimationFrame(() => byId('lookup-result').scrollIntoView({ behavior: 'smooth', block: 'start' }));
      feedback('share-feedback', '');
      feedback('lookup-feedback', `QR verificado para $${key}.`, 'success');
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
    const access = await fetchAccess();
    // Sin archivo de contraseña (aún no configurada): la app queda abierta.
    if (!access) return true;
    return (await readRecord(ACCESS_ID))?.hash === access.hash;
  }

  async function unlock(password) {
    const access = await fetchAccess();
    if (!access) throw new Error('No se pudo leer la configuración de la contraseña. Abre la app con internet.');
    if (await hashPassword(password, access) !== access.hash) throw new Error('Contraseña incorrecta.');
    await saveRecord(ACCESS_ID, { hash: access.hash, savedAt: new Date().toISOString() });
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  }

  async function start() {
    const open = await isUnlocked();
    byId('lock-card').hidden = open;
    byId('main-cards').hidden = !open;
    if (open) await showBaseInfo();
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
      feedback('lock-feedback', 'Abriendo…');
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
    await Promise.all([deleteRecord(ACCESS_ID), deleteRecord(ACCOUNTS_ID), deleteRecord(BASE_ID), deleteRecord('local')]);
    accountsPromise = null;
    lastResult = null;
    byId('lookup-result').hidden = true;
    feedback('base-feedback', '');
    await start();
  }, 'base-feedback'));

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
