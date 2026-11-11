'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MARKER = '// Local media compatibility: upstream wwebjs PR #201923';
const ANCHOR = "        // Bot's won't reply if canonicalUrl is set (linking)";

function patchSource(source) {
  if (source.includes(MARKER)) return source;
  if (source.split(ANCHOR).length !== 2) throw new Error('La biblioteca cambió: no se pudo aplicar la corrección del envío de imágenes.');
  // Remove even an undefined own property: it shadows the outgoing MsgKey.
  return source.replace(ANCHOR, `        ${MARKER}\n        delete message.__x_id;\n\n${ANCHOR}`);
}

function ensureMediaCompatibility() {
  const root = path.dirname(require.resolve('whatsapp-web.js/package.json'));
  const metadata = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if (metadata.version !== '1.34.7') throw new Error('Revisa la compatibilidad de imágenes antes de actualizar whatsapp-web.js.');
  const file = path.join(root,'src/util/Injected/Utils.js');
  const original = fs.readFileSync(file,'utf8');
  const patched = patchSource(original);
  if (patched !== original) fs.writeFileSync(file,patched,'utf8');
}
module.exports = {patchSource,ensureMediaCompatibility};
