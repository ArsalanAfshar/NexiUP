import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { readFile } from 'node:fs/promises';
import manager,{managerDb,initialize,SCHEMA,MAX_GRANT,PERMIT_MS,DAY,maintenance,sha224,MESH_SCRIPT,COOKIE} from '../manager-worker.js';
import nodeWorker from '../node-worker.js';
import {FakeD1} from './helpers.mjs';
import {pngPixels,decodeFixturePng} from './qr-helpers.mjs';
import {meshFixture,create,open,close,control,admin,requireAdmin,id,secret,managerOrigin,ownerRequest} from './mesh-helpers.mjs';
async function f(t,count=2){const x=await meshFixture(count);t.after(()=>x.close());return x;}
const editable=(a,extra={})=>({name:a.name,notes:a.notes,expires_at:a.expires_at,total_bytes:a.total_bytes,daily_bytes:a.daily_bytes,conn_limit:a.conn_limit,protocol:a.protocol,node_mode:a.node_mode,nodes:a.nodes,version:a.version,...extra});
const action=(x,a,kind,extra={})=>admin(x,'accounts/'+a.id+'/action',{method:'POST',body:{action:kind,nonce:id(),version:a.version,confirm:a.id,...extra}});
const usage=(x,a)=>x.DB.row('SELECT * FROM nx3_usage WHERE account_id=? AND epoch=?',a.id,a.epoch);

test('both standalone public boot paths run without bindings or credentials',async()=>{
  const env={};Object.defineProperty(env,'DB',{get(){throw new Error('PRIVATE_BINDING');}});
  for(const [app,component]of [[manager,'manager'],[nodeWorker,'node']]){
    for(const path of ['/','/health']){const r=await app.fetch(new Request('https://boot.example.test'+path),env,{});assert.equal(r.status,200);assert.equal(r.headers.get('X-NexiUP-Version'),'3.0.0');const text=await r.text();assert.ok(!text.includes('PRIVATE_BINDING'));if(path==='/health')assert.equal(JSON.parse(text).component,component);}
  }
  const health=await manager.fetch(new Request(managerOrigin+'/health'),undefined,{});assert.equal((await health.json()).database_checked,false);
});
test('standalone generation is small and does not include third-party padding, remote UI or eager TCP imports',async()=>{
  const managerSource=await readFile(new URL('../manager-worker.js',import.meta.url),'utf8'),nodeSource=await readFile(new URL('../node-worker.js',import.meta.url),'utf8');
  assert.ok(Buffer.byteLength(managerSource)<400000);assert.ok(Buffer.byteLength(nodeSource)<50000);assert.ok(!managerSource.includes('cloudflare:sockets'));assert.ok(!/^import /m.test(nodeSource));assert.match(nodeSource,/await import\('cloudflare:sockets'\)/);
  assert.ok(!nodeSource.includes('.prepare('));assert.ok(!nodeSource.includes('request.fetcher.connect'));assert.ok(!managerSource.includes('Pages静态页面'));assert.doesNotThrow(()=>new Script(MESH_SCRIPT));
  const page=await manager.fetch(new Request(managerOrigin+'/admin'),{},{}),markup=await page.text();assert.match(markup,/SIL OPEN FONT LICENSE/);assert.match(markup,/data:font\/woff2;base64/);assert.ok(!/<script[^>]*src=/i.test(markup));assert.ok(!/localStorage|sessionStorage/.test(MESH_SCRIPT));
});
test('login initializes only nx3 tables, hashes sessions, and enforces cookie Origin/CSRF/logout',async t=>{
  const DB=new FakeD1();t.after(()=>DB.close());DB.exec('CREATE TABLE legacy_sentinel(value TEXT)');DB.exec("INSERT INTO legacy_sentinel VALUES('unchanged')");
  const x={DB,env:{DB,OWNER_KEY:secret()}};
  let res=await admin(x,'login',{method:'POST',owner:false,body:{}});assert.equal(res.response.status,401);assert.equal(DB.writes,0);
  res=await admin(x,'login',{method:'POST',body:{}});assert.equal(res.response.status,200);assert.equal(DB.row('SELECT value FROM legacy_sentinel').value,'unchanged');
  const setCookie=res.response.headers.get('Set-Cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);assert.match(setCookie,/Max-Age=1800/);
  const cookie=setCookie.split(';')[0],token=cookie.slice(COOKIE.length+1);assert.notEqual(DB.row('SELECT hash FROM nx3_sessions').hash,token);assert.ok(!JSON.stringify(res.data).includes(token));
  res=await admin(x,'settings',{method:'PUT',owner:false,headers:{Cookie:cookie,Origin:managerOrigin},body:{public_origin:managerOrigin,version:1}});assert.equal(res.response.status,403);
  const session=(await admin(x,'session',{owner:false,headers:{Cookie:cookie}})).data;
  res=await admin(x,'settings',{method:'PUT',owner:false,headers:{Cookie:cookie,Origin:'https://wrong.example.test','X-NexiUP-CSRF':session.csrf},body:{public_origin:managerOrigin,version:1}});assert.equal(res.response.status,403);
  res=await admin(x,'settings',{method:'PUT',owner:false,headers:{Cookie:cookie,Origin:managerOrigin,'X-NexiUP-CSRF':session.csrf},body:{public_origin:managerOrigin,version:1}});assert.equal(res.response.status,200);
  res=await admin(x,'logout',{method:'POST',owner:false,headers:{Cookie:cookie,Origin:managerOrigin,'X-NexiUP-CSRF':session.csrf},body:{}});assert.equal(res.response.status,200);assert.equal(DB.row('SELECT COUNT(*) AS n FROM nx3_sessions').n,0);
  assert.equal((await admin(x,'overview',{owner:false,headers:{Cookie:cookie}})).response.status,401);
});
test('private deployment preflight is read-only before initialization and checks enforcement triggers',async t=>{
  const DB=new FakeD1();t.after(()=>DB.close());const x={DB,env:{DB,OWNER_KEY:secret()}};
  let res=await admin(x,'diagnostics',{method:'POST',body:{}});assert.equal(res.response.status,503);assert.equal(res.data.database,'ok');assert.equal(res.data.ready,false);assert.equal(DB.writes,0);
  await requireAdmin(x,'login',{method:'POST',body:{}});const before=DB.writes;res=await admin(x,'diagnostics',{method:'POST',body:{}});assert.equal(res.data.ready,true);assert.equal(res.data.statements,4);assert.equal(DB.writes,before);
  DB.sqlite.exec('DROP TRIGGER nx3_grant_guard');res=await admin(x,'diagnostics',{method:'POST',body:{}});assert.equal(res.response.status,503);assert.ok(res.data.missing_triggers.includes('nx3_grant_guard'));assert.equal(DB.writes,before);
  res=await admin(x,'login',{method:'POST',body:{}});assert.equal(res.data.error,'schema_incomplete');assert.equal(DB.writes,before);
});
test('D1 missing, wrong type and non-Error failures return safe structured responses',async()=>{
  for(const [DB,expected]of [[undefined,'d1_binding_missing'],['not-a-binding','d1_binding_invalid'],[{prepare(){throw null;},batch(){}},'d1_unavailable']]){
    const env={DB,OWNER_KEY:secret()},response=await manager.fetch(ownerRequest('login',env,{method:'POST'}),env,{}),data=await response.json();assert.equal(response.status,503);assert.equal(data.error,expected);assert.match(data.request_id,/^[a-f0-9]{24}$/);
  }
});
test('node registry requires distinct scoped environment secrets, never an owner/master value',async t=>{
  const x=await f(t,0),body={id:'n',label:'Synthetic',origin:'https://n.example.test',key_ref:'NODE_KEY_N',country:'ZZ',connect_host:'',fallbacks:[],enabled:false,version:0};
  assert.equal((await admin(x,'nodes',{method:'POST',body})).data.error,'node_secret_missing_or_owner_key');x.env.NODE_KEY_N=x.env.OWNER_KEY;assert.equal((await admin(x,'nodes',{method:'POST',body})).data.error,'node_secret_missing_or_owner_key');
  x.env.NODE_KEY_N=secret();let result=await requireAdmin(x,'nodes',{method:'POST',body});assert.equal(result.node.enabled,0);assert.ok(!JSON.stringify(result).includes(x.env.NODE_KEY_N));
  assert.equal((await admin(x,'nodes',{method:'POST',body:{...body,version:1,enabled:true}})).data.error,'test_node_before_enabling');
  x.env.NODE_KEY_OTHER=x.env.NODE_KEY_N;assert.equal((await admin(x,'nodes',{method:'POST',body:{...body,id:'other',origin:'https://other.example.test',key_ref:'NODE_KEY_OTHER'}})).data.error,'node_secret_must_be_unique');
  assert.equal((await admin(x,'nodes',{method:'POST',body:{...body,origin:'https://127.0.0.1'}})).response.status,400);
  assert.equal((await admin(x,'nodes',{method:'POST',body:{...body,origin:'https://good.example.test',fallbacks:['[::ffff:127.0.0.1]:443']}})).response.status,400);
});
test('pairing verifies both directions without following redirects or claiming an exit location',async t=>{
  const x=await f(t);let calls=0;
  t.mock.method(globalThis,'fetch',async(input,init)=>{calls++;assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,'Bearer '+x.nodes[0].key);await control(x,0,'ping',{challenge:init.headers['X-NexiUP-Challenge']});return Response.json({component:'node',protocol:'nexiup-mesh/1',version:'3.0.0',node_id:x.nodes[0].id,challenge:init.headers['X-NexiUP-Challenge'],manager_origin:managerOrigin,manager_reachable:true,colo:'TEST'});});
  let result=await requireAdmin(x,'nodes/'+x.nodes[0].id+'/test',{method:'POST',body:{}});assert.equal(result.ok,true);assert.equal(result.api_round_trip_verified,true);assert.equal(result.proxy_exit_verified,false);assert.equal(calls,1);
  t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:302,headers:{Location:'https://other.example.test'}}));
  result=await requireAdmin(x,'nodes/'+x.nodes[0].id+'/test',{method:'POST',body:{}});assert.equal(result.ok,false);assert.equal(result.error,'redirect_forbidden');assert.equal(x.DB.row('SELECT enabled FROM nx3_nodes WHERE id=?',x.nodes[0].id).enabled,0);
});
test('duplicate account creation reuses one identity and changing a replay payload is rejected',async t=>{
  const x=await f(t),nonce=id(),body={name:'Same synthetic',days:2,notes:'',total_bytes:1000,daily_bytes:500,conn_limit:3,protocol:'both',node_mode:'all',nodes:[],nonce};
  const results=await Promise.all(Array.from({length:8},()=>admin(x,'accounts',{method:'POST',body})));assert.ok(results.every(r=>r.response.status===201));assert.equal(new Set(results.map(r=>r.data.account.uuid)).size,1);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_accounts').n,1);
  assert.equal((await admin(x,'accounts',{method:'POST',body:{...body,total_bytes:2000}})).data.error,'idempotency_conflict');
});
test('zero limits and a daily limit greater than total are rejected, never marketed as unlimited',async t=>{
  const x=await f(t);for(const [total,daily]of [[0,1],[1,0],[10,11],[-1,1]]){const res=await admin(x,'accounts',{method:'POST',body:{name:'invalid',days:1,total_bytes:total,daily_bytes:daily,conn_limit:1,protocol:'vless',node_mode:'all',nodes:[],nonce:id()}});assert.equal(res.response.status,400);}assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_accounts').n,0);
});
test('one total/day pool spans both nodes and unused credits are returned exactly once',async t=>{
  const x=await f(t),a=await create(x,{total_bytes:200000,daily_bytes:100000});const one=await open(x,0,a),two=await open(x,1,a);
  assert.equal(one.response.status,200);assert.equal(two.response.status,200);assert.equal(one.data.lease.granted+two.data.lease.granted,100000);assert.equal(usage(x,a).charged,100000);
  const closed=await Promise.all(Array.from({length:12},()=>close(x,0,one,1000,2000)));assert.ok(closed.every(r=>r.response.ok));assert.equal(usage(x,a).charged,34464+3000);assert.equal(usage(x,a).up,1000);assert.equal(usage(x,a).down,2000);
  await close(x,1,two,4000,5000);assert.equal(usage(x,a).charged,12000);assert.equal(usage(x,a).up+usage(x,a).down,12000);
  assert.equal(x.DB.row('SELECT SUM(charged) AS n FROM nx3_node_usage WHERE account_id=?',a.id).n,12000);
});
test('simultaneous grants on many connections cannot over-allocate the shared allowance',async t=>{
  const x=await f(t),a=await create(x,{total_bytes:131072,daily_bytes:131072,conn_limit:32});
  const results=await Promise.all(Array.from({length:20},(_,i)=>open(x,i%2,a)));
  assert.equal(results.filter(r=>r.response.ok).length,2);assert.ok(results.filter(r=>!r.response.ok).every(r=>r.data.error==='quota_exceeded'));assert.equal(usage(x,a).charged,131072);
  assert.equal(x.DB.row('SELECT SUM(granted) AS n FROM nx3_leases WHERE account_id=?',a.id).n,131072);
});
test('connection admission limit is global across nodes, not per isolate or per node',async t=>{
  const x=await f(t),a=await create(x,{conn_limit:1});const results=await Promise.all([open(x,0,a),open(x,1,a)]);assert.equal(results.filter(r=>r.response.ok).length,1);assert.equal(results.find(r=>!r.response.ok).data.error,'connection_limit');
  const index=results[0].response.ok?0:1;await close(x,index,results[index],0,0);assert.equal((await open(x,1-index,a)).response.status,200);
});
test('selected-node entitlements and per-node API keys cannot be crossed',async t=>{
  const x=await f(t),a=await create(x,{node_mode:'selected',nodes:[x.nodes[0].id]});assert.equal((await open(x,1,a)).data.error,'account_unavailable');
  const first=await open(x,0,a);assert.equal(first.response.status,200);
  assert.equal((await control(x,1,'check',{connection_id:first.body.connection_id})).data.error,'connection_expired');
  assert.equal((await control(x,0,'ping',{}, {'X-NexiUP-Node':x.nodes[1].id})).response.status,401);
  assert.equal((await control(x,0,'ping',{}, {Authorization:'Bearer '+x.env.OWNER_KEY})).response.status,401);
});
test('one stable URL emits every allowed node and every variant keeps the same identity',async t=>{
  const x=await f(t,3),a=await create(x),token=a.subscription_url.split('/').pop();
  const response=await manager.fetch(new Request(a.subscription_url+'?format=xray'),x.env,{});assert.equal(response.status,200);const configs=await response.json();assert.equal(configs.length,18);
  const hosts=new Set();for(const c of configs){const o=c.outbounds[0];assert.equal(o.protocol==='vless'?o.settings.vnext[0].users[0].id:o.settings.servers[0].password,a.uuid);hosts.add(o.streamSettings.wsSettings.headers.Host);assert.equal(o.streamSettings.wsSettings.path,'/connect');assert.equal(o.streamSettings.tlsSettings.allowInsecure,false);}assert.equal(hosts.size,3);
  const qr=await manager.fetch(new Request(a.subscription_url+'?format=qr'),x.env,{});assert.equal(qr.status,200);assert.equal(decodeFixturePng(new Uint8Array(await qr.arrayBuffer())),a.subscription_url);assert.equal(token.length,64);
  assert.ok(response.headers.get('Subscription-UserInfo').includes('total='+a.total_bytes));
  const page=await manager.fetch(new Request(a.subscription_url,{headers:{Accept:'text/html'}}),x.env,{});assert.match(page.headers.get('Content-Security-Policy'),/img-src 'self'/);assert.match(await page.text(),/00:00 UTC/);
});
test('enabling an additional node makes all-mode accounts usable there without re-provisioning',async t=>{
  const x=await f(t,3);x.DB.exec('UPDATE nx3_nodes SET enabled=0 WHERE id=?',x.nodes[2].id);const a=await create(x);
  let res=await manager.fetch(new Request(a.subscription_url+'?format=xray'),x.env,{});assert.equal((await res.json()).length,12);assert.equal((await open(x,2,a)).data.error,'account_unavailable');
  x.DB.exec('UPDATE nx3_nodes SET enabled=1 WHERE id=?',x.nodes[2].id);res=await manager.fetch(new Request(a.subscription_url+'?format=xray'),x.env,{});assert.equal((await res.json()).length,18);assert.equal((await open(x,2,a)).response.status,200);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_accounts').n,1);
});
test('Trojan authorization uses the exact account credential hash, not a node master key',async t=>{
  const x=await f(t),a=await create(x);const result=await open(x,0,a,{protocol:'trojan',identity:sha224(a.uuid)});assert.equal(result.response.status,200);
  assert.equal((await open(x,1,a,{protocol:'trojan',identity:sha224(x.nodes[1].key)})).data.error,'account_unavailable');
});
test('pause, revocation, expiry, disabled nodes and protocol changes deny new admission and refresh',async t=>{
  const x=await f(t),a=await create(x);const opened=await open(x,0,a);
  let changed=await action(x,a,'pause');assert.equal(changed.response.status,200);assert.equal((await open(x,1,a)).data.error,'account_unavailable');assert.equal((await control(x,0,'check',{connection_id:opened.body.connection_id})).data.error,'account_unavailable');
  changed=await action(x,changed.data.account,'resume');assert.equal(changed.response.status,200);assert.equal((await control(x,0,'check',{connection_id:opened.body.connection_id})).response.status,200);
  x.DB.exec('UPDATE nx3_nodes SET enabled=0 WHERE id=?',x.nodes[0].id);assert.equal((await control(x,0,'check',{connection_id:opened.body.connection_id})).data.error,'account_unavailable');assert.equal((await close(x,0,opened,1,2)).response.status,200); // Disabled nodes can settle but not spend.
  x.DB.exec('UPDATE nx3_accounts SET expires_at=? WHERE id=?',Date.now()-1,a.id);assert.equal((await open(x,1,a)).data.error,'account_unavailable');
});
test('reports are bound to the node/connection and cannot exceed credits or refund a closed lease twice',async t=>{
  const x=await f(t),a=await create(x),opened=await open(x,0,a);
  assert.equal((await close(x,1,opened,0,0)).response.status,404);
  assert.equal((await close(x,0,opened,opened.data.lease.granted+1,0)).response.status,409);
  assert.equal((await close(x,0,opened,100,200)).response.status,200);
  assert.equal((await close(x,0,opened,100,200)).response.status,200);assert.equal(usage(x,a).charged,300);
  assert.equal((await close(x,0,opened,0,0)).data.error,'invalid_report');assert.equal(usage(x,a).charged,300);
});
test('credit rollover atomically settles the previous lease and keeps replays single-use',async t=>{
  const x=await f(t),a=await create(x,{total_bytes:500000,daily_bytes:200000});const first=await open(x,0,a),leaseId=id();
  const body={connection_id:first.body.connection_id,lease_id:leaseId,wanted:MAX_GRANT,previous:{lease_id:first.data.lease.id,up:5000,down:6000}};
  const results=await Promise.all(Array.from({length:5},()=>control(x,0,'grant',body)));assert.ok(results.every(r=>r.response.status===200));assert.equal(new Set(results.map(r=>r.data.lease.id)).size,1);
  assert.equal(usage(x,a).charged,200000);assert.equal(usage(x,a).up+usage(x,a).down,11000);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_leases WHERE connection_id=?',first.body.connection_id).n,2);
  const closed=await control(x,0,'close',{connection_id:first.body.connection_id,report:{lease_id:leaseId,up:12,down:34}});assert.equal(closed.response.status,200);assert.equal(usage(x,a).charged,11046);
  assert.equal((await control(x,0,'grant',body)).data.error,'connection_expired');
});
test('editing below outstanding quota or using a stale version cannot change memberships',async t=>{
  const x=await f(t),a=await create(x),opened=await open(x,0,a);assert.equal(opened.response.status,200);
  let res=await admin(x,'accounts/'+a.id,{method:'PUT',body:editable(a,{total_bytes:10,daily_bytes:10,node_mode:'selected',nodes:[x.nodes[1].id]})});assert.equal(res.response.status,409);assert.equal(x.DB.row('SELECT node_mode FROM nx3_accounts WHERE id=?',a.id).node_mode,'all');assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_members WHERE account_id=?',a.id).n,0);
  res=await admin(x,'accounts/'+a.id,{method:'PUT',body:editable(a,{node_mode:'selected',nodes:[x.nodes[1].id],version:999})});assert.equal(res.response.status,409);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_members WHERE account_id=?',a.id).n,0);
});
test('renewal is durable/idempotent, extends the future expiry, and does not silently reset usage',async t=>{
  const x=await f(t),a=await create(x),opened=await open(x,0,a);await close(x,0,opened,70,30);const nonce=id(),body={action:'renew',version:a.version,nonce,days:2,reset:false,confirm:a.id};
  const results=await Promise.all(Array.from({length:8},()=>admin(x,'accounts/'+a.id+'/action',{method:'POST',body})));assert.ok(results.every(r=>r.response.status===200));assert.equal(x.DB.row('SELECT expires_at FROM nx3_accounts WHERE id=?',a.id).expires_at,a.expires_at+2*DAY);assert.equal(usage(x,a).charged,100);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_mutations').n,1);
  assert.equal((await admin(x,'accounts/'+a.id+'/action',{method:'POST',body:{...body,days:3}})).data.error,'idempotency_conflict');
});
test('usage reset has a drain window and late settlement cannot debit the new epoch',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);const x=await f(t),a=await create(x),old=await open(x,0,a);
  const reset=await action(x,a,'reset');assert.equal(reset.response.status,200);const next=reset.data.account;assert.equal(next.epoch,a.epoch+1);assert.equal(next.charged,0);assert.equal((await open(x,1,next)).data.error,'account_unavailable');
  assert.equal((await control(x,0,'check',{connection_id:old.body.connection_id})).data.error,'account_unavailable');
  clock+=PERMIT_MS+2000;const current=await open(x,1,next);assert.equal(current.response.status,200);const before=usage(x,next).charged;
  assert.equal((await close(x,0,old,5,6)).response.status,200);assert.equal(usage(x,next).charged,before);assert.equal(usage(x,a).charged,11);
});
test('rotating identity preserves quota, invalidates old admission and keeps the subscription URL',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);const x=await f(t),a=await create(x),old=await open(x,0,a);
  const result=await action(x,a,'rotate-identity');assert.equal(result.response.status,200);const next=result.data.account;assert.notEqual(next.uuid,a.uuid);assert.equal(next.epoch,a.epoch);assert.equal(next.charged,usage(x,a).charged);assert.equal(next.subscription_url,a.subscription_url);
  assert.equal((await open(x,1,a)).data.error,'account_unavailable');clock+=PERMIT_MS+2000;assert.equal((await open(x,1,next)).response.status,200);await close(x,0,old,8,9);assert.ok(usage(x,next).charged>=17);
});
test('rotating only the link does not pretend to revoke downloaded configurations',async t=>{
  const x=await f(t),a=await create(x),result=await action(x,a,'rotate-token');const next=result.data.account;assert.notEqual(next.token,a.token);assert.equal(next.uuid,a.uuid);assert.equal((await manager.fetch(new Request(a.subscription_url),x.env,{})).status,404);assert.equal((await open(x,0,a)).response.status,200);
});
test('UTC rollover refreshes daily allowance but not the global total; old connections cannot cross midnight',async t=>{
  let clock=Date.parse('2026-10-23T23:59:50Z');t.mock.method(Date,'now',()=>clock);const x=await f(t),a=await create(x,{days:3,total_bytes:1000,daily_bytes:100}),old=await open(x,0,a);assert.equal(old.data.hard_until,Date.parse('2026-10-24T00:00:00Z'));await close(x,0,old,40,40);
  clock+=20000;assert.equal((await control(x,0,'check',{connection_id:old.body.connection_id})).data.error,'connection_expired');const next=await open(x,1,a);assert.equal(next.response.status,200);assert.equal(next.data.lease.granted,100);assert.equal(usage(x,a).charged,180);assert.equal(x.DB.row('SELECT charged FROM nx3_daily WHERE account_id=? AND day=?',a.id,'2026-10-23').charged,80);
});
test('lost-node reservations are not falsely refunded; pruning retains all aggregate counters',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);const x=await f(t),a=await create(x,{days:30}),opened=await open(x,0,a),charged=opened.data.lease.granted;
  clock+=8*DAY;await maintenance(managerDb(x.env));assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_leases').n,0);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_connections').n,0);assert.equal(usage(x,a).charged,charged);
  const detail=(await requireAdmin(x,'accounts/'+a.id)).account;assert.equal(detail.node_usage[0].uncertain,charged);assert.equal(detail.up+detail.down,0);
});
test('missing enforcement triggers fail closed even after a successful initialization',async t=>{
  const x=await f(t),a=await create(x);x.DB.sqlite.exec('DROP TRIGGER nx3_grant_charge');const res=await open(x,0,a);assert.equal(res.response.status,503);assert.equal(res.data.error,'schema_incomplete');assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_connections').n,0);
});
test('profile changes are isolated and versioned, rollback is monotonic, and incompatible formats fail explicitly',async t=>{
  const x=await f(t),a=await create(x),profiles=(await requireAdmin(x,'profiles')).items,ir=profiles.find(p=>p.profile.id==='irancell'),hamrah=x.DB.row("SELECT data FROM nx3_profiles WHERE id='hamrah'").data;
  const profile={...ir.profile,label:'Synthetic changed profile'};await requireAdmin(x,'profiles',{method:'PUT',body:{profile,version:ir.version}});assert.equal(x.DB.row("SELECT data FROM nx3_profiles WHERE id='hamrah'").data,hamrah);
  await requireAdmin(x,'profiles/rollback',{method:'POST',body:{id:profile.id,version:2}});assert.equal(x.DB.row("SELECT version FROM nx3_profiles WHERE id='irancell'").version,3);
  const bad={...profile,cipher_suites:'UNSUPPORTED'};assert.equal((await admin(x,'profiles',{method:'PUT',body:{profile:bad,version:3}})).response.status,400);assert.equal(x.DB.row("SELECT version FROM nx3_profiles WHERE id='irancell'").version,3);
  const response=await manager.fetch(new Request(a.subscription_url+'?format=clash'),x.env,{});assert.equal(response.status,422);
});
test('concurrent profile edits cannot disable every output variant',async t=>{
  const x=await f(t),profiles=(await requireAdmin(x,'profiles')).items.filter(p=>p.profile.enabled);
  const results=await Promise.all(profiles.map(row=>admin(x,'profiles',{method:'PUT',body:{profile:{...row.profile,enabled:false},version:row.version}})));
  assert.equal(results.filter(r=>r.response.status===200).length,1);assert.equal(results.find(r=>r.response.status!==200).data.error,'profile_variant_budget');
  assert.ok(x.DB.row("SELECT SUM(json_extract(data,'$.enabled')) AS n FROM nx3_profiles").n>=1);
});

test('an HTTP 200 node cannot fake a bidirectional proof by echoing public metadata',async t=>{
  const x=await f(t);
  t.mock.method(globalThis,'fetch',async(_input,init)=>Response.json({component:'node',protocol:'nexiup-mesh/1',version:'3.0.0',node_id:x.nodes[0].id,challenge:init.headers['X-NexiUP-Challenge'],manager_origin:managerOrigin,manager_reachable:true}));
  const result=await requireAdmin(x,'nodes/'+x.nodes[0].id+'/test',{method:'POST',body:{}});assert.equal(result.ok,false);assert.equal(result.error,'bidirectional_probe_not_observed');assert.equal(x.DB.row('SELECT enabled FROM nx3_nodes WHERE id=?',x.nodes[0].id).enabled,0);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_probes').n,0);
});
test('owner QR is authenticated and available for a paused account without reactivating its public subscription',async t=>{
  const x=await f(t),a=await create(x);await action(x,a,'pause');const writes=x.DB.writes;
  let response=await manager.fetch(ownerRequest('accounts/'+a.id+'/qr',x.env,{owner:false}),x.env,{});assert.equal(response.status,401);
  response=await manager.fetch(ownerRequest('accounts/'+a.id+'/qr',x.env),x.env,{});assert.equal(response.status,200);assert.equal(decodeFixturePng(new Uint8Array(await response.arrayBuffer())),a.subscription_url);
  assert.equal((await manager.fetch(new Request(a.subscription_url+'?format=qr'),x.env,{})).status,403);assert.equal(x.DB.writes,writes);
});
