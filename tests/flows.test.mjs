import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { runtime, panelCreate, panelGet, callback, processOp, processJob, approveOrder, requestTest, createOrder, applyCoupon, requestWithdrawal, nodeRequest, lock, DAY, scheduled } from '../worker.js';
import { fixture, node, plan, pendingOrder, testSettings, mockNetwork } from './helpers.mjs';

async function f(t,role) {const x=await fixture(role);t.after(()=>x.DB.close());return x;}

test('HTTP webhook purchase → receipt → approval → node → delivery works with persisted states',async t=>{
  const x=await f(t);node(x);const p=plan(x),net=mockNetwork(t);let time=Date.now(),id=500;
  t.mock.method(Date,'now',()=>time);
  const payment={id:'card',name:'Card transfer',details:'Owner-supplied bank details go here',instructions:'Send receipt',enabled:true};
  x.DB.exec('INSERT INTO nx_catalog(kind,id,data,enabled) VALUES(?,?,?,1)','payments',payment.id,JSON.stringify(payment));
  const message=(uid,text,more={})=>({update_id:++id,message:{from:{id:uid},chat:{id:uid,type:'private'},text,...more}});
  const action=async(uid,a,key='0')=>({update_id:++id,callback_query:{id:'cb'+id,from:{id:uid},message:{chat:{id:uid,type:'private'}},data:await callback(x.env,uid,a,key)}});
  const send=async update=>{time+=1200;const res=await worker.fetch(new Request('https://main.example.test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':x.env.WEBHOOK_SECRET,'Content-Type':'application/json'},body:JSON.stringify(update)}),x.env,{});assert.equal(res.status,200,await res.text());};
  await send(message(104,'/start'));assert.equal(x.DB.row('SELECT terms_at FROM nx_users WHERE id=104').terms_at,0);
  await send(await action(104,'lang','en'));await send(await action(104,'terms'));await send(await action(104,'buy',p.id+'~de'));
  let order=x.DB.row('SELECT * FROM nx_orders WHERE user_id=104');assert.equal(order.status,'pending_payment');
  await send(await action(104,'payment',order.id+'~card'));
  await send(message(104,'',{photo:[{file_id:'synthetic_receipt_photo'}],caption:'Transfer reference only'}));
  order=x.DB.row('SELECT * FROM nx_orders WHERE id=?',order.id);assert.equal(order.status,'pending');
  await send(await action(901,'approve',order.id));assert.equal(x.DB.row('SELECT status FROM nx_orders WHERE id=?',order.id).status,'processing');
  const op=x.DB.row('SELECT id FROM nx_ops WHERE order_id=?',order.id);assert.equal((await processOp(x.r(),op.id)).state,'done');
  await processJob(x.r(),'deliver:'+op.id,2);assert.ok(net.calls.some(c=>c.url.pathname.endsWith('/sendPhoto')&&c.payload instanceof FormData));
  assert.equal(x.DB.row('SELECT status FROM nx_orders WHERE id=?',order.id).status,'done');
  assert.ok(net.calls.some(c=>c.payload?.text?.includes('Invoice')));
});

test('coupon capacity/per-user reservations and withdrawals are atomic under parallel calls',async t=>{
  const x=await f(t);node(x);plan(x);const p={id:'ONCE',type:'percent',value:10,max_uses:1,per_user:1,minimum:0,expires_at:0,enabled:true};
  x.DB.exec('INSERT INTO nx_catalog(kind,id,data,enabled) VALUES(?,?,?,1)','coupons',p.id,JSON.stringify(p));
  pendingOrder(x,'one',{status:'pending_payment',user_id:101});pendingOrder(x,'two',{status:'pending_payment',user_id:102});
  const results=await Promise.allSettled([applyCoupon(x.r(),101,'one','ONCE'),applyCoupon(x.r(),102,'two','ONCE')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_coupon_uses').n,1);
  x.DB.exec('UPDATE nx_users SET balance=100000 WHERE id=101');
  const w=await Promise.allSettled([requestWithdrawal(x.r(),101,75000,'synthetic destination one','wd1'),requestWithdrawal(x.r(),101,75000,'synthetic destination two','wd2')]);assert.equal(w.filter(r=>r.status==='fulfilled').length,1);assert.equal(x.DB.row('SELECT balance FROM nx_users WHERE id=101').balance,25000);
});

test('first-purchase offer cannot be claimed on several different parallel checkouts',async t=>{
  const x=await f(t);node(x);plan(x);plan(x,{id:'second'});x.DB.exec("UPDATE nx_settings SET value=? WHERE key='bot'",JSON.stringify({...x.bot,first_discount_percent:25}));
  const u=x.DB.row('SELECT * FROM nx_users WHERE id=101');
  const orders=await Promise.all([createOrder(x.r(),u,'basic','de','first'),createOrder(x.r(),u,'second','de','second')]);
  assert.deepEqual(orders.map(o=>o.total).sort((a,b)=>a-b),[75,100]);assert.equal(x.DB.row("SELECT COUNT(*) AS n FROM nx_coupon_uses WHERE coupon_id='__first_offer'").n,1);
});

test('stats and scheduled maintenance stay within statement limits and issue 3/1/expired reminders',async t=>{
  const x=await f(t);node(x);pendingOrder(x);mockNetwork(t);await approveOrder(x.r(),901,'order1');await processOp(x.r(),'oorder1');
  x.DB.exec('UPDATE nx_subs SET expires_at=?',Date.now()+2*DAY);
  const r=x.r();await scheduled(r,{scheduledTime:4*60000});assert.ok(r.queries<=46);assert.equal(x.DB.row('SELECT reminded FROM nx_subs').reminded,1);
  const data=await callback(x.env,901,'stats','7d');
  const update={update_id:199,callback_query:{id:'stats',from:{id:901},message:{chat:{id:901,type:'private'}},data}};
  const res=await worker.fetch(new Request('https://main.example.test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':x.env.WEBHOOK_SECRET},body:JSON.stringify(update)}),x.env,{});assert.equal(res.status,200);
});

test('Nahan mutations are quarantined after uncertainty: other operations cannot overtake',async t=>{
  const x=await f(t,'hub');node(x,{id:'stock',adapter:'nahan',local:false});pendingOrder(x,'one');pendingOrder(x,'two',{user_id:102});let posts=0;
  mockNetwork(t,{node:async c=>{if(c.method==='POST'){posts++;throw new Error('lost response');}}});
  await approveOrder(x.r(),901,'one');await approveOrder(x.r(),901,'two');await processOp(x.r(),'oone');
  x.DB.exec('UPDATE nx_locks SET not_before=0,until_ms=0');await processOp(x.r(),'otwo');assert.equal(posts,1);assert.equal(x.DB.row('SELECT state FROM nx_ops WHERE id=?','otwo').state,'queued');
});

test('main-domain URL cannot be guessed from request Host; configuration is required',async t=>{
  const x=await f(t);node(x,{id:'test',purpose:'test',code:'test'});testSettings(x,'test');x.DB.exec("UPDATE nx_settings SET value=? WHERE key='bot'",JSON.stringify({...x.bot,main_url:''}));
  await assert.rejects(requestTest(x.r(),101,'nohost'),/invalid/);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_ops').n,0);
});

test('API master required, distinct env-backed panel key registration, role separation',async t=>{
  const x=await f(t);const origin='https://node.example.test';
  let res=await worker.fetch(new Request(origin+'/sync/api/users'),x.env,{});assert.equal(res.status,401);
  res=await worker.fetch(new Request(origin+'/sync/api/keys',{method:'POST',headers:{Authorization:'Bearer '+x.env.MASTER_KEY,'Content-Type':'application/json'},body:JSON.stringify({name:'hub',secret_ref:'NODE_KEY_DE'})}),x.env,{});assert.equal(res.status,201);
  x.DB.exec('DELETE FROM nx_limits');
  res=await worker.fetch(new Request(origin+'/sync/api/users',{headers:{Authorization:'Bearer '+x.env.NODE_KEY_DE}}),x.env,{});assert.equal(res.status,200);const data=await res.json();assert.equal(data.success,true);
  res=await worker.fetch(new Request(origin+'/sync/api/config',{headers:{Authorization:'Bearer '+x.env.NODE_KEY_DE}}),x.env,{});assert.equal(res.status,401);
  res=await worker.fetch(new Request(origin+'/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':x.env.WEBHOOK_SECRET},body:'{}'}),{...x.env,ROLE:'node'},{});assert.equal(res.status,404);
  res=await worker.fetch(new Request(origin+'/sync/api/users'),{...x.env,MASTER_KEY:''},{});assert.equal(res.status,503);
});

test('private-chat boundary prevents sending credentials to a forwarded/group chat',async t=>{
  const x=await f(t);const net=mockNetwork(t);
  const data=await callback(x.env,101,'wallet');
  const update={update_id:909,callback_query:{id:'group',from:{id:101},message:{chat:{id:-100999,type:'supergroup'}},data}};
  const res=await worker.fetch(new Request('https://main.example.test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':x.env.WEBHOOK_SECRET},body:JSON.stringify(update)}),x.env,{});
  assert.equal(res.status,200);assert.equal(net.calls.length,0);
});

test('stock Nahan generated short panel-key format is accepted without master fallback',async t=>{
  const x=await f(t,'hub'),n=node(x,{adapter:'nahan',local:false}),net=mockNetwork(t);
  x.env.NODE_KEY_DE='nahan_'+Date.now().toString(36)+'_'+crypto.randomUUID().replaceAll('-','').slice(0,8);
  assert.ok(x.env.NODE_KEY_DE.length<32);await nodeRequest(x.r(),n);
  assert.equal(net.calls[0].headers.Authorization,'Bearer '+x.env.NODE_KEY_DE);
  x.env.NODE_KEY_DE=x.env.MASTER_KEY;await assert.rejects(nodeRequest(x.r(),n),/node_api_key_missing_or_master/);
});

test('NexiUP toggle action honors a stable Idempotency-Key',async t=>{
  const x=await f(t),n=node(x);const u=await panelCreate(x.r(),{name:'toggle_once',expiryDays:1},'toggle-user');
  await nodeRequest(x.r(),n,'POST',u.id,null,'toggle','once');await nodeRequest(x.r(),n,'POST',u.id,null,'toggle','once');
  assert.equal((await panelGet(x.r(),u.id)).isPaused,true);
  await nodeRequest(x.r(),n,'POST',u.id,null,'toggle','twice');assert.equal((await panelGet(x.r(),u.id)).isPaused,false);
});

test('configured Cloudflare usage queues 70/90 percent warnings once per UTC day',async t=>{
  const x=await f(t);x.env.CF_ACCOUNT_ID=crypto.randomUUID().replaceAll('-','');x.env.CF_API_TOKEN=crypto.randomUUID();
  x.DB.exec("UPDATE nx_settings SET value=? WHERE key='bot'",JSON.stringify({...x.bot,daily_report_hour:(new Date().getUTCHours()+1)%24}));
  let apiCalls=0;t.mock.method(globalThis,'fetch',async(input,init)=>{
    assert.equal(new URL(String(input)).hostname,'api.cloudflare.com');const payload=JSON.parse(init.body);assert.match(payload.query,/workersInvocationsAdaptive/);assert.match(payload.variables.start,/T00:00:00Z$/);apiCalls++;
    return Response.json({data:{viewer:{accounts:[{workersInvocationsAdaptive:[{sum:{requests:91000}}]}]}}});
  });
  await scheduled(x.r(),{scheduledTime:5*60000});await scheduled(x.r(),{scheduledTime:5*60000});assert.equal(apiCalls,2);
  const jobs=x.DB.rows("SELECT * FROM nx_jobs WHERE id LIKE 'cf:%'");assert.equal(jobs.length,2);assert.ok(jobs.some(j=>j.id.endsWith(':70:901')));assert.ok(jobs.some(j=>j.id.endsWith(':90:901')));
});

test('authenticated node API allows a provisioning burst and reads capped-account bases safely',async t=>{
  const x=await f(t),u=await panelCreate(x.r(),{name:'burst_account',trafficLimit:1,expiryDays:1},'burst');
  x.DB.exec('INSERT INTO nx_panel_usage(id,epoch,up,down,day) VALUES(?,0,?,0,?)',u.id,2*1073741824,'2026-10-20');
  for(const path of ['/sync/api/users?id=missing','/sync/api/users','/sync/api/users?id='+u.id+'&action=configs']){
    const response=await worker.fetch(new Request('https://node.example.test'+path,{headers:{Authorization:'Bearer '+x.env.MASTER_KEY}}),x.env,{});
    assert.equal(response.status,path.includes('missing')?404:200);
    if(path.includes('configs')){const data=await response.json();assert.equal(data.user.status,'limited');assert.equal(data.bases[0].id,u.id);}
  }
});

test('Workers-compatible manual redirect handling never forwards node credentials',async t=>{
  const x=await f(t);let count=0;t.mock.method(globalThis,'fetch',async(input,init)=>{count++;assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://elsewhere.example.test/'}});});
  await assert.rejects(x.r().fetch('https://node.example.test/sync/api/users',{headers:{Authorization:'Bearer '+x.env.NODE_KEY_DE}}),/redirect_forbidden/);assert.equal(count,1);
});

test('a retrying old operation or delivery cannot monopolize the due queue',async t=>{
  const x=await f(t);node(x);const p=plan(x);pendingOrder(x,'fresh');await approveOrder(x.r(),901,'fresh');
  x.DB.exec('UPDATE nx_ops SET created_at=? WHERE id=?',Date.now()-10000,'ofresh');
  x.DB.exec('INSERT INTO nx_ops(id,kind,user_id,node_id,name,payload,state,phase,retry_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)','older','test',102,'de','older',JSON.stringify({plan:p}),'ready','remote_ready',Date.now()-1,Date.now()-DAY);
  await scheduled(x.r(),{scheduledTime:6*60000});assert.equal(x.DB.row('SELECT state FROM nx_ops WHERE id=?','ofresh').state,'done');assert.equal(x.DB.row('SELECT state FROM nx_ops WHERE id=?','older').state,'ready');
  // Remove the successful issuance's delivery job so this checks the ordering directly.
  x.DB.exec('DELETE FROM nx_jobs');
  x.DB.exec('INSERT INTO nx_jobs(id,user_id,kind,data,due,created_at) VALUES(?,?,?,?,?,?)','old-job',101,'text',JSON.stringify({text:'older retry'}),Date.now()-1,Date.now()-DAY);
  x.DB.exec('INSERT INTO nx_jobs(id,user_id,kind,data,due,created_at) VALUES(?,?,?,?,?,?)','new-job',101,'text',JSON.stringify({text:'new eligible job'}),Date.now()-10000,Date.now()-10000);
  const net=mockNetwork(t);await scheduled(x.r(),{scheduledTime:7*60000});assert.equal(net.calls[0].payload.text,'new eligible job');assert.equal(x.DB.row('SELECT status FROM nx_jobs WHERE id=?','new-job').status,'done');
});
