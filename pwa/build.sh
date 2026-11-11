#!/usr/bin/env bash
# Arma el sitio estático en la carpeta indicada (por defecto _site).
# Copia el CSS desde botcod-main sin modificarlo. El diccionario se publica
# SOLO cifrado (pwa/data/payloads.enc.json, ver pwa/encrypt.mjs).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/_site}"
BUILD_ID="${2:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)}"

rm -rf "$OUT"

if [ ! -f "$ROOT/pwa/data/payloads.enc.json" ]; then
  echo "AVISO: falta pwa/data/payloads.enc.json; el sitio se publica sin diccionario. Créalo en cifrar.html o con: node pwa/encrypt.mjs ruta/al/payloads_generados.json" >&2
fi

mkdir -p "$OUT"
cp -R "$ROOT/pwa/." "$OUT/"
rm -f "$OUT/build.sh" "$OUT/encrypt.mjs" "$OUT/icons/icon.svg"
cp "$ROOT/botcod-main/public/style.css" "$OUT/style.css"

sed -i.bak "s/__BUILD_ID__/${BUILD_ID}/" "$OUT/sw.js" && rm -f "$OUT/sw.js.bak"
touch "$OUT/.nojekyll"

echo "Sitio generado en $OUT (versión de caché: $BUILD_ID)"
