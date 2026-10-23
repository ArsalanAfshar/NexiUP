// Deployed-entrypoint regressions: no dev proxy, no automatic login, no real secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { runtime, migrate, ready, initialized, Fault, requestFailure, setupPage } from '../worker.js';
import { Script } from 'node:vm';
import { fixture, FakeD1 } from './helpers.mjs';
const origin='https://deployment.example.test';
const key='synthetic_only_'+('a'.repeat(40));
const config=()=>({ROLE:'all',SETUP_KEY:key,MASTER_KEY:'synthetic_only_'+('b'.repeat(40)),CALLBACK_SECRET:'c'.repeat(40),WEBHOOK_SECRET:'d'.repeat(40),ADMIN_IDS:'901',BOT_TOKEN:'synthetic_bot_token'});
const req=(path,body)=>new Request(origin+path,body===undefined?{}:{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});
const failingDB=value=>({prepare(){return{bind(){return{async run(){throw value;},async first(){throw value;},async all(){throw value;}};}};},async batch(){throw value;}});

test('public bootstrap and liveness never dereference a broken deployment binding',async()=>{
  const env=config();let reads=0;
  Object.defineProperty(env,'DB',{get(){reads++;throw new Error('SYNTHETIC_PRIVATE_BINDING_DETAILS');}});
  for(const path of ['/','/health','/admin','/setup']){
    const response=await worker.fetch(req(path),env,{});
    assert.equal(response.status,200,path);assert.ok(!(await response.text()).includes('SYNTHETIC_PRIVATE_BINDING_DETAILS'));
  }
  assert.equal(reads,0);
});
test('the liveness endpoint can identify the deployment without any environment or D1',async()=>{
  const response=await worker.fetch(req('/health'),undefined,{});assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.status,'alive');assert.equal(data.database_checked,false);
  assert.equal(response.headers.get('X-NexiUP-Version'),data.version);
});
test('lazy binding getter failures stay inside the request boundary',async()=>{
  const env=config();Object.defineProperty(env,'DB',{get(){throw new TypeError('PRIVATE_BINDING_VALUE');}});
  const response=await worker.fetch(req('/setup',{action:'migrate'}),env,{});
  assert.equal(response.status,503);const data=await response.json();assert.equal(data.error,'d1_binding_unavailable');assert.ok(!JSON.stringify(data).includes('PRIVATE_BINDING_VALUE'));
});
for(const [label,value] of [['null',null],['undefined',undefined],['string','PRIVATE_THROWN_STRING'],['number',123]])test('a '+label+' rejection cannot crash the error handler into Cloudflare 1101',async()=>{
  const response=await worker.fetch(req('/setup',{action:'migrate'}),{...config(),DB:failingDB(value)},{});
  assert.equal(response.status,503);const text=await response.text(),data=JSON.parse(text);
  assert.equal(data.error,'d1_unavailable');assert.ok(data.request_id);assert.ok(!text.includes('PRIVATE_THROWN_STRING'));
});
test('absent and wrongly typed bindings produce actionable errors, not an exception page',async()=>{
  for(const [binding,error]of [[undefined,'d1_binding_missing'],['not_a_d1_binding','d1_binding_invalid'],[{get(){},put(){}},'d1_binding_invalid']]){
    const response=await worker.fetch(req('/setup',{action:'migrate'}),{...config(),DB:binding},{});assert.equal(response.status,503);assert.equal((await response.json()).error,error);
  }
});
test('deployment failures carry only safe correlation metadata; diagnostics logging is opt-in',async t=>{
  const marker='NEVER_EMIT_SYNTHETIC_SECRET',failure=new Error('Bearer '+marker+' https://node.example.test/sub/'+marker);
  failure.stack='Error: '+marker+'\n    at query (worker.js:123:45)\n    at '+marker+' (https://example.test/sub/'+marker+':4:5)';
  const logs=[];t.mock.method(console,'error',(...args)=>logs.push(args));
  let response=await worker.fetch(req('/setup',{action:'migrate'}),{...config(),DB:failingDB(failure)},{});assert.equal(response.status,503);assert.equal(logs.length,0);
  response=await worker.fetch(req('/setup',{action:'migrate'}),{...config(),DB:failingDB(failure),NEXIUP_DIAGNOSTICS:'true'},{});
  const body=await response.json();assert.ok(body.request_id);assert.equal(response.headers.get('X-NexiUP-Request-ID'),body.request_id);assert.equal(logs.length,1);
  const serialized=JSON.stringify(logs);assert.ok(!serialized.includes(marker));assert.ok(!serialized.includes('/sub/'));assert.ok(!serialized.includes('Bearer'));
  const event=JSON.parse(logs[0][0]);assert.equal(event.event,'nexiup_runtime_error');assert.equal(event.request_id,body.request_id);assert.equal(event.surface,'setup');assert.equal(event.line,123);
});
test('hostile error getters and a failing logger cannot cause a second exception',async t=>{
  const error=new Proxy({}, {get(){throw new Error('PRIVATE_GETTER');},getPrototypeOf(){throw new Error('PRIVATE_PROTOTYPE');}});
  t.mock.method(console,'error',()=>{throw new Error('PRIVATE_LOGGER');});
  const response=await worker.fetch(req('/setup',{action:'migrate'}),{...config(),DB:failingDB(error),NEXIUP_DIAGNOSTICS:'true'},{});
  assert.equal(response.status,503);assert.ok(!(await response.text()).includes('PRIVATE'));
});
test('owner deployment diagnostics authenticate before checking D1 and never mutate data',async t=>{
  const x=await fixture();t.after(()=>x.DB.close());const before=x.DB.writes;
  let response=await worker.fetch(new Request(origin+'/setup',{method:'POST',body:JSON.stringify({action:'diagnostics'})}),x.env,{});assert.equal(response.status,401);assert.equal(x.DB.writes,before);
  response=await worker.fetch(new Request(origin+'/setup',{method:'POST',headers:{Authorization:'Bearer '+x.env.SETUP_KEY},body:JSON.stringify({action:'diagnostics'})}),x.env,{});
  assert.equal(response.status,200);const text=await response.text(),data=JSON.parse(text);
  assert.equal(data.database.status,'ok');assert.equal(data.schema.status,'ready');assert.equal(data.schema.version,5);assert.equal(data.external_connectivity_tested,false);assert.equal(x.DB.writes,before);
  for(const value of [x.env.SETUP_KEY,x.env.MASTER_KEY,x.env.CALLBACK_SECRET,x.env.BOT_TOKEN])assert.ok(!text.includes(value));
});
test('deployment diagnostics report missing D1 without pretending that liveness is readiness',async()=>{
  const response=await worker.fetch(req('/setup',{action:'diagnostics'}),config(),{});
  assert.equal(response.status,503);const data=await response.json();assert.equal(data.database.status,'d1_binding_missing');assert.equal(data.ready,false);
});

const ownerRequest=(env,body,bearer=env.ROLE==='node'?env.MASTER_KEY:env.SETUP_KEY,headers={})=>new Request(origin+'/setup',{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});

test('unauthorized preflight, invalid origins and HTTP writes cannot touch D1',async()=>{
  const env=config();let reads=0;Object.defineProperty(env,'DB',{get(){reads++;throw new Error('DO_NOT_READ');}});
  for(const request of [ownerRequest(env,{action:'diagnostics'},'wrong'),ownerRequest(env,{action:'diagnostics'},key,{Origin:'https://other.example.test'}),new Request('http://deployment.example.test/setup',{method:'POST',headers:{Authorization:'Bearer '+key},body:'{"action":"diagnostics"}'})]){
    const res=await worker.fetch(request,env,{});assert.ok([400,401,403].includes(res.status));
  }
  assert.equal(reads,0);
});
test('a dedicated web key grants read-only diagnostics, not setup mutations or node credentials',async t=>{
  const x=await fixture();t.after(()=>x.DB.close());x.env.WEB_ADMIN_KEY='w'.repeat(48);const before=x.DB.writes;
  let res=await worker.fetch(ownerRequest(x.env,{action:'diagnostics'},x.env.WEB_ADMIN_KEY),x.env,{});assert.equal(res.status,200);
  for(const action of ['migrate','configure','tick','webhook','legacy']){
    res=await worker.fetch(ownerRequest(x.env,{action},x.env.WEB_ADMIN_KEY),x.env,{});assert.equal(res.status,401,action);
  }
  res=await worker.fetch(ownerRequest(x.env,{action:'diagnostics'},x.env.MASTER_KEY),x.env,{});assert.equal(res.status,401);
  assert.equal(x.DB.writes,before);
});
test('node preflight requires its owner key and does not require Telegram configuration',async t=>{
  const x=await fixture('node');t.after(()=>x.DB.close());delete x.env.BOT_TOKEN;delete x.env.CALLBACK_SECRET;delete x.env.WEBHOOK_SECRET;delete x.env.ADMIN_IDS;
  let res=await worker.fetch(ownerRequest(x.env,{action:'diagnostics'}),x.env,{});assert.equal(res.status,200);const data=await res.json();assert.equal(data.ready,true);assert.deepEqual(Object.keys(data.configuration.checks).sort(),['master_key','owner_key']);
  res=await worker.fetch(ownerRequest(x.env,{action:'diagnostics'},x.env.SETUP_KEY),x.env,{});assert.equal(res.status,401);
});
test('preflight distinguishes a fresh database, incomplete seeding and a newer unsupported schema',async t=>{
  const DB=new FakeD1(),env={...config(),DB};t.after(()=>DB.close());
  let res=await worker.fetch(ownerRequest(env,{action:'diagnostics'}),env,{}),data=await res.json();
  assert.equal(res.status,503);assert.equal(data.database.status,'ok');assert.equal(data.schema.status,'migration_required');assert.equal(data.schema.version,0);assert.equal(DB.writes,0);assert.ok(data.schema.missing_tables.includes('schema_version'));
  for(let i=0;i<5;i++)assert.equal((await migrate(runtime(env))).ready,false);
  const writes=DB.writes;res=await worker.fetch(ownerRequest(env,{action:'diagnostics'}),env,{});data=await res.json();assert.equal(data.schema.status,'seed_required');assert.equal(data.schema.version,5);assert.equal(DB.writes,writes);
  assert.equal((await migrate(runtime(env))).ready,true);res=await worker.fetch(ownerRequest(env,{action:'diagnostics'}),env,{});data=await res.json();assert.equal(data.ready,true);assert.ok(data.statements<=4);
  DB.exec('INSERT INTO schema_version(version,applied_at) VALUES(99,0)');res=await worker.fetch(ownerRequest(env,{action:'diagnostics'}),env,{});data=await res.json();assert.equal(data.schema.status,'newer_than_worker');assert.equal(data.ready,false);
  await assert.rejects(migrate(runtime(env)),e=>e.code==='schema_newer_than_worker');initialized.delete(DB);await assert.rejects(ready(runtime(env)),e=>e.code==='schema_newer_than_worker');
});
test('preflight bypasses the readiness cache and notices a missing migration table',async t=>{
  const x=await fixture();t.after(()=>x.DB.close());await ready(x.r());assert.equal(initialized.has(x.DB),true);
  x.DB.sqlite.exec('DROP TABLE nx_proxy_policies');const before=x.DB.writes;
  const res=await worker.fetch(ownerRequest(x.env,{action:'diagnostics'}),x.env,{}),data=await res.json();assert.equal(res.status,503);assert.equal(data.schema.status,'incomplete');assert.deepEqual(data.schema.missing_tables,['nx_proxy_policies']);assert.equal(x.DB.writes,before);
});
test('an operational D1 outage is not misreported as run_setup_migrations',async()=>{
  const env={...config(),DB:failingDB(new Error('D1_ERROR: upstream unavailable PRIVATE_INTERNAL_DETAILS'))};
  const res=await worker.fetch(req('/sync/api/users'),env,{}),body=await res.json();assert.equal(res.status,503);assert.equal(body.error,'d1_unavailable');assert.ok(!JSON.stringify(body).includes('PRIVATE_INTERNAL_DETAILS'));
  const DB=new FakeD1();try{await assert.rejects(ready(runtime({...config(),DB})),e=>e.code==='run_setup_migrations');}finally{DB.close();}
});
test('a safe read deadline does not impose a deadline or retry on mutations',async t=>{
  const realTimer=setTimeout;let deadlineTimers=0,commits=0;
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms===8000)deadlineTimers++;return realTimer(fn,ms===8000?5:ms,...args);});
  const DB={prepare(){return{bind(){return{first:()=>new Promise(()=>{}),all:()=>new Promise(()=>{}),run:async()=>{await new Promise(resolve=>realTimer(resolve,15));commits++;return{meta:{changes:1}};}};}};},async batch(){await new Promise(resolve=>realTimer(resolve,15));commits++;return[];}};
  const r=runtime({...config(),DB});await assert.rejects(r.first('SELECT 1'),e=>e.code==='d1_read_timeout');await assert.rejects(r.all('SELECT 1'),e=>e.code==='d1_read_timeout');
  assert.equal(deadlineTimers,2);await r.run('UPDATE synthetic_table SET value=1');await r.batch([['INSERT INTO synthetic_table VALUES(1)']]);assert.equal(deadlineTimers,2);assert.equal(commits,2);
});
test('a pending D1 read produces a bounded diagnostic response instead of an unresolved request',async t=>{
  const realTimer=setTimeout;t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>realTimer(fn,ms===8000?5:ms,...args));
  let statements=0;const DB={prepare(){statements++;return{bind(){return{first:()=>new Promise(()=>{})};}};},async batch(){throw new Error('MUST_NOT_WRITE');}};
  const res=await worker.fetch(req('/setup',{action:'diagnostics'}),{...config(),DB},{}),data=await res.json();assert.equal(res.status,503);assert.equal(data.database.status,'d1_read_timeout');assert.equal(data.ready,false);assert.equal(statements,1);
});
test('the overall diagnostic deadline prevents additional queries after a late read completes',async t=>{
  const realTimer=setTimeout;let timers=0,statements=0,finishRead;
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>realTimer(fn,ms===8000?(++timers===2?5:100):ms,...args));
  const DB={prepare(){statements++;return{bind(){return{async first(){return{connected:1};},all:()=>new Promise(resolve=>{finishRead=resolve;})};}};},async batch(){throw new Error('MUST_NOT_WRITE');}};
  const res=await worker.fetch(req('/setup',{action:'diagnostics'}),{...config(),DB},{});assert.equal(res.status,503);assert.equal((await res.json()).database.status,'d1_read_timeout');assert.equal(statements,2);
  finishRead({results:[{name:'schema_version'}]});await new Promise(resolve=>realTimer(resolve,2));assert.equal(statements,2);
});
test('the request boundary catches failures before routing and keeps invalid role data private',async()=>{
  const env=config();Object.defineProperty(env,'ROLE',{get(){throw new Error('PRIVATE_ROLE');}});
  for(const path of ['/health','/admin','/setup','/']){const res=await worker.fetch(req(path),env,{});assert.equal(res.status,200);assert.ok(!(await res.text()).includes('PRIVATE_ROLE'));}
  const res=await worker.fetch(req('/sync/api/users'),env,{});assert.equal(res.status,500);const data=await res.json();assert.equal(data.error,'internal_error');assert.ok(data.request_id);
  const early=await worker.fetch({get url(){throw undefined;}},config(),{});assert.equal(early.status,500);
});
test('scheduled initialization errors are contained and safe logging preserves waitUntil semantics',async t=>{
  const logs=[],pending=[];t.mock.method(console,'error',text=>logs.push(JSON.parse(text)));
  const env={...config(),DB:failingDB(null),NEXIUP_DIAGNOSTICS:'true'};
  await worker.scheduled({scheduledTime:Date.now()},env,{waitUntil(promise){pending.push(promise);}});assert.equal(pending.length,1);await Promise.all(pending);assert.equal(logs.length,1);assert.equal(logs[0].surface,'scheduled');assert.equal(logs[0].code,'d1_unavailable');
  await worker.scheduled({scheduledTime:Date.now()},undefined,undefined);
});
test('source-position logs do not copy fake message frames, paths or request query tokens',async t=>{
  const marker='PRIVATE_QUERY_VALUE',logs=[];t.mock.method(console,'error',text=>logs.push(JSON.parse(text)));
  const error=new Error(marker);error.stack='Error: '+marker+' worker.js:444:555\n    at local (file:///private/'+marker+'/worker.js:123:7)';
  const env={...config(),DB:failingDB(error),NEXIUP_DIAGNOSTICS:'true'};
  const res=await worker.fetch(req('/setup?token='+marker,{action:'migrate'}),env,{});assert.equal(res.status,503);assert.equal(logs[0].line,123);assert.equal(logs[0].column,7);assert.ok(!JSON.stringify(logs).includes(marker));assert.equal(logs[0].surface,'setup');
});
test('the last-resort boundary never rethrows even if a trusted error is corrupted',async()=>{
  const failure=new Fault('internal_error',500);Object.defineProperty(failure,'status',{get(){throw undefined;}});
  const res=requestFailure(failure,req('/setup'),config(),undefined);assert.equal(res.status,500);assert.deepEqual(await res.json(),{error:'internal_error'});
});
test('setup diagnostics UI is self-contained, syntactically valid and readiness-driven',async()=>{
  const response=setupPage(),markup=await response.text();assert.match(markup,/id="diagnostics"/);assert.match(markup,/Check deployment/);assert.match(markup,/2\.1\.2/);assert.match(markup,/if\(d\.ready\)return/);
  const script=markup.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>new Script(script));assert.ok(!script.includes('localStorage'));assert.ok(!script.includes('sessionStorage'));
});
