const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {patchSource}=require('../lib/media-compat');
const file=path.join(path.dirname(require.resolve('whatsapp-web.js/package.json')),'src/util/Injected/Utils.js');
const source=fs.readFileSync(file,'utf8');

test('installed media send construction preserves real message id and upload fields',()=>{
 const patched=patchSource(source);
 assert.equal(patchSource(patched),patched);
 const start=patched.indexOf('        const message = {');
 const end=patched.indexOf("        // Bot's won't reply",start);
 assert.ok(start>=0 && end>start);
 for(const privateId of [undefined,null,'unrelated-media-id']) {
   const context={options:{},newMsgKey:{id:'real-message'},content:'',from:'self',chat:{id:'recipient'},ephemeralFields:{},mediaOptions:{__x_id:privateId,type:'image',directPath:'/media',mediaKey:'test-key'},quotedMsgOptions:{},locationOptions:{},pollOptions:{},eventOptions:{},vcardOptions:{},buttonOptions:{},listOptions:{},botOptions:{},extraOptions:{}};
   const result=vm.runInNewContext(patched.slice(start,end)+'\nmessage;',context);
   assert.equal(Object.hasOwn(result,'__x_id'),false);
   assert.equal(result.id.id,'real-message');
   assert.equal(result.directPath,'/media');
   assert.equal(result.mediaKey,'test-key');
 }
});
test('patch fails explicitly if expected library code changes',()=>{
 assert.throws(()=>patchSource('unrecognized source'));
});
