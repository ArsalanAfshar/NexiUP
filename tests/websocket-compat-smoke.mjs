// Isolated native proof of the compatibility change observed in the uploaded file.
// No attached/upstream source is executed. No TCP/Internet/production credentials.
import assert from 'node:assert/strict';
const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
for(const [date,explicit,kind,length]of [['2026-03-16',false,'ArrayBuffer',3],['2026-03-17',false,'Blob',0],['2026-10-20',true,'ArrayBuffer',3]]){
  const script=`export default {fetch(){const p=new WebSocketPair(),s=p[1];${explicit?"s.binaryType='arraybuffer';":''}s.accept();s.addEventListener('message',e=>s.send(JSON.stringify({kind:e.data instanceof Blob?'Blob':e.data instanceof ArrayBuffer?'ArrayBuffer':'other',naive_byte_length:new Uint8Array(e.data).length})));s.addEventListener('close',()=>{try{s.close();}catch{}});return new Response(null,{status:101,webSocket:p[0]});}};`;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'binary-compat-proof',modules:true,script,compatibilityDate:date}]}));
  try{
    const response=await mf.dispatchFetch('https://compat.example.test',{headers:{Upgrade:'websocket'}});assert.equal(response.status,101);const ws=response.webSocket;ws.accept();
    const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Compatibility test timed out')),3000);ws.addEventListener('message',event=>{clearTimeout(timer);resolve(JSON.parse(event.data));});});
    ws.send(Uint8Array.of(1,2,3));const data=await received;assert.equal(data.kind,kind);assert.equal(data.naive_byte_length,length);ws.close();
    console.log(date+' / explicit arraybuffer='+explicit+' → '+kind+', naive Uint8Array length='+length);
  }finally{await mf.dispose();}
}
console.log('WebSocket compatibility regression PASS. This explains a byte-parser failure, not every account-specific Cloudflare 1101.');
