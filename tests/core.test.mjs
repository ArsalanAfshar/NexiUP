import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import worker, {
  VERSION, DAY, GIB, runtime, migrate, MIGRATIONS, DEFAULT_PROFILES, aggregate,
  validateProfile, saveProfile, profiles, rollbackProfile, variantUri, parseBaseUri,
  renderSubscription, xrayConfig, mainSubscriptionUrl, safeConfigParts,
  panelCreate, panelGet, panelMutate, nodeRequest, eligibleNodes, lock,
  requestTest, resetTestCooldown, approveOrder, finishOrder, walletPay, submitReceipt,
  processOp, processJob, queueFallback, createOrder, applyCoupon, requestWithdrawal,
  callback, verifyCallback, webhook, handleUpdate, qrPng, qrMatrix,
  sha224, parseTunnelHeader, trackBytes, flushUsage, validateNode, validatePlan,
  validateTestSettings, renewalExpiry, publicHost
} from '../worker.js';
import { fixture, node, plan, pendingOrder, testSettings, uri, mockNetwork } from './helpers.mjs';

const clonedProfiles = () => structuredClone(DEFAULT_PROFILES);
async function f(t, role) { const x = await fixture(role); t.after(() => x.DB.close()); return x; }

// Source-compatible profile fixtures are deliberately synthetic; no production identities.
test('supplied defaults preserve exact distinct operator settings', () => {
  const ps = clonedProfiles();
  assert.equal(ps[0].fingerprint, 'unsafe');
  assert.deepEqual(ps[0].finalmask.tcp[0].settings.lengths, ['0','104','1']);
  assert.equal(ps[0].cipher_suites.split(':').length, 13);
  assert.deepEqual(ps[1].ech, ['cloudflare-ech.com+udp://1.1.1.1','cloudflare-ech.com+udp://8.8.8.8']);
  ps.forEach(validateProfile);
  const before = JSON.stringify(ps[1]); ps[0].fingerprint = 'chrome'; assert.equal(JSON.stringify(ps[1]), before);
});
test('invalid masks, fields, ranges and combined ECH cannot become active', () => {
  for (const modify of [p => p.finalmask.tcp[0].settings.lengths=['0'], p => p.finalmask.tcp[0].settings.delays=['-1'], p => p.finalmask.tcp.push({type:'unknown'}), p => p.fingerprint='madeup', p => p.cipher_suites='TLS_INVENTED', p => p.secret='leak']) {
    const p = clonedProfiles()[0]; modify(p); assert.throws(() => validateProfile(p));
  }
  const p = clonedProfiles()[1]; p.ech = [p.ech.join(',')]; assert.throws(() => validateProfile(p));
});
test('aggregation uses one identity: Irancell plus two scalar ECH variants', () => {
  const id = crypto.randomUUID(), bases = [uri(id), uri(id)];
  const variants = aggregate(bases, clonedProfiles());
  assert.equal(variants.length, 3);
  assert.equal(new Set(variants.map(v => v.id)).size, 1);
  const mci = variants.filter(v => v.profile === 'hamrah');
  assert.equal(new Set(mci.map(v => xrayConfig(v).outbounds[0].streamSettings.tlsSettings.echConfigList)).size, 2);
  for (const v of mci) assert.equal(v.finalmask, null);
  const u = new URL(variantUri(variants.find(v=>v.profile==='irancell')));
  assert.deepEqual(JSON.parse(u.searchParams.get('fm')), DEFAULT_PROFILES[0].finalmask);
  assert.equal(u.searchParams.get('cs'), DEFAULT_PROFILES[0].cipher_suites);
  assert.equal(u.searchParams.get('path'), '/sync/ws?ed=2048');
  assert.match(decodeURIComponent(u.hash), /ایرانسل/);
});
test('one or both ECH resolver selections really change generated entries', () => {
  for (const size of [1,2]) {
    const ps=clonedProfiles(); ps[1].ech=ps[1].ech.slice(0,size);
    const vs=aggregate([uri()],ps); assert.equal(vs.length,1+size);
    assert.equal(vs.filter(v=>new URL(variantUri(v)).searchParams.has('ech')).length,size);
  }
});
test('all formats parse; advanced variants never silently become generic Clash/sing-box', () => {
  const variants=aggregate([uri()],clonedProfiles());
  assert.equal(atob(renderSubscription(variants).body).split('\n').length,3);
  const json=JSON.parse(renderSubscription(variants,'xray').body);assert.equal(json.length,3);
  for(const c of json){assert.ok(c.outbounds[0].streamSettings.wsSettings.path);assert.equal(c.outbounds[0].streamSettings.security,'tls');}
  assert.throws(()=>renderSubscription(variants,'clash'),/format_cannot/);
  assert.throws(()=>renderSubscription(variants,'sing-box'),/format_cannot/);
  const ps=clonedProfiles();ps[2].enabled=true;const all=aggregate([uri()],ps);
  const clash=renderSubscription(all,'clash');assert.ok(clash.warnings.length);const c=JSON.parse(clash.body.split('\n').filter(s=>!s.startsWith('#')).join('\n'));assert.equal(c.proxies.length,1);assert.equal(c.proxies[0].network,'ws');
  const sing=JSON.parse(renderSubscription(all,'sing-box').body);assert.equal(sing.outbounds[1].transport.type,'ws');assert.equal(sing.outbounds[1].tls.insecure,false);
});
test('Trojan formats use passwords, not VLESS-only fields', () => {
  const ps=clonedProfiles();ps[0].enabled=false;ps[1].enabled=false;ps[2].enabled=true;
  const variants=aggregate([uri().replace('vless://','trojan://')],ps);
  assert.ok(xrayConfig(variants[0]).outbounds[0].settings.servers[0].password);
  const c=JSON.parse(renderSubscription(variants,'sing-box').body);assert.ok(c.outbounds[1].password);assert.equal(c.outbounds[1].uuid,undefined);
});
test('schema migrations are lazy, versioned, repeatable and under D1 statement limit', async t => {
  const x=await f(t);assert.equal(x.DB.row('SELECT MAX(version) AS n FROM schema_version').n,MIGRATIONS.length);
  const r=x.r();const out=await migrate(r);assert.equal(out.ready,true);assert.ok(r.queries<46);assert.equal(VERSION,'2.1.0');
});
test('profile activation/rollback revisions are monotonic; invalid save leaves current intact', async t => {
  const x=await f(t);const p=clonedProfiles()[0];p.fingerprint='chrome';
  await saveProfile(x.r(),901,p,1);assert.equal((await profiles(x.r(),true)).find(p=>p.id==='irancell').version,2);
  p.fingerprint='invented';await assert.rejects(saveProfile(x.r(),901,p,2));
  assert.equal((await profiles(x.r(),true)).find(p=>p.id==='irancell').fingerprint,'chrome');
  await rollbackProfile(x.r(),901,'irancell');const rows=await profiles(x.r(),true);assert.equal(rows.find(p=>p.id==='irancell').fingerprint,'unsafe');assert.equal(rows.find(p=>p.id==='irancell').version,3);assert.equal(rows.find(p=>p.id==='hamrah').version,1);
});
test('panel POST rejects duplicate names and permits only same durable idempotency key', async t => {
  const x=await f(t),payload={name:'test_unique',trafficLimit:1,dailyLimit:0.5,expiryDays:1};
  const a=await panelCreate(x.r(),payload,'first');const b=await panelCreate(x.r(),payload,'first');assert.equal(a.id,b.id);
  await assert.rejects(panelCreate(x.r(),{...payload,name:'TEST_UNIQUE'},'other'),/duplicate_name/);
  await assert.rejects(panelCreate(x.r(),{...payload,name:'../x'}));
  const get=await panelGet(x.r(),'test_unique');assert.equal(get.trafficLimit,1);assert.equal(get.limitTotalReq,6000);assert.equal(get.dailyLimit,0.5);
});
test('normalized node concurrently creates different users without JSON-blob lost updates', async t => {
  const x=await f(t);
  await Promise.all(Array.from({length:12},(_,i)=>panelCreate(x.r(),{name:'parallel_'+i,expiryDays:1},'key_'+i)));
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_panel_users').n,12);
});
test('D1 node lock serializes across runtimes and never falls back to memory on DB failure', async t => {
  const x=await f(t);const release=await lock(x.r(),'node:de');
  await assert.rejects(lock(x.r(),'node:de'),/busy/);await release();const next=await lock(x.r(),'node:de');await next();
  const bad={ first:async()=>{throw Error('db unavailable');} };await assert.rejects(lock(bad,'node:de'),/db unavailable/);
});
test('node assignment never crosses selected country or purpose', async t => {
  const x=await f(t);node(x,{id:'us',code:'us'});node(x,{id:'test',code:'de',purpose:'test'});
  assert.equal((await eligibleNodes(x.r(),'de','sales')).length,0);
  node(x,{id:'de',code:'de'});assert.deepEqual((await eligibleNodes(x.r(),'de','sales')).map(n=>n.id),['de']);
});
test('approval CAS and atomic provisioning prevent duplicate paid subscriptions', async t => {
  const x=await f(t);node(x);pendingOrder(x);const net=mockNetwork(t);
  await Promise.all([approveOrder(x.r(),901,'order1'),approveOrder(x.r(),901,'order1')]);
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_ops').n,1);assert.equal(x.DB.row('SELECT status FROM nx_orders').status,'processing');
  const r=x.r(),out=await processOp(r,'oorder1');assert.equal(out.state,'done');assert.ok(r.queries<=46);
  await processOp(x.r(),'oorder1');assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_subs').n,1);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_panel_users').n,1);
  assert.equal(x.DB.row('SELECT status FROM nx_orders').status,'done');assert.equal(net.calls.filter(c=>c.url.hostname.endsWith('example.test')).length,0);
});
test('non-admin cannot approve and unpaid orders cannot be approved', async t => {
  const x=await f(t);pendingOrder(x);await assert.rejects(approveOrder(x.r(),102,'order1'),/admin_required/);
  x.DB.exec("UPDATE nx_orders SET status='pending_payment',receipt=NULL");assert.equal((await approveOrder(x.r(),901,'order1')).status,'pending_payment');assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_ops').n,0);
});
test('wallet full/split retries debit exactly once and cancellation refunds exactly once', async t => {
  const x=await f(t);pendingOrder(x,'order1',{status:'pending_payment'});x.DB.exec('UPDATE nx_users SET balance=60 WHERE id=101');
  await Promise.all([walletPay(x.r(),101,'order1',true),walletPay(x.r(),101,'order1',true)]);
  assert.equal(x.DB.row('SELECT balance FROM nx_users WHERE id=101').balance,0);assert.equal(x.DB.row('SELECT wallet_paid FROM nx_orders').wallet_paid,60);
  await Promise.all([finishOrder(x.r(),'order1','cancelled','Test cancellation',101),finishOrder(x.r(),'order1','cancelled','Test cancellation',101)]);
  assert.equal(x.DB.row('SELECT balance FROM nx_users WHERE id=101').balance,60);assert.equal(x.DB.row("SELECT COUNT(*) AS n FROM nx_ledger WHERE kind='refund'").n,1);
});
test('receipt resubmission cannot reopen done/rejected orders', async t => {
  const x=await f(t);pendingOrder(x,'order1',{status:'pending_payment'});
  const rec={type:'photo',file_id:'synthetic_receipt',note:'<script>literal</script>'};await submitReceipt(x.r(),101,'order1',rec);
  x.DB.exec("UPDATE nx_orders SET status='done'");x.DB.exec('DELETE FROM nx_limits');const res=await submitReceipt(x.r(),101,'order1',rec);assert.equal(res.duplicate,true);assert.equal(x.DB.row('SELECT status FROM nx_orders').status,'done');
});
test('test defaults/configurable limits and concurrent duplicate requests yield one grant', async t => {
  const x=await f(t);node(x,{id:'test',code:'test',purpose:'test'});testSettings(x,'test',{traffic_gb:2,daily_gb:0.25,days:2,cooldown_hours:72});
  const ops=await Promise.all([requestTest(x.r(),101,'one'),requestTest(x.r(),101,'two')]);assert.equal(ops[0].id,ops[1].id);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_ops').n,1);
  const before=Date.now();const out=await processOp(x.r(),ops[0].id);assert.equal(out.state,'done');
  const user=await panelGet(x.r(),x.DB.row('SELECT remote_id FROM nx_subs').remote_id);assert.equal(user.trafficLimit,2);assert.equal(user.dailyLimit,0.25);
  const slot=x.DB.row('SELECT * FROM nx_test_slots');assert.ok(slot.next_at>=before+72*3600000);assert.equal(slot.op_id,null);assert.ok(slot.last_success>=before);
  await assert.rejects(requestTest(x.r(),101,'three'),/test_cooldown/);
  await resetTestCooldown(x.r(),901,101);await requestTest(x.r(),101,'four');assert.equal(x.DB.row("SELECT COUNT(*) AS n FROM nx_audit WHERE action='test_cooldown_reset'").n,1);
});
test('test never silently uses a sales node or consumes cooldown on known failure', async t => {
  const x=await f(t);node(x,{id:'sales'});testSettings(x,'sales');await assert.rejects(requestTest(x.r(),101,'first'),/sales_node_not/);
  node(x,{id:'test',code:'test',purpose:'test',local:false});testSettings(x,'test');
  mockNetwork(t,{node:async()=>new Response('{}',{status:401})});
  const op=await requestTest(x.r(),101,'second');const result=await processOp(x.r(),op.id);assert.equal(result.state,'failed');const slot=x.DB.row('SELECT * FROM nx_test_slots WHERE user_id=101');assert.equal(slot.next_at,0);assert.equal(slot.op_id,null);assert.equal(slot.last_success,0);assert.equal(x.DB.row('SELECT status FROM nx_test_grants').status,'failed');
});
test('Nahan request shape uses Bearer secret reference, never a master key', async t => {
  const x=await f(t,'hub');const n=node(x,{local:false,adapter:'nahan'}),net=mockNetwork(t);
  const payload={name:'shape',trafficLimit:1,dailyLimit:0.5,expiryDays:1,connLimit:1,maxConfigs:3};await nodeRequest(x.r(),n,'POST','',payload,'','shape-key');
  const c=net.calls[0];assert.equal(c.headers.Authorization,'Bearer '+x.env.NODE_KEY_DE);assert.notEqual(c.headers.Authorization,'Bearer '+x.env.MASTER_KEY);assert.deepEqual(c.payload,payload);assert.equal(c.url.pathname,'/sync/api/users');assert.equal(c.url.searchParams.has('key'),false);
});
test('preflight failure safely fails over to same location; no cross-country fallback', async t => {
  const x=await f(t,'hub');node(x,{id:'de1',local:false});node(x,{id:'de2',local:false});node(x,{id:'us',code:'us',local:false});pendingOrder(x);
  const net=mockNetwork(t,{node:async c=>c.url.hostname.startsWith('de1.')?new Response('{}',{status:503}):undefined});
  await approveOrder(x.r(),901,'order1');const result=await processOp(x.r(),'oorder1');assert.equal(result.state,'done');assert.equal(x.DB.row('SELECT node_id FROM nx_subs').node_id,'de2');assert.equal(net.calls.some(c=>c.url.hostname.startsWith('us.')),false);
});
test('ambiguous stock POST never fails over or duplicates on a missing reconciliation GET', async t => {
  const x=await f(t,'hub');node(x,{id:'de1',local:false,adapter:'nahan'});node(x,{id:'de2',local:false,adapter:'nahan'});pendingOrder(x);
  let posts=0;mockNetwork(t,{node:async c=>{if(c.method==='POST'){posts++;throw Error('simulated lost response');}}});
  await approveOrder(x.r(),901,'order1');await processOp(x.r(),'oorder1');assert.equal(posts,1);assert.equal(x.DB.row('SELECT state FROM nx_ops').state,'reconcile');
  x.DB.exec('UPDATE nx_locks SET not_before=0,until_ms=0');await processOp(x.r(),'oorder1');assert.equal(posts,1);assert.equal(x.DB.row('SELECT state FROM nx_ops').state,'reconcile');assert.equal(x.DB.row('SELECT node_id FROM nx_ops').node_id,'de1');
});
test('renewal extends from future expiry, preserves URL and performs idempotent usage reset', async t => {
  const x=await f(t);node(x);pendingOrder(x);await approveOrder(x.r(),901,'order1');await processOp(x.r(),'oorder1');const sub=x.DB.row('SELECT * FROM nx_subs');
  const u=await panelGet(x.r(),sub.remote_id);trackBytes(x.r(),u,123,456);await flushUsage(x.r(),true);
  pendingOrder(x,'order2',{renewal_id:sub.id,plan:{days:5,reset_usage:true}});await approveOrder(x.r(),901,'order2');await processOp(x.r(),'oorder2');
  const updated=x.DB.row('SELECT * FROM nx_subs');assert.equal(updated.token,sub.token);assert.equal(updated.expires_at,sub.expires_at+5*DAY);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_panel_users').n,1);
  const after=await panelGet(x.r(),sub.remote_id);assert.equal(after.usage.total,0);assert.equal(after.epoch,1);
  await processOp(x.r(),'oorder2');assert.equal((await panelGet(x.r(),sub.remote_id)).epoch,1);
});
test('renewal day calculation handles expired accounts and stock integer-from-now semantics', () => {
  assert.deepEqual(renewalExpiry(900,2,1000),{target:1000+2*DAY,expiryDays:2});
  assert.deepEqual(renewalExpiry(1000+DAY/2,2,1000),{target:1000+2.5*DAY,expiryDays:3});
});
test('byte flush is additive and duplicate batches/reset epochs cannot resurrect usage', async t => {
  const x=await f(t);const u=await panelCreate(x.r(),{name:'bytes',trafficLimit:1,expiryDays:1},'bytes-key');
  trackBytes(x.r(),u,100,200);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_flush').n,0);await flushUsage(x.r(),true);
  const saved=x.DB.row('SELECT * FROM nx_flush');x.DB.exec('INSERT OR IGNORE INTO nx_flush(id,data,created_at) VALUES(?,?,?)',saved.id,saved.data,saved.created_at);
  assert.equal((await panelGet(x.r(),u.id)).usage.total,300);
  trackBytes(x.r(),u,500,500);await panelMutate(x.r(),u.id,'POST',{},'reset','reset-key');await panelMutate(x.r(),u.id,'POST',{},'reset','reset-key');await flushUsage(x.r(),true);
  const after=await panelGet(x.r(),u.id);assert.equal(after.epoch,1);assert.equal(after.usage.total,0);
});
test('webhook fails closed before any D1 access for missing/wrong secret', async t => {
  const x=await f(t);const before=x.DB.calls.length;
  const req=new Request('https://main.example.test/webhook',{method:'POST',body:'{}'});
  assert.equal((await webhook(x.r(),req)).status,401);assert.equal(x.DB.calls.length,before);
  assert.equal((await worker.fetch(req,{...x.env,WEBHOOK_SECRET:''},{})).status,503);
});
test('callbacks are signed for the correct Telegram owner, not transferable IDs', async t => {
  const x=await f(t),data=await callback(x.env,101,'fallback','sub1');assert.ok(data.length<=64);
  assert.deepEqual(await verifyCallback(x.env,101,data),{action:'fallback',id:'sub1'});
  await assert.rejects(verifyCallback(x.env,102,data));await assert.rejects(verifyCallback(x.env,101,data.replace('sub1','sub2')));
});
test('every privileged callback and persisted admin conversation state checks current authorization', async t => {
  const x=await f(t);mockNetwork(t);pendingOrder(x);
  const data=await callback(x.env,101,'approve','order1');await assert.rejects(handleUpdate(x.r(),{update_id:1,callback_query:{id:'synthetic',from:{id:101},message:{chat:{id:101,type:'private'}},data}}),/admin_required/);
  x.DB.exec('DELETE FROM nx_limits');x.DB.exec('INSERT INTO nx_states(user_id,step,data,expires_at) VALUES(?,?,?,?)',101,'admin:balance',JSON.stringify({id:102,key:'forged'}),Date.now()+DAY);
  await assert.rejects(handleUpdate(x.r(),{update_id:2,message:{from:{id:101},chat:{id:101,type:'private'},text:'1000'}}),/admin_required/);
  assert.equal(x.DB.row('SELECT balance FROM nx_users WHERE id=102').balance,0);
});
test('fallback ownership/rate limit and one-complete-JSON-message per variant', async t => {
  const x=await f(t);node(x);pendingOrder(x);await approveOrder(x.r(),901,'order1');await processOp(x.r(),'oorder1');const s=x.DB.row('SELECT * FROM nx_subs'),net=mockNetwork(t);
  await assert.rejects(queueFallback(x.r(),102,s.id,'bad'),/not_owned/);
  const id=await queueFallback(x.r(),101,s.id,'ok');await assert.rejects(queueFallback(x.r(),101,s.id,'again'),/rate_limited/);
  await processJob(x.r(),id,4);const calls=net.calls.filter(c=>c.url.pathname.endsWith('/sendMessage'));assert.equal(calls.length,3);
  for(const c of calls){assert.ok(c.payload.text.length<=4096);const offset=c.payload.text.indexOf('{');const config=JSON.parse(c.payload.text.slice(offset));assert.equal(config.outbounds[0].settings.vnext[0].users[0].id,s.remote_id);assert.equal(c.payload.parse_mode,undefined);}
  assert.equal(x.DB.row('SELECT status FROM nx_jobs WHERE id=?',id).status,'done');
});
test('Telegram 429 persists retry_after without advancing delivery cursor or busy retrying', async t => {
  const x=await f(t);node(x);pendingOrder(x);await approveOrder(x.r(),901,'order1');await processOp(x.r(),'oorder1');const sub=x.DB.row('SELECT * FROM nx_subs');const id=await queueFallback(x.r(),101,sub.id,'retry');
  let failOnce=true;const net=mockNetwork(t,{telegram:async()=>{if(failOnce){failOnce=false;return Response.json({ok:false,error_code:429,parameters:{retry_after:42}},{status:429});}}});
  const start=Date.now();await processJob(x.r(),id,3);let job=x.DB.row('SELECT * FROM nx_jobs WHERE id=?',id);assert.equal(job.cursor,0);assert.ok(job.due>=start+42000);assert.equal(net.calls.length,1);
  x.DB.exec('UPDATE nx_jobs SET due=0 WHERE id=?',id);await processJob(x.r(),id,1);job=x.DB.row('SELECT * FROM nx_jobs WHERE id=?',id);assert.equal(job.cursor,1);
});
test('paid and test deliveries upload local PNG and exact main-domain URL, no QR service', async t => {
  const x=await f(t);node(x,{id:'test',code:'test',purpose:'test'});testSettings(x,'test');const req=await requestTest(x.r(),101,'qr');await processOp(x.r(),req.id);
  const sub=x.DB.row('SELECT * FROM nx_subs'),net=mockNetwork(t),id='deliver:'+req.id;
  await processJob(x.r(),id,2);const photo=net.calls.find(c=>c.url.pathname.endsWith('/sendPhoto'));
  const expected=mainSubscriptionUrl(x.bot,sub.token);assert.equal(photo.payload.get('caption'),expected);assert.ok(expected.startsWith('https://main.example.test/sub/'));
  const uploaded=new Uint8Array(await photo.payload.get('photo').arrayBuffer());assert.deepEqual(uploaded,qrPng(expected));
  assert.equal(net.calls.some(c=>c.url.hostname!=='api.telegram.org'),false);assert.match(photo.payload.get('reply_markup'),/باز نشد/);
});
test('subscription endpoint uses cached bases while node unreachable and live profile changes', async t => {
  const x=await f(t);node(x);pendingOrder(x);await approveOrder(x.r(),901,'order1');await processOp(x.r(),'oorder1');const sub=x.DB.row('SELECT * FROM nx_subs');
  t.mock.method(globalThis,'fetch',()=>{throw Error('node blocked');});
  const url=mainSubscriptionUrl(x.bot,sub.token);let response=await worker.fetch(new Request(url),x.env,{});assert.equal(response.status,200);assert.equal(atob(await response.text()).split('\n').length,3);
  const p=clonedProfiles()[1];p.ech=p.ech.slice(0,1);await saveProfile(x.r(),901,p,1);
  response=await worker.fetch(new Request(url),x.env,{});assert.equal(atob(await response.text()).split('\n').length,2);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const unsupported=await worker.fetch(new Request(url+'?format=clash'),x.env,{});assert.equal(unsupported.status,422);assert.equal((await unsupported.json()).fallback,url+'?format=xray');
});
test('config splitting reassembles exact raw Unicode/percent bytes, never breaks an encoded byte', () => {
  const s='vless://'+('a%2Fب🙂'.repeat(1000));const parts=safeConfigParts(s,100);assert.equal(parts.join(''),s);assert.ok(parts.every(p=>p.length<=100&&!/%[a-f0-9]?$/i.test(p)));
});
test('SHA-224 matches independent Node crypto and fragmented VLESS/Trojan headers parse', () => {
  for(const text of ['', 'abc', crypto.randomUUID(), 'سلام'])assert.equal(sha224(text),createHash('sha224').update(text).digest('hex'));
  const uuid=crypto.randomUUID(),bytes=Uint8Array.from(uuid.replaceAll('-','').match(/../g),x=>parseInt(x,16));
  const domain=new TextEncoder().encode('example.test'),header=new Uint8Array([0,...bytes,0,1,1,187,2,domain.length,...domain,1,2,3]);
  for(let n=0;n<22+domain.length;n++)assert.equal(parseTunnelHeader(header.slice(0,n)),null);
  const p=parseTunnelHeader(header);assert.equal(p.port,443);assert.equal(p.host,'example.test');assert.deepEqual([...p.payload],[1,2,3]);
  const trojan=new Uint8Array([...new TextEncoder().encode(sha224(uuid)),13,10,1,3,domain.length,...domain,1,187,13,10,9]);const q=parseTunnelHeader(trojan);assert.equal(q.identity,sha224(uuid));assert.equal(q.protocol,'trojan');assert.equal(q.port,443);
});
test('network and plan validators reject private targets, invented settings and negatives', () => {
  for(const host of ['127.0.0.1','localhost','10.0.0.2','169.254.1.1','[::1]','x.internal','fd00::1'])assert.throws(()=>publicHost(host));
  assert.throws(()=>validateTestSettings({enabled:true,traffic_gb:1,daily_gb:1,days:1,cooldown_hours:0,node_id:'x',allow_sales_node:false}));
  assert.throws(()=>validateNode({id:'x',code:'de',label:'x',base_url:'http://x.example.test',api_route:'sync',api_key_ref:'NODE_KEY_DE',max_users:10,enabled:true,purpose:'sales',adapter:'nahan',local:false}));
});
test('embedded setup and dashboard scripts parse and reference no remote assets', async t => {
  const x=await f(t);
  for(const path of ['/setup','/sync/dash']){
    const res=await worker.fetch(new Request('https://main.example.test'+path),x.env,{});const text=await res.text();assert.equal(res.status,200);
    for(const m of text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Script(m[1]);
    assert.equal(/<(script|link)[^>]+(?:src|href)=["']https?:/i.test(text),false);
  }
});

test('profile-set activation cannot exceed the all-customer variant budget',async t=>{
  const x=await f(t);const p=structuredClone(DEFAULT_PROFILES[1]);p.id='extraech';await saveProfile(x.r(),901,p,0);
  const q=structuredClone(DEFAULT_PROFILES[1]);q.id='overflow';await assert.rejects(saveProfile(x.r(),901,q,0),/profile_set_exceeds_variant_budget/);
  assert.equal(x.DB.row('SELECT id FROM nx_profiles WHERE id=?','overflow'),undefined);
  assert.equal((await profiles(x.r(),true)).find(p=>p.id==='hamrah').version,1);
});
