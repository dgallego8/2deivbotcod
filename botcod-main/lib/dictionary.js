'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_VALUE_LENGTH = 3500;
const RESPONSE_PREFIX = '🤖 ';

function invalid(message, code = 'DICTIONARY_INVALID') {
  return Object.assign(new Error(message), { code });
}

function normalizeKey(key) {
  return key.normalize('NFC').trim().toLowerCase().normalize('NFC');
}

function assertJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) {
    throw invalid('Los valores deben ser texto, números finitos, booleanos o datos JSON.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw invalid('Los objetos del diccionario deben contener únicamente datos JSON.');
  }
  if (ancestors.has(value)) throw invalid('El diccionario no puede contener referencias circulares.');
  if (Object.getOwnPropertySymbols(value).length) {
    throw invalid('El diccionario no puede contener propiedades de tipo símbolo.');
  }
  ancestors.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, 'value')) {
      throw invalid('El diccionario no puede contener propiedades calculadas.');
    }
    assertJsonValue(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function renderValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function validateDictionary(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw invalid('El diccionario debe ser un objeto JSON de claves y valores.');
  }
  const prototype = Object.getPrototypeOf(data);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid('El diccionario debe ser un objeto JSON sencillo.');
  }
  assertJsonValue(data);
  const keys = new Set();
  for (const [key, value] of Object.entries(data)) {
    const normalized = normalizeKey(key);
    if (!normalized) throw invalid('El diccionario no puede contener claves vacías.');
    if (key.normalize('NFC').trimStart().startsWith(RESPONSE_PREFIX)) {
      throw invalid('Las claves no pueden empezar con el prefijo reservado «🤖 ».');
    }
    if (keys.has(normalized)) {
      throw invalid(`Hay claves repetidas al ignorar mayúsculas y espacios: «${key}».`);
    }
    keys.add(normalized);
    const rendered = renderValue(value);
    if (rendered.length > MAX_VALUE_LENGTH) {
      throw invalid(`El valor de «${key}» supera el máximo de ${MAX_VALUE_LENGTH} caracteres.`);
    }
  }
  return data;
}

function parseDictionary(source) {
  let data;
  try {
    data = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    throw invalid('El archivo del diccionario no contiene JSON válido.');
  }
  return validateDictionary(data);
}

async function readSource(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const info = await handle.stat();
    if (!info.isFile()) throw invalid('La ruta del diccionario debe ser un archivo.');
    if (info.size > MAX_FILE_BYTES) {
      throw invalid('El diccionario supera el máximo de 10 MiB.', 'DICTIONARY_TOO_LARGE');
    }
    // Bound the read as well as the stat, in case an external editor grows the file.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) {
      throw invalid('El diccionario supera el máximo de 10 MiB.', 'DICTIONARY_TOO_LARGE');
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') error.message = 'No se encontró el archivo del diccionario.';
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function atomicWrite(filePath, content) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

class Dictionary {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw invalid('Indica una ruta válida para el diccionario.');
    }
    this.filePath = path.resolve(filePath);
    this._saveTail = Promise.resolve();
  }

  async read() {
    return parseDictionary(await readSource(this.filePath));
  }

  async lookup(key) {
    if (typeof key !== 'string') throw invalid('La clave de consulta debe ser texto.');
    const normalized = normalizeKey(key);
    const data = await this.read();
    for (const [originalKey, value] of Object.entries(data)) {
      if (normalizeKey(originalKey) === normalized) {
        return { found: true, key: originalKey, value: renderValue(value) };
      }
    }
    return { found: false };
  }

  async save(data) {
    validateDictionary(data);
    // Snapshot before awaiting, so the caller cannot mutate an in-flight save.
    const content = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw invalid('El diccionario supera el máximo de 10 MiB.', 'DICTIONARY_TOO_LARGE');
    }
    const snapshot = parseDictionary(content);
    const operation = this._saveTail.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      let previous;
      try {
        previous = await readSource(this.filePath);
        parseDictionary(previous);
      } catch (error) {
        if (!['ENOENT', 'DICTIONARY_INVALID', 'DICTIONARY_TOO_LARGE'].includes(error.code)) throw error;
        previous = undefined;
      }
      if (previous !== undefined) await atomicWrite(`${this.filePath}.bak`, previous);
      await atomicWrite(this.filePath, content);
      return snapshot;
    });
    // Keep subsequent writes usable after a failed operation.
    this._saveTail = operation.catch(() => {});
    return operation;
  }
}

module.exports = { Dictionary, validateDictionary, MAX_FILE_BYTES, MAX_VALUE_LENGTH };
