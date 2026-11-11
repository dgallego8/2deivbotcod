#!/usr/bin/env bash
# Arma el sitio estático en la carpeta indicada (por defecto _site).
# Copia el CSS y el diccionario desde botcod-main sin modificarlos,
# para que haya una sola copia de los datos en el repositorio.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/_site}"
BUILD_ID="${2:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)}"

rm -rf "$OUT"
mkdir -p "$OUT/data"

cp -R "$ROOT/pwa/." "$OUT/"
rm -f "$OUT/build.sh" "$OUT/icons/icon.svg"
cp "$ROOT/botcod-main/public/style.css" "$OUT/style.css"
cp "$ROOT/botcod-main/data/payloads_generados.json" "$OUT/data/payloads_generados.json"

sed -i.bak "s/__BUILD_ID__/${BUILD_ID}/" "$OUT/sw.js" && rm -f "$OUT/sw.js.bak"
touch "$OUT/.nojekyll"

echo "Sitio generado en $OUT (versión de caché: $BUILD_ID)"
