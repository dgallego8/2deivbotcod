const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {renderQrCard,decodeImage,AREA,TEMPLATE} = require('../lib/qr-card');

test('template preserves every pixel outside QR area and final QR holds exact value', async () => {
 const value = '000201' + '1234567890'.repeat(52) + 'ñ';
 const output = await renderQrCard(value);
 assert.equal(await decodeImage(output),value);
 const original = await sharp(TEMPLATE).removeAlpha().raw().toBuffer();
 const actual = await sharp(output).removeAlpha().raw().toBuffer();
 for (let y=0;y<1600;y++) {
  if (y<AREA.top || y>=AREA.top+AREA.height) assert.ok(original.subarray(y*2700,(y+1)*2700).equals(actual.subarray(y*2700,(y+1)*2700)));
  else {
   for (const [start,end] of [[0,AREA.left*3],[(AREA.left+AREA.width)*3,2700]]) assert.ok(original.subarray(y*2700+start,y*2700+end).equals(actual.subarray(y*2700+start,y*2700+end)));
  }
 }
 const compressed = await sharp(output).resize({width:720}).jpeg({quality:65}).toBuffer();
 assert.equal(await decodeImage(compressed),value);
});

test('invalid values fail instead of sending original template QR', async () => {
 await assert.rejects(renderQrCard(''));
 await assert.rejects(renderQrCard('a'.repeat(5000)));
});
