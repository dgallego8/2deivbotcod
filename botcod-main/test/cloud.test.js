'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { settings, authorized, bootstrap } = require('../lib/cloud');
const { Dictionary } = require('../lib/dictionary');
test('panel refuses missing credentials, weak passwords and public HTTP', () => {
  assert.throws(() => settings({}), /PANEL_USER/);
  assert.throws(() => settings({ PANEL_USER:'santi', PANEL_PASSWORD:'abcdefghijklmnop', PUBLIC_URL:'http://example.com' }), /HTTPS/);
  const cloud = settings({ PANEL_USER:'santi', PANEL_PASSWORD:'abcdefghijklmnop', RAILWAY_PUBLIC_DOMAIN:'bot.up.railway.app' });
  assert.equal(cloud.origin, 'https://bot.up.railway.app');
  const header = value => 'Basic ' + Buffer.from(value).toString('base64');
  assert.equal(authorized(undefined, cloud), false);
  assert.equal(authorized(header('santi:incorrecta'), cloud), false);
  assert.equal(authorized(header('otro:abcdefghijklmnop'), cloud), false);
  assert.equal(authorized(header('santi:abcdefghijklmnop'), cloud), true);
});
test('restart preserves uploaded dictionary and paused state in volume', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-test-'));
  try {
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root,'data','payloads_generados.json'), '{"150000":"original"}');
    const cloud = { data:path.join(root,'volume'), port:8080 };
    const first = await bootstrap(root, cloud);
    await new Dictionary(first.config.dictionaryPath).save({150000:'actualizado'});
    await fs.writeFile(first.configPath, JSON.stringify({...first.config,enabled:false}));
    const restarted = await bootstrap(root, {...cloud,port:9090});
    assert.equal((await new Dictionary(restarted.config.dictionaryPath).lookup('150000')).value, 'actualizado');
    assert.equal(restarted.config.enabled, false);
    assert.equal(restarted.config.port, 9090);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});
