// Native regression for preserved legacy worker.js 2.1.2. Real WebSocket/D1/TCP,
// with a TEST-ONLY loopback destination mapping. Never deploy this test adapter.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import {header,waitFor} from './mesh-native-harness.mjs';
const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
const sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.pipe(socket);});await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
const source=await readFile(new URL('../worker.js',import.meta.url),'utf8'),needle='connect({hostname:destination.host,port:destination.port})';assert.ok(source.includes(needle));
const script=source.replace(needle,`connect({hostname:'127.0.0.1',port:${server.address().port}})`);
const secret=()=>randomBytes(24).toString('hex'),bindings={ROLE:'all',MASTER_KEY:secret(),SETUP_KEY:secret(),CALLBACK_SECRET:secret(),WEBHOOK_SECRET:secret(),ADMIN_IDS:'901'};
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'legacy-binary-regression',modules:true,script,scriptPath:new URL('../worker.js',import.meta.url).pathname,bindings,d1Databases:['DB'],compatibilityDate:'2026-10-20',compatibilityFlags:['global_fetch_strictly_public']}]}));
try{
  for(let i=0;i<12;i++){const r=await mf.dispatchFetch('https://legacy.example.test/setup',{method:'POST',headers:{Authorization:'Bearer '+bindings.SETUP_KEY},body:'{"action":"migrate"}'});assert.equal(r.status,200);if((await r.json()).ready)break;assert.ok(i<11);}
  const created=await mf.dispatchFetch('https://legacy.example.test/sync/api/users',{method:'POST',headers:{Authorization:'Bearer '+bindings.MASTER_KEY},body:JSON.stringify({name:'native_legacy_fixture',trafficLimit:1,dailyLimit:1,expiryDays:1})});assert.equal(created.status,201);const account=(await created.json()).user;
  const response=await mf.dispatchFetch('https://legacy.example.test/sync/ws',{headers:{Upgrade:'websocket'}});assert.equal(response.status,101);const ws=response.webSocket;ws.binaryType='arraybuffer';ws.accept();
  const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Legacy native WS timed out')),4000);ws.addEventListener('message',event=>{clearTimeout(timer);resolve(new TextDecoder().decode(new Uint8Array(event.data).slice(2)));});});
  ws.send(header(account.id,'vless','legacy-proof'));assert.equal(await received,'legacy-proof');ws.close();
  const db=await mf.getD1Database('DB');await waitFor(async()=>{const row=await db.prepare('SELECT up,down FROM nx_panel_usage WHERE id=?').bind(account.id).first();return row?.up===12&&row?.down===12;});
  console.log('Legacy 2.1.2 native WebSocket/TCP PASS on modern Blob-default compatibility date; 12 upload + 12 download bytes persisted.');
}finally{await mf.dispose();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
