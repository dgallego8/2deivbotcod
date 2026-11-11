#!/usr/bin/env bash
# Arma el sitio estático en la carpeta indicada (por defecto _site).
# Copia el CSS desde botcod-main sin modificarlo. Los datos que sube el dueño
# van en pwa/data/: payloads_generados.json (diccionario) y acceso.json (hash de la contraseña).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/_site}"
BUILD_ID="${2:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)}"

rm -rf "$OUT"

for file in payloads_generados.json acceso.json; do
  if [ ! -f "$ROOT/pwa/data/$file" ]; then
    echo "AVISO: falta pwa/data/$file (el sitio se publica sin él)." >&2
  fi
done

mkdir -p "$OUT"
cp -R "$ROOT/pwa/." "$OUT/"
rm -f "$OUT/build.sh" "$OUT/icons/icon.svg"
cp "$ROOT/botcod-main/public/style.css" "$OUT/style.css"

sed -i.bak "s/__BUILD_ID__/${BUILD_ID}/" "$OUT/sw.js" && rm -f "$OUT/sw.js.bak"
touch "$OUT/.nojekyll"

echo "Sitio generado en $OUT (versión de caché: $BUILD_ID)"
