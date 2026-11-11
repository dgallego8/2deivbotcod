'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { loadConfig, saveConfig } = require('./config');
const { Dictionary } = require('./dictionary');

function settings(env = process.env) {
  if (!env.PANEL_USER || !env.PANEL_PASSWORD || env.PANEL_PASSWORD.length < 16) throw new Error('Define PANEL_USER y PANEL_PASSWORD (mínimo 16 caracteres) en Railway.');
  const origin = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null);
  if (!origin) throw new Error('Genera un dominio en Railway o define PUBLIC_URL.');
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('El panel público requiere HTTPS.');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT no válido.');
  return { origin: url.origin, host: url.host, port, data: path.resolve(env.BOT_DATA_DIR || '/data'), user: env.PANEL_USER, password: env.PANEL_PASSWORD };
}
function same(a, b) {
  const hash = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}
function authorized(header, cloud) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const value = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = value.indexOf(':');
  if (separator < 0) return false;
  const userOK = same(value.slice(0, separator), cloud.user);
  const passwordOK = same(value.slice(separator + 1), cloud.password);
  return userOK && passwordOK;
}
async function bootstrap(root, cloud) {
  await fs.mkdir(cloud.data, { recursive: true });
  const dictionaryPath = path.join(cloud.data, 'payloads_generados.json');
  const configPath = path.join(cloud.data, 'config.json');
  try { await fs.access(dictionaryPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await new Dictionary(dictionaryPath).save(await new Dictionary(path.join(root, 'data', 'payloads_generados.json')).read());
  }
  let config;
  try { config = await loadConfig(configPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { dictionaryPath, mode: 'allowed', allowedNumbers: ['573024849179'], enabled: true, port: cloud.port };
  }
  config = await saveConfig(configPath, { ...config, dictionaryPath, port: cloud.port });
  await new Dictionary(dictionaryPath).read();
  return { configPath, config };
}
module.exports = { settings, authorized, bootstrap };
