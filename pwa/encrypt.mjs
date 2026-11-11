#!/usr/bin/env node
// Cifra el diccionario JSON para publicarlo sin exponerlo.
// Uso:  node pwa/encrypt.mjs ruta/al/payloads_generados.json
// La contraseña se pide por teclado (no se muestra) o se toma de DICT_PASSWORD.
// Resultado: pwa/data/payloads.enc.json  (AES-256-GCM, clave derivada con PBKDF2-SHA256).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const ITERATIONS = 600000;
const input = process.argv[2];
if (!input) { console.error('Uso: node pwa/encrypt.mjs ruta/al/payloads_generados.json'); process.exit(1); }

function askHidden(question) {
  return new Promise((resolveAnswer) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => { if (text.includes(question)) rl.output.write(question); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolveAnswer(answer); });
  });
}

let password = process.env.DICT_PASSWORD;
if (!password) {
  password = await askHidden('Contraseña: ');
  if (password !== await askHidden('Repite la contraseña: ')) { console.error('Las contraseñas no coinciden.'); process.exit(1); }
}
if (password.length < 12) { console.error('Usa una contraseña de al menos 12 caracteres.'); process.exit(1); }

const plaintext = readFileSync(input);
JSON.parse(plaintext.toString('utf8').replace(/^﻿/, '')); // Falla si no es JSON válido.
const salt = randomBytes(16), iv = randomBytes(12);
const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]); // WebCrypto espera datos + etiqueta.
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'data', 'payloads.enc.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), data: encrypted.toString('base64') }) + '\n');
console.log(`Listo: ${out}`);
