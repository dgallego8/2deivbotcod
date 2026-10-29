'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMessageHandler } = require('../lib/router');

const START = 1_800_000_000_000;
const SELF = '573001234567@c.us';
const SELF_LID = '100000001234567890@lid';
const FRIEND = '573119876543@c.us';
const FRIEND_LID = '987654321111111111@lid';

test('QR mode sends media without sending the raw dictionary value as text', async () => {
 const media=[];
 const f=fixture({dependencies:{prepareValue:async value=>Buffer.from('rendered:'+value),sendValue:async(chatId,png)=>media.push({chatId,png})}});
 await f.handle(f.message());
 assert.equal(f.sends.length,0);
 assert.equal(media.length,1);
 assert.equal(media[0].png.toString(),'rendered:valor secreto');
 assert.equal(f.results.length,1);
});

test('pausing during image generation cancels the image send', async () => {
 let finish;
 const media=[];
 const f=fixture({dependencies:{prepareValue:()=>new Promise(resolve=>{finish=resolve;}),sendValue:async(...args)=>media.push(args)}});
 const pending=f.handle(f.message());
 await new Promise(resolve=>setImmediate(resolve));
 f.config.enabled=false;
 finish(Buffer.from('image'));
 await pending;
 assert.equal(media.length,0);
 assert.equal(f.sends.length,0);
});

test('image generation failure returns only a generic error, never the raw value', async () => {
 const f=fixture({dependencies:{prepareValue:async()=>{throw new Error('render failed');},sendValue:async()=>{throw new Error('should not send');}}});
 await f.handle(f.message());
 assert.equal(f.sends.length,1);
 assert.ok(!f.sends[0].text.includes('valor secreto'));
 assert.equal(f.results.length,0);
});

test('structured WhatsApp IDs without _serialized reply once, including concurrent events', async () => {
  const f = fixture({ config: { mode: 'allowed', allowedNumbers: ['573119876543'] }, dependencies: { resolvePhone: async () => FRIEND } });
  const msg = f.message({ id: { id: 'native-message-id', fromMe: false, remote: FRIEND_LID }, fromMe: false, from: FRIEND_LID, to: SELF });
  await Promise.all([f.handle(msg), f.handle(msg)]);
  assert.equal(f.sends.length, 1);
  f.advance();
  await f.handle(msg);
  assert.equal(f.sends.length, 1);
  await f.handle({...msg, id: {id: 'different-native-id'}});
  assert.equal(f.sends.length, 2);
});

test('structured IDs do not grant authorization to unknown contacts', async () => {
  const f = fixture({config: { mode: 'allowed', allowedNumbers: ['573119876543'] }});
  await f.handle(f.message({id: {id: 'native-id'}, fromMe: false, from: SELF, to: FRIEND}));
  assert.equal(f.sends.length, 0);
});

function fixture(options = {}) {
  let time = START;
  let sequence = 0;
  const sends = [];
  const lookups = [];
  const errors = [];
  const results = [];
  const config = { enabled: true, mode: 'self', allowedNumbers: [], ...options.config };
  const handle = createMessageHandler({
    getConfig: () => config,
    getSelfIds: () => [SELF, SELF_LID],
    lookup: async key => { lookups.push(key); return { found: true, key, value: 'valor secreto' }; },
    send: async (chatId, text) => { sends.push({ chatId, text }); },
    onError: error => errors.push(error),
    onResult: result => results.push(result),
    now: () => time,
    startedAt: START,
    ...options.dependencies,
  });
  const message = changes => ({
    id: { _serialized: `event-${++sequence}` },
    fromMe: true, from: SELF, to: SELF, type: 'chat', body: 'clave',
    timestamp: time / 1000, hasMedia: false, ...changes,
  });
  return { handle, message, sends, lookups, errors, results, config,
    advance: (ms = 1000) => { time += ms; } };
}

test('self mode returns a local value and reports the successful send', async () => {
  const f = fixture();
  await f.handle(f.message());
  assert.deepEqual(f.sends, [{ chatId: SELF, text: '🤖 valor secreto' }]);
  assert.deepEqual(f.results, [{ chatId: SELF, key: 'clave', found: true, kind: 'lookup', sent: true }]);
});

test('self mode ignores strangers, own messages to others, and incoming messages', async () => {
  const f = fixture();
  for (const changes of [
    { from: FRIEND, fromMe: false }, { to: FRIEND }, { from: FRIEND }, { fromMe: false },
  ]) await f.handle(f.message(changes));
  assert.equal(f.lookups.length, 0);
  assert.equal(f.sends.length, 0);
});

test('self mode accepts verified own LID and phone aliases only', async () => {
  const f = fixture();
  await f.handle(f.message({ from: SELF_LID, to: SELF_LID }));
  f.advance();
  await f.handle(f.message({ from: SELF, to: SELF_LID }));
  f.advance();
  await f.handle(f.message({ from: FRIEND_LID, to: FRIEND_LID }));
  assert.equal(f.sends.length, 2);
  assert.ok(f.sends.every(item => item.chatId === SELF_LID));
});

test('groups, status, broadcasts, newsletters, media, and non-chat types are ignored', async () => {
  const f = fixture();
  for (const changes of [
    { from: '123@g.us' }, { to: '123@g.us' }, { from: 'status@broadcast' },
    { from: '123@broadcast' }, { from: '123@newsletter' }, { to: '123@newsletter' },
    { hasMedia: true }, { isStatus: true }, { type: 'image' }, { type: 'revoked' },
    { type: undefined },
  ]) await f.handle(f.message(changes));
  assert.equal(f.lookups.length, 0);
});

test('disabled and invalid modes cannot query data', async () => {
  const f = fixture({ config: { enabled: false } });
  await f.handle(f.message());
  f.config.enabled = true;
  f.config.mode = 'everyone';
  await f.handle(f.message());
  assert.equal(f.lookups.length, 0);
});

test('old history, absent timestamps, missing IDs, blank and long keys are ignored', async () => {
  const f = fixture();
  for (const changes of [
    { timestamp: START / 1000 - 3 }, { timestamp: undefined }, { timestamp: NaN },
    { timestamp: String(START / 1000) }, { id: undefined }, { body: '' },
    { body: '  \n ' }, { body: 'a'.repeat(201) }, { body: null },
  ]) await f.handle(f.message(changes));
  assert.equal(f.lookups.length, 0);
  await f.handle(f.message({ timestamp: START / 1000 - 2 }));
  assert.equal(f.lookups.length, 1);
});

test('Unicode keys are preserved and surrounding spaces are trimmed', async () => {
  const f = fixture();
  await f.handle(f.message({ body: '  Niño 🔑 日本語  ' }));
  assert.deepEqual(f.lookups, ['Niño 🔑 日本語']);
});

test('duplicate events, including concurrent events, reply only once', async () => {
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ dependencies: { lookup: async key => {
    calls++;
    await pending;
    return { found: true, key, value: 'ok' };
  } } });
  const msg = f.message();
  const first = f.handle(msg);
  await f.handle(msg);
  release();
  await first;
  f.advance();
  await f.handle(msg);
  assert.equal(calls, 1);
  assert.equal(f.sends.length, 1);
});

test('bot replies cannot recursively query the dictionary', async () => {
  const f = fixture();
  await f.handle(f.message({ body: '🤖 valor secreto' }));
  await f.handle(f.message({ body: '  🤖 clave' }));
  assert.equal(f.lookups.length, 0);
});

test('cooldown limits distinct messages in one chat, then accepts a fresh message', async () => {
  const f = fixture();
  await f.handle(f.message());
  f.advance(749);
  await f.handle(f.message());
  f.advance(1);
  await f.handle(f.message());
  assert.equal(f.sends.length, 2);
});

test('allowed mode only accepts incoming messages from approved full phone numbers', async () => {
  const f = fixture({ config: { mode: 'allowed', allowedNumbers: ['+573119876543'] } });
  await f.handle(f.message({ from: FRIEND, fromMe: false }));
  f.advance();
  await f.handle(f.message({ from: FRIEND, fromMe: true }));
  await f.handle(f.message({ from: '573000000000@c.us', fromMe: false }));
  assert.deepEqual(f.sends, [{ chatId: FRIEND, text: '🤖 valor secreto' }]);
});

test('allowed mode accepts a LID only after resolving its verified phone number', async () => {
  const seen = [];
  const f = fixture({
    config: { mode: 'allowed', allowedNumbers: ['573119876543'] },
    dependencies: { resolvePhone: async id => { seen.push(id); return '+573119876543'; } },
  });
  await f.handle(f.message({ from: FRIEND_LID, fromMe: false }));
  assert.deepEqual(seen, [FRIEND_LID]);
  assert.deepEqual(f.sends, [{ chatId: FRIEND_LID, text: '🤖 valor secreto' }]);
});

test('numeric LIDs cannot impersonate allowed phone numbers', async () => {
  const f = fixture({ config: { mode: 'allowed', allowedNumbers: ['573119876543'] } });
  await f.handle(f.message({ from: '573119876543@lid', fromMe: false }));
  assert.equal(f.lookups.length, 0);
});

test('LID resolver accepts the serialized pn returned by whatsapp-web.js', async () => {
  const f = fixture({
    config: { mode: 'allowed', allowedNumbers: ['573119876543'] },
    dependencies: { resolvePhone: async () => FRIEND },
  });
  await f.handle(f.message({ from: FRIEND_LID, fromMe: false }));
  assert.deepEqual(f.sends, [{ chatId: FRIEND_LID, text: '🤖 valor secreto' }]);
});

test('LID resolver results must be phones, never another LID', async () => {
  const f = fixture({
    config: { mode: 'allowed', allowedNumbers: ['573119876543'] },
    dependencies: { resolvePhone: async () => '573119876543@lid' },
  });
  await f.handle(f.message({ from: FRIEND_LID, fromMe: false }));
  assert.equal(f.lookups.length, 0);
});

test('concurrent duplicate LID events resolve and send only once', async () => {
  let calls = 0;
  const f = fixture({
    config: { mode: 'allowed', allowedNumbers: ['573119876543'] },
    dependencies: { resolvePhone: async () => { calls++; await Promise.resolve(); return '573119876543'; } },
  });
  const msg = f.message({ from: FRIEND_LID, fromMe: false });
  await Promise.all([f.handle(msg), f.handle(msg)]);
  assert.equal(calls, 1);
  assert.equal(f.sends.length, 1);
});

test('unapproved resolved numbers and invalid allow-list values are ignored', async () => {
  const f = fixture({
    config: { mode: 'allowed', allowedNumbers: ['573119876543', 573000000000, '*', '987'] },
    dependencies: { resolvePhone: async () => '573222222222' },
  });
  await f.handle(f.message({ from: FRIEND_LID, fromMe: false }));
  await f.handle(f.message({ from: '573000000000@c.us', fromMe: false }));
  assert.equal(f.lookups.length, 0);
});

test('unknown key gets the fixed missing-key response', async () => {
  const f = fixture({ dependencies: { lookup: async key => ({ found: false, key }) } });
  await f.handle(f.message());
  assert.equal(f.sends[0].text, '🤖 No encontré esa clave.');
  assert.equal(f.results[0].found, false);
});

test('lookup failures never expose paths or error details in WhatsApp', async () => {
  const secret = new Error('C:\\private\\clientes.json: private content');
  const f = fixture({ dependencies: { lookup: async () => { throw secret; } } });
  await assert.doesNotReject(f.handle(f.message()));
  assert.deepEqual(f.errors, [secret]);
  assert.equal(f.sends[0].text, '🤖 No pude consultar el diccionario. Revisa el panel local.');
  assert.equal(f.results[0].kind, 'error');
});

test('invalid lookup results are reported without sending arbitrary objects', async () => {
  const f = fixture({ dependencies: { lookup: async () => ({ found: true }) } });
  await f.handle(f.message());
  assert.equal(f.errors.length, 1);
  assert.match(f.sends[0].text, /^🤖 No pude consultar/);
});

test('send failures are contained and do not report successful sends', async () => {
  const f = fixture({ dependencies: { send: async () => { throw new Error('offline'); } } });
  await assert.doesNotReject(f.handle(f.message()));
  assert.equal(f.errors.length, 1);
  assert.equal(f.results.length, 0);
});

test('phone resolution and error logging failures never escape the handler', async () => {
  const f = fixture({
    config: { mode: 'allowed', allowedNumbers: ['573119876543'] },
    dependencies: {
      resolvePhone: async () => { throw new Error('Cannot resolve'); },
      onError: async () => { throw new Error('Cannot log'); },
    },
  });
  await assert.doesNotReject(f.handle(f.message({ from: FRIEND_LID, fromMe: false })));
  assert.equal(f.sends.length, 0);
});

test('/ayuda explains a key lookup; /claves never discloses or queries keys', async () => {
  const f = fixture();
  await f.handle(f.message({ body: '/ayuda' }));
  f.advance();
  await f.handle(f.message({ body: '/claves' }));
  assert.equal(f.lookups.length, 0);
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].text, /^🤖 Escribe una clave/);
});

test('processed-event cache stays bounded and recent IDs remain protected', async () => {
  const f = fixture();
  const first = f.message();
  await f.handle(first);
  let latest;
  for (let i = 0; i < 2000; i++) {
    f.advance();
    latest = f.message();
    await f.handle(latest);
  }
  f.advance();
  await f.handle(latest);
  assert.equal(f.sends.length, 2001);
  // Once the configured 2000-entry bound is reached, the oldest ID is evicted.
  await f.handle(first);
  assert.equal(f.sends.length, 2002);
});

test('pausing during an asynchronous lookup cancels the pending reply', async () => {
  let release;
  const f = fixture({ dependencies: { lookup: () => new Promise(resolve => { release = resolve; }) } });
  const pending = f.handle(f.message());
  f.config.enabled = false;
  release({ found: true, key: 'clave', value: 'secret' });
  await pending;
  assert.equal(f.sends.length, 0);
  assert.equal(f.results.length, 0);
});

test('revoking an allowed number during lookup cancels the pending reply', async () => {
  let release;
  const f = fixture({
    config: { mode: 'allowed', allowedNumbers: ['573119876543'] },
    dependencies: { lookup: () => new Promise(resolve => { release = resolve; }) },
  });
  const pending = f.handle(f.message({ from: FRIEND, fromMe: false }));
  f.config.allowedNumbers = [];
  release({ found: true, key: 'clave', value: 'secret' });
  await pending;
  assert.equal(f.sends.length, 0);
});

test('pausing during LID resolution cancels before querying the dictionary', async () => {
  let release;
  const f = fixture({
    config: { mode: 'allowed', allowedNumbers: ['573119876543'] },
    dependencies: { resolvePhone: () => new Promise(resolve => { release = resolve; }) },
  });
  const pending = f.handle(f.message({ from: FRIEND_LID, fromMe: false }));
  f.config.enabled = false;
  release(FRIEND);
  await pending;
  assert.equal(f.lookups.length, 0);
  assert.equal(f.sends.length, 0);
});

test('dictionary path changes cancel replies from the previous dictionary', async () => {
  let release;
  const f = fixture({
    config: { dictionaryPath: 'old.json' },
    dependencies: { lookup: () => new Promise(resolve => { release = resolve; }) },
  });
  const pending = f.handle(f.message());
  f.config.dictionaryPath = 'new.json';
  release({ found: true, key: 'clave', value: 'old value' });
  await pending;
  assert.equal(f.sends.length, 0);
});

test('configRevision detects pause/resume cycles during lookup', async () => {
  let release;
  const f = fixture({
    config: { configRevision: 0 },
    dependencies: { lookup: () => new Promise(resolve => { release = resolve; }) },
  });
  const pending = f.handle(f.message());
  f.config.enabled = false;
  f.config.configRevision++;
  f.config.enabled = true;
  f.config.configRevision++;
  release({ found: true, key: 'clave', value: 'secret' });
  await pending;
  assert.equal(f.sends.length, 0);
});

test('pausing during a failed lookup suppresses even the generic error reply', async () => {
  let reject;
  const f = fixture({ dependencies: { lookup: () => new Promise((resolve, fail) => { reject = fail; }) } });
  const pending = f.handle(f.message());
  f.config.enabled = false;
  reject(new Error('Unavailable dictionary'));
  await pending;
  assert.equal(f.sends.length, 0);
  assert.equal(f.errors.length, 1);
});
