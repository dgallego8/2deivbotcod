'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Dictionary, validateDictionary, MAX_FILE_BYTES } = require('../lib/dictionary');

async function fixture(t, initial = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-dictionary-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'diccionario.json');
  await fs.writeFile(file, JSON.stringify(initial), 'utf8');
  return { folder, file, dictionary: new Dictionary(file) };
}

test('consulta claves normalizadas y conserva cero, falso y texto vacío', async t => {
  const { dictionary } = await fixture(t, {
    '  Café  ': 'Disponible', cero: 0, falso: false, vacio: '', objeto: { precio: 12 }, nada: null,
  });
  assert.deepEqual(await dictionary.lookup(' CAFE\u0301 '), {
    found: true, key: '  Café  ', value: 'Disponible',
  });
  for (const [key, value] of [['cero', '0'], ['falso', 'false'], ['vacio', ''], ['nada', 'null']]) {
    assert.deepEqual(await dictionary.lookup(key), { found: true, key, value });
  }
  assert.equal((await dictionary.lookup('objeto')).value, '{\n  "precio": 12\n}');
  assert.deepEqual(await dictionary.lookup('desconocida'), { found: false });
});

test('recarga cambios externos en cada consulta y admite BOM de editores Windows', async t => {
  const { dictionary, file } = await fixture(t, { stock: 'antes' });
  assert.equal((await dictionary.lookup('stock')).value, 'antes');
  await fs.writeFile(file, '\uFEFF{"stock":"después"}', 'utf8');
  assert.equal((await dictionary.lookup('stock')).value, 'después');
  await fs.writeFile(file, '{"nuevo":42}', 'utf8');
  assert.deepEqual(await dictionary.lookup('stock'), { found: false });
});

test('archivo inexistente, JSON roto y raíz incorrecta producen errores claros', async t => {
  const { dictionary, file } = await fixture(t);
  await fs.unlink(file);
  await assert.rejects(dictionary.read(), { code: 'ENOENT', message: /No se encontró/ });
  for (const content of ['{', '[]', 'null', '"texto"', '42', 'true']) {
    await fs.writeFile(file, content);
    await assert.rejects(dictionary.read(), { code: 'DICTIONARY_INVALID' });
  }
});

test('rechaza claves vacías, colisiones normalizadas y prefijo de respuestas', () => {
  for (const data of [
    { ' ': 1 }, { A: 1, ' a ': 2 }, { 'Café': 1, 'CAFE\u0301': 2 }, { ' 🤖 hola': 1 }, { '🤖 ': 1 },
  ]) assert.throws(() => validateDictionary(data), { code: 'DICTIONARY_INVALID' });
});

test('las claves de prototipo se consultan como datos sin alterar objetos', async t => {
  const original = JSON.parse('{"__proto__":{"safe":true},"constructor":"valor","toString":"texto"}');
  const { dictionary } = await fixture(t, original);
  assert.equal((await dictionary.lookup('__proto__')).value, '{\n  "safe": true\n}');
  assert.equal((await dictionary.lookup('constructor')).value, 'valor');
  await dictionary.save(original);
  const read = await dictionary.read();
  assert.equal(Object.getPrototypeOf(read), Object.prototype);
  assert.equal(Object.hasOwn(read, '__proto__'), true);
  assert.equal({}.safe, undefined);
});

test('guardar conserva el archivo anterior válido como respaldo y no deja temporales', async t => {
  const { dictionary, file, folder } = await fixture(t, { version: 1 });
  const previous = await fs.readFile(file, 'utf8');
  assert.deepEqual(await dictionary.save({ version: 2 }), { version: 2 });
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), previous);
  assert.deepEqual(await dictionary.read(), { version: 2 });
  await fs.writeFile(file, '{roto');
  await dictionary.save({ version: 3 });
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), previous);
  assert.deepEqual((await fs.readdir(folder)).sort(), ['diccionario.json', 'diccionario.json.bak']);
});

test('un guardado inválido no modifica el diccionario ni el respaldo', async t => {
  const { dictionary, file } = await fixture(t, { version: 1 });
  await dictionary.save({ version: 2 });
  const current = await fs.readFile(file, 'utf8');
  const backup = await fs.readFile(`${file}.bak`, 'utf8');
  await assert.rejects(dictionary.save({ invalido: 'a'.repeat(3501) }), /3500/);
  assert.equal(await fs.readFile(file, 'utf8'), current);
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), backup);
  await dictionary.save({ version: 3 });
  assert.deepEqual(await dictionary.read(), { version: 3 });
});

test('el límite de respuesta incluye JSON renderizado, y el de archivo cuenta bytes', async t => {
  assert.doesNotThrow(() => validateDictionary({ limite: 'a'.repeat(3500) }));
  assert.throws(() => validateDictionary({ largo: { texto: 'a'.repeat(3490) } }), /3500/);
  const { dictionary, file } = await fixture(t);
  await fs.writeFile(file, ' '.repeat(MAX_FILE_BYTES + 1));
  await assert.rejects(dictionary.read(), { code: 'DICTIONARY_TOO_LARGE' });
  const large = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`clave${i}`, 'é'.repeat(3000)]));
  await assert.rejects(dictionary.save(large), { code: 'DICTIONARY_TOO_LARGE' });
});

test('rechaza valores que JSON no puede guardar fielmente', () => {
  const cycle = {};
  cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, Symbol('x'), new Date(), cycle]) {
    assert.throws(() => validateDictionary({ dato: value }), { code: 'DICTIONARY_INVALID' });
  }
  assert.throws(() => validateDictionary({ get dato() { throw new Error('no ejecutar'); } }), /calculadas/);
  assert.equal(validateDictionary(Object.create(null)) !== null, true);
});

test('guardados concurrentes quedan completos, ordenados y usan una instantánea del argumento', async t => {
  const { dictionary, file } = await fixture(t, { version: 0 });
  const data = { version: 1 };
  const first = dictionary.save(data);
  data.version = 'mutación posterior';
  const second = dictionary.save({ version: 2 });
  await Promise.all([first, second]);
  assert.deepEqual(await dictionary.read(), { version: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')), { version: 1 });
});

test('crea un diccionario nuevo en un directorio local inexistente', async t => {
  const { folder } = await fixture(t);
  const dictionary = new Dictionary(path.join(folder, 'datos', 'nuevo.json'));
  await dictionary.save({ saludo: 'hola' });
  assert.equal((await dictionary.lookup('saludo')).value, 'hola');
});
