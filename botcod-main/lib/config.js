'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function validateConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('La configuración no es válida.');
  if (!['self', 'allowed'].includes(data.mode)) throw new Error('El modo de consulta no es válido.');
  if (typeof data.dictionaryPath !== 'string' || !path.isAbsolute(data.dictionaryPath) || !data.dictionaryPath.toLowerCase().endsWith('.json')) {
    throw new Error('Indica la ruta completa de un archivo .json.');
  }
  if (!Array.isArray(data.allowedNumbers)) throw new Error('Indica los números autorizados.');
  const allowedNumbers = [...new Set(data.allowedNumbers.map(number => {
    if (typeof number !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(number.trim())) throw new Error('Usa el número completo con código de país, sin espacios.');
    return number.trim().replace(/^\+/, '');
  }))];
  if (data.mode === 'allowed' && !allowedNumbers.length) throw new Error('Debes autorizar al menos un número de consulta.');
  if (typeof data.enabled !== 'boolean') throw new Error('El estado del bot no es válido.');
  if (!Number.isInteger(data.port) || data.port < 1024 || data.port > 65535) throw new Error('El puerto no es válido.');
  return { dictionaryPath: path.resolve(data.dictionaryPath), mode: data.mode, allowedNumbers, enabled: data.enabled, port: data.port };
}
async function loadConfig(file) {
  return validateConfig(JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')));
}
async function saveConfig(file, data) {
  const next = validateConfig(data);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
  return next;
}
module.exports = { validateConfig, loadConfig, saveConfig };
