// Optional integration test, not part of the dependency-free npm test suite.
// Install Miniflare locally or set MINIFLARE_MODULE to its file:// module URL.
const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
const secret=()=>randomBytes(24).toString('hex');const bindings={ROLE:'all',MASTER_KEY:secret(),SETUP_KEY:secret(),CALLBACK_SECRET:secret(),WEBHOOK_SECRET:secret(),ADMIN_IDS:'901'};
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'nexiup',modules:true,scriptPath:new URL('../worker.js',import.meta.url).pathname,compatibilityDate:'2026-10-20',compatibilityFlags:['global_fetch_strictly_public'],d1Databases:['DB'],bindings}]}));
try{
  for(let i=0;i<12;i++){
    const res=await mf.dispatchFetch('https://main.example.test/setup',{method:'POST',headers:{Authorization:'Bearer '+bindings.SETUP_KEY,'Content-Type':'application/json'},body:JSON.stringify({action:'migrate'})});
    const data=await res.json();console.log('migration',i+1,res.status,data);assert.equal(res.status,200);if(data.ready)break;assert.ok(i<11,'migrations must complete');
  }
  let res=await mf.dispatchFetch('https://main.example.test/sync/api/users',{method:'POST',headers:{Authorization:'Bearer '+bindings.MASTER_KEY,'Content-Type':'application/json'},body:JSON.stringify({name:'smoke_'+randomBytes(6).toString('hex'),trafficLimit:1,dailyLimit:1,expiryDays:1})});
  const created=await res.json();console.log('panel create',res.status,created.success);assert.equal(res.status,201);
  res=await mf.dispatchFetch('https://main.example.test/sync?sub='+encodeURIComponent(created.user.name)+'&format=xray');const list=await res.json();assert.equal(list.length,3);console.log('workerd subscription: 3 Xray variants with shared identity');
  res=await mf.dispatchFetch('https://main.example.test/sync/dash');assert.equal(res.status,200);console.log('embedded dashboard',res.status);
  res=await mf.dispatchFetch('https://main.example.test/sync?sub='+encodeURIComponent(created.user.name)+'&format=qr');assert.equal(res.status,200);const png=new Uint8Array(await res.arrayBuffer());assert.equal(png[0],137);console.log('workerd local PNG QR',png.length,'bytes');
  const db=await mf.getD1Database('DB');
  await db.prepare('INSERT INTO nx_flush(id,data,created_at) VALUES(?,?,?)').bind('smoke-flush',JSON.stringify([{id:created.user.id,epoch:0,day:'2026-10-20',up:123,down:456}]),Date.now()).run();
  const usage=await db.prepare('SELECT up,down FROM nx_panel_usage WHERE id=?').bind(created.user.id).first();assert.deepEqual(usage,{up:123,down:456});console.log('real local D1 trigger: exact additive bytes');
  console.log('Miniflare/workerd smoke PASS');
}finally{await mf.dispose();}
