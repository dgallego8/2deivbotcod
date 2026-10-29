'use strict';
const path = require('node:path');
const sharp = require('sharp');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const TEMPLATE = path.join(__dirname, '../assets/plantilla-original.jpeg');
const AREA = { left: 184, top: 450, width: 526, height: 526 };

async function decodeImage(buffer) {
  const {data,info} = await sharp(buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  return jsQR(new Uint8ClampedArray(data), info.width, info.height, {inversionAttempts:'dontInvert'})?.data;
}

async function renderQrCard(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('El valor está vacío; no se puede generar el QR.');
  let symbol;
  try { symbol = QRCode.create([{data:value,mode:'byte'}], {errorCorrectionLevel:'M'}); }
  catch { throw new Error('El valor no cabe en un código QR.'); }
  const scale = Math.floor(AREA.width / (symbol.modules.size + 8));
  if (scale < 3) throw new Error('El valor es demasiado largo para el espacio de esta plantilla.');
  const qr = await QRCode.toBuffer([{data:value,mode:'byte'}], {type:'png',errorCorrectionLevel:'M',margin:4,scale,color:{dark:'#000000',light:'#ffffff'}});
  const qrSize = (symbol.modules.size + 8) * scale;
  const offset = Math.floor((AREA.width - qrSize) / 2);
  const patch = await sharp({create:{width:AREA.width,height:AREA.height,channels:3,background:'#ffffff'}})
    .composite([{input:qr,left:offset,top:offset}]).png().toBuffer();
  const meta = await sharp(TEMPLATE).metadata();
  if (meta.width !== 900 || meta.height !== 1600) throw new Error('La plantilla no tiene las dimensiones esperadas.');
  const output = await sharp(TEMPLATE).composite([{input:patch,left:AREA.left,top:AREA.top}]).png().toBuffer();
  // Validate the actual final image rather than only trusting the QR encoder.
  if (await decodeImage(output) !== value) throw new Error('No se pudo verificar el contenido del QR generado.');
  return output;
}
module.exports = {renderQrCard,decodeImage,AREA,TEMPLATE};
