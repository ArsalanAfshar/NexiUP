import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import worker, { runtime, authFailures, WEB_COOKIE, WEB_ACTOR, WEB_SESSION_MS, isAdmin, migrate, MIGRATIONS, seed, DEFAULT_PROXY, DEFAULT_PANEL, ADMIN_SCRIPT, proxyEndpoint, listProxyEndpoints, normalizeProxyRecord, proxySourceRows, startProxyImport, advanceProxyImport, parseProxyTrace, localProxyProbe, applyProxyPolicy, nodeRequest, panelCreate, approveOrder, processOp, validatePanel, validatePanelUser, invalidate } from '../worker.js';
import { fixture, FakeD1, node, pendingOrder, mockNetwork } from './helpers.mjs';

// All addresses, payments, users and trace bodies in this file are synthetic fixtures.
const secret = env => env.WEB_ADMIN_KEY ?? (env.ROLE === 'node' ? env.MASTER_KEY : env.SETUP_KEY);
const origin = 'https://main.example.test';
async function f(t, role = 'all') { authFailures.clear(); const x = await fixture(role); t.after(() => x.DB.close()); return x; }
async function request(x, path, { method = 'GET', body, auth = true, headers = {}, cf } = {}) {
  const req = new Request(origin + '/admin' + path, { method, headers: { ...(auth ? { Authorization: 'Bearer ' + secret(x.env) } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  return worker.fetch(req, x.env, { waitUntil: p => p.catch(() => {}) });
}
const post = (x, path, body, extra = {}) => request(x, '/web-api/' + path, { method: 'POST', body, ...extra });
const payload = async response => { const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body; };
async function entry(x, extra = {}) {
  const row = normalizeProxyRecord({ endpoint: '198.51.100.8:443', country: 'DE', label: 'Synthetic test fixture', ...extra });
  x.DB.exec('INSERT INTO nx_proxy_catalog(id,host,port,country,label,city,source,imported_at) VALUES(?,?,?,?,?,?,?,?)', row.id, row.host, row.port, row.country, row.label, row.city, 'manual', Date.now());
  return row;
}
function traceBody({ ip = '203.0.113.19', loc = 'US', h = 'www.cloudflare.com', colo = 'IAD' } = {}) { return `fl=synthetic\nh=${h}\nip=${ip}\nts=0\nvisit_scheme=https\ncolo=${colo}\nloc=${loc}\ntls=TLSv1.3\n`; }
function traceResponse(body = traceBody(), chunked = false) {
  return new TextEncoder().encode(chunked ? `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n` : `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${new TextEncoder().encode(body).length}\r\nConnection: close\r\n\r\n${body}`);
}
function socketFixture(t, { bytes = traceResponse(), tlsFailure = false, stalled = false } = {}) {
  const calls = [], requests = [], tlsNames = []; let closes = 0;
  globalThis.__testConnect = (address, options) => {
    calls.push({ address, options });
    const opened = stalled ? new Promise(() => {}) : Promise.resolve({});
    const secure = { opened: tlsFailure ? Promise.reject(new Error('certificate mismatch')) : Promise.resolve({}), closed: Promise.resolve(), readable: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), writable: new WritableStream({ write(data) { requests.push(new TextDecoder().decode(data)); } }), async close() { closes++; } };
    // Avoid an unhandled rejection when a TCP-only test never upgrades.
    secure.opened.catch(() => {});
    return { opened, closed: Promise.resolve(), async close() { closes++; }, startTls(options) { tlsNames.push(options.expectedServerHostname); return secure; } };
  };
  t.after(() => { delete globalThis.__testConnect; });
  return { calls, requests, tlsNames, closes: () => closes };
}

test('new admin HTML is self-contained, nonce-CSP protected and its embedded script parses', async t => {
  const x = await f(t); const response = await request(x, '', { auth: false });
  for(const path of ['/admin','/setup','/sync/dash']){const insecure=await worker.fetch(new Request('http://main.example.test'+path),x.env,{});assert.equal(insecure.status,308);assert.equal(insecure.headers.get('Location'),origin+path);}
  assert.equal(response.status, 200); const html = await response.text();
  assert.match(html, /NexiUP/); assert.match(html,/SIL OPEN FONT LICENSE Version 1.1/); assert.match(html, /id="login-form"/); assert.match(html, /id="proxy/); // present in embedded renderer
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy'), /style-src 'nonce-/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|localStorage|sessionStorage|eval\(/i);
  assert.ok(!html.includes(x.env.SETUP_KEY)); assert.ok(!html.includes(x.env.MASTER_KEY));
  assert.doesNotThrow(() => new Script(ADMIN_SCRIPT));
});
test('anonymous APIs and node API keys cannot administer the web hub', async t => {
  const x = await f(t);
  assert.equal((await request(x, '/web-api/overview', { auth: false })).status, 401);
  assert.equal((await request(x, '/web-api/overview', { auth: false, headers: { Authorization: 'Bearer ' + x.env.NODE_KEY_DE } })).status, 401);
  assert.equal((await request(x, '/web-api/overview?key=' + x.env.SETUP_KEY, { auth: false })).status, 401);
});
test('web owner identity cannot be forged in JSON or Telegram numeric identity', async t => {
  const x = await f(t);
  assert.equal(await isAdmin(x.r(), WEB_ACTOR), true);
  assert.equal(await isAdmin(x.r(), 'web:owner'), false);
  assert.equal(await isAdmin(x.r(), 'Symbol(web:owner)'), false);
});
test('session stores only hashes, uses Secure HttpOnly SameSite=Strict and enforces CSRF', async t => {
  const x = await f(t);const login = await post(x, 'login', undefined);const cookie = login.headers.get('set-cookie');const session = await payload(login);
  assert.match(cookie, new RegExp('^' + WEB_COOKIE + '=[a-f0-9]{64}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800$'));
  const cookieHeader = cookie.split(';')[0], token = cookieHeader.split('=')[1];
  const stored = x.DB.row('SELECT * FROM nx_web_sessions');assert.notEqual(stored.token_hash, token);assert.notEqual(stored.credential_hash, x.env.SETUP_KEY);
  assert.ok(session.expires_at > Date.now());assert.ok(session.expires_at <= Date.now() + WEB_SESSION_MS);
  let response = await request(x, '/web-api/session', { auth: false, headers: { Cookie: cookieHeader } });assert.equal((await payload(response)).csrf, session.csrf);
  response = await post(x, 'customers/action', { id: 101, action: 'ban', banned: true }, { auth: false, headers: { Cookie: cookieHeader, Origin: origin } });assert.equal(response.status, 403);
  response = await post(x, 'customers/action', { id: 101, action: 'ban', banned: true }, { auth: false, headers: { Cookie: cookieHeader, 'X-NexiUP-CSRF': session.csrf } });assert.equal(response.status, 403);
  response = await post(x, 'customers/action', { id: 101, action: 'ban', banned: true }, { auth: false, headers: { Cookie: cookieHeader, Origin: origin, 'X-NexiUP-CSRF': session.csrf } });assert.equal(response.status, 200);
  assert.equal(x.DB.row('SELECT banned FROM nx_users WHERE id=101').banned, 1);
  assert.equal(x.DB.row("SELECT actor FROM nx_audit WHERE action='user_ban_changed'").actor, 'web:owner');
});
test('logout, expiration and key rotation invalidate durable sessions', async t => {
  const x = await f(t);const response = await post(x, 'login');const cookie = response.headers.get('set-cookie').split(';')[0], data = await payload(response);
  x.env.SETUP_KEY = 'rotated_' + x.env.SETUP_KEY;
  assert.equal((await request(x, '/web-api/session', { auth: false, headers: { Cookie: cookie } })).status, 401);
  x.env.SETUP_KEY = x.env.SETUP_KEY.slice(8);x.DB.exec('UPDATE nx_web_sessions SET expires_at=?', Date.now() - 1);
  assert.equal((await request(x, '/web-api/session', { auth: false, headers: { Cookie: cookie } })).status, 401);
  x.DB.exec('UPDATE nx_web_sessions SET expires_at=?', Date.now() + 10000);
  const logout = await post(x, 'logout', {}, { auth: false, headers: { Cookie: cookie, Origin: origin, 'X-NexiUP-CSRF': data.csrf } });assert.equal(logout.status, 200);assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_web_sessions').n, 0);
  assert.equal((await request(x, '/web-api/session', { auth: false, headers: { Cookie: cookie } })).status, 401);
});
test('dedicated WEB_ADMIN_KEY disables fallback login and weak dedicated secrets fail closed', async t => {
  const x = await f(t);x.env.WEB_ADMIN_KEY = 'dedicated_' + x.env.SETUP_KEY;
  const bad = await post(x, 'login', undefined, { auth: false, headers: { Authorization: 'Bearer ' + x.env.SETUP_KEY } });assert.equal(bad.status, 401);
  assert.equal((await post(x, 'login')).status, 200);
  x.env.WEB_ADMIN_KEY = 'short';assert.equal((await request(x, '/web-api/overview')).status, 503);
});
test('role changes invalidate cookies; cross-site and non-HTTPS admin requests fail', async t => {
  const x = await f(t);x.env.WEB_ADMIN_KEY = x.env.SETUP_KEY;
  const login = await post(x, 'login');const cookie = login.headers.get('set-cookie').split(';')[0];
  x.env.ROLE = 'node';assert.equal((await request(x, '/web-api/session', { auth: false, headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request(x, '/web-api/overview', { headers: { Origin: 'https://evil.example.test' } })).status, 403);
  assert.equal((await request(x, '/web-api/overview', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const response = await worker.fetch(new Request('http://main.example.test/admin/web-api/session', { headers: { Authorization: 'Bearer ' + x.env.WEB_ADMIN_KEY } }), x.env, {});assert.equal(response.status, 400);
});
test('node and hub roles enforce every hidden web API boundary, not just menu visibility', async t => {
  const x = await f(t, 'node');
  for (const path of ['orders','subscriptions','customers','operations','catalog?kind=nodes','editor?kind=bot','editor?kind=test','catalog?kind=plans']) assert.equal((await request(x, '/web-api/' + path)).status, 403, path);
  assert.equal((await post(x, 'orders/decide', { id: 'x', action: 'approve' })).status, 403);
  assert.equal((await post(x, 'customers/action', { id: 101, action: 'wallet', amount: 1, reason: 'x' })).status, 403);
  assert.equal((await request(x, '/web-api/node-users')).status, 200);
  const y = await f(t, 'hub');
  for (const path of ['node-users','keys','editor?kind=panel']) assert.equal((await request(y, '/web-api/' + path)).status, 403, path);
  assert.equal((await request(y, '/web-api/proxy/list')).status, 200);
});
test('existing v4 database upgrades without rewriting profiles, ledger or node settings', async t => {
  const base = await f(t), DB = new FakeD1();t.after(() => DB.close());const env = { ...base.env, DB }, x = { env, DB, r: () => runtime(env) };
  for (let i=0;i<4;i++) await migrate(x.r());
  await seed(x.r());DB.exec("UPDATE nx_profiles SET version=7,data=json_set(data,'$.label','Owner custom label') WHERE id='irancell'");DB.exec("UPDATE nx_settings SET value=json_set(value,'$.proxy_ips',json('[\"relay.example.test\"]')) WHERE key='panel'");
  assert.equal((await post(x, 'login')).status, 202);const response = await post(x, 'login');assert.equal(response.status, 200);
  assert.equal(DB.row('SELECT MAX(version) AS n FROM schema_version').n, MIGRATIONS.length);
  assert.equal(DB.row("SELECT version FROM nx_profiles WHERE id='irancell'").version, 7);
  assert.equal(JSON.parse(DB.row("SELECT value FROM nx_settings WHERE key='panel'").value).proxy_ips[0], 'relay.example.test');
});
test('web settings use server-side validation and optimistic revisions', async t => {
  const x = await f(t);const ed = await payload(await request(x, '/web-api/editor?kind=proxy'));assert.deepEqual(ed.doc, DEFAULT_PROXY);
  const data = { ...ed.doc, daily_test_limit: 34 };
  assert.equal((await post(x, 'validate', { kind: 'proxy', doc: data })).status, 200);
  assert.equal((await post(x, 'save', { kind: 'proxy', doc: data, version: ed.version })).status, 200);
  assert.equal((await post(x, 'save', { kind: 'proxy', doc: { ...data, daily_test_limit: 35 }, version: ed.version })).status, 409);
  assert.equal((await post(x, 'save', { kind: 'proxy', doc: { ...data, source_url: 'https://127.0.0.1/all.json' }, version: ed.version + 1 })).status, 400);
  assert.equal(JSON.parse(x.DB.row("SELECT value FROM nx_settings WHERE key='proxy'").value).daily_test_limit, 34);
});
test('web wallet retries cannot duplicate credit or reuse a key for a different amount', async t => {
  const x = await f(t), body = { id: 101, action: 'wallet', amount: 400, reason: 'Synthetic adjustment' }, options = { headers: { 'Idempotency-Key': 'web_wallet_fixture_1' } };
  assert.equal((await post(x, 'customers/action', body, options)).status, 200);
  assert.equal((await post(x, 'customers/action', body, options)).status, 200);
  assert.equal(x.DB.row('SELECT balance FROM nx_users WHERE id=101').balance, 400);
  assert.equal((await post(x, 'customers/action', { ...body, amount: 500 }, options)).status, 409);
  assert.equal((await post(x, 'customers/action', { ...body, amount: -401 }, { headers: { 'Idempotency-Key': 'web_wallet_fixture_2' } })).status, 409);
  assert.equal(x.DB.row('SELECT balance FROM nx_users WHERE id=101').balance, 400);
});
test('web receipt approval reuses the durable order workflow; repeated approval does not duplicate operations', async t => {
  const x = await f(t);pendingOrder(x);node(x);
  assert.equal((await post(x, 'orders/decide', { id: 'order1', action: 'approve', actor: 0 })).status, 200);
  assert.equal((await post(x, 'orders/decide', { id: 'order1', action: 'approve' })).status, 200);
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_ops').n, 1);assert.equal(x.DB.row("SELECT status FROM nx_orders WHERE id='order1'").status, 'processing');
  const list = await payload(await request(x, '/web-api/orders'));assert.equal(list.items.length, 1);
  assert.ok(!JSON.stringify(list).includes('synthetic_file_reference'));
  const detail = await payload(await request(x, '/web-api/orders?id=order1'));assert.ok(detail.item.receipt.available);assert.ok(!JSON.stringify(detail).includes('synthetic_file_reference'));
});
test('web receipt images are authenticated, size-bounded and do not expose Telegram tokens', async t => {
  const x = await f(t);pendingOrder(x);
  const image = Uint8Array.of(255,216,255,224,0,1);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {calls.push({url:String(url),init});return String(url).includes('/getFile') ? Response.json({ ok:true,result:{file_path:'photos/synthetic.jpg'} }) : new Response(image,{headers:{'Content-Type':'image/jpeg'}});});
  const response = await request(x, '/web-api/receipt?id=order1');assert.equal(response.status, 200);assert.equal(response.headers.get('content-type'), 'image/jpeg');assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  assert.equal(calls.length, 2);assert.ok(calls[1].url.includes(x.env.BOT_TOKEN));assert.equal(calls[1].init.headers?.Authorization, undefined);
  assert.equal((await request(x, '/web-api/receipt?id=order1', { auth:false })).status, 401);
});
test('web node create/update validates on the server and requires an idempotency key', async t => {
  const x = await f(t), doc = { name:'web_fixture_random_0001',trafficLimit:1,dailyLimit:1,expiryDays:1,proxyIp:'relay.example.test:8443' };
  assert.equal((await post(x, 'node-users/validate', { ...doc, proxyIp:'127.0.0.1' })).status, 400);
  assert.equal((await post(x, 'node-users', doc)).status, 400);
  const first = await payload(await post(x, 'node-users', doc, { headers:{'Idempotency-Key':'node_user_web_fixture'} }));
  const second = await payload(await post(x, 'node-users', doc, { headers:{'Idempotency-Key':'node_user_web_fixture'} }));assert.equal(first.user.id, second.user.id);
  assert.equal(first.user.proxyIp, 'relay.example.test:8443');
});
test('public proxy endpoint validation supports IPv4, IPv6 and explicit ports without private-address aliases', () => {
  assert.deepEqual(proxyEndpoint('RELAY.example.test:8443'), {host:'relay.example.test',port:8443,explicit:true,endpoint:'relay.example.test:8443'});
  assert.equal(proxyEndpoint('[2606:4700:4700::1111]:443').host, '2606:4700:4700::1111');
  assert.deepEqual(listProxyEndpoints('relay.example.test,relay.example.test:8443'), ['relay.example.test','relay.example.test:8443']);
  for (const v of ['localhost:443','127.1:443','127.0.0.1:443','10.1.1.1','169.254.169.254:80','[::1]:443','[0:0:0:0:0:ffff:7f00:1]:443','[fe80::1]:443','https://public.example.test','host.example.test@private.example.test','relay.example.test:25','relay.example.test:0','relay.example.test:65536']) assert.throws(()=>proxyEndpoint(v), v);
  assert.deepEqual(validatePanel({...DEFAULT_PANEL,proxy_ips:['relay.example.test:8443']}).proxy_ips, ['relay.example.test:8443']);
  assert.equal(validatePanelUser({name:'fixture',proxyIp:'[2606:4700:4700::1111]:8443'}).proxyIp, '[2606:4700:4700::1111]:8443');
});
test('public-source schema keeps country/clientIp claims separate from observed exits', () => {
  const row=normalizeProxyRecord({ip:'198.51.100.22',port:[443,8443],meta:{country:'de',clientIp:'203.0.113.9',colo:{country:'US'},asOrganization:'Fixture provider',city:'Fixture city'}});
  assert.equal(row.country,'DE');assert.equal(row.id,'198.51.100.22:443');assert.equal(row.exit_ip,undefined);assert.equal(row.exit_country,undefined);assert.equal(row.colo,undefined);
  assert.throws(()=>normalizeProxyRecord({ip:'198.51.100.22',port:[80,8080]}),/catalog_no_tls_443/);
  assert.equal(normalizeProxyRecord({ip:'198.51.100.23',country:'Unknown'}).country,'ZZ');
  assert.equal(proxySourceRows('country,endpoint,label\nDE,198.51.100.22:443,Fixture\n# comment').length,1);
  assert.equal(proxySourceRows({data:[{ip:'198.51.100.22'}]}).length,1);assert.throws(()=>proxySourceRows({success:true}));
});
test('catalog imports are bounded, resumable, duplicate-safe and do not erase test evidence', async t => {
  const x=await f(t);const rows=Array.from({length:45},(_,i)=>({ip:'198.51.100.'+(i+1),country:i%2?'DE':'US',port:443}));rows.push({ip:'127.0.0.1',country:'DE'});
  const job=await startProxyImport(x.r(),{data:rows},'manual');const firstRuntime=x.r();const first=await advanceProxyImport(firstRuntime,job.id,0);assert.equal(first.cursor,20);assert.equal(first.imported,20);assert.ok(firstRuntime.queries<20);
  const repeated=await advanceProxyImport(x.r(),job.id,0);assert.equal(repeated.cursor,20);assert.equal(repeated.imported,20);
  const second=await advanceProxyImport(x.r(),job.id,20);const last=await advanceProxyImport(x.r(),job.id,second.cursor);assert.equal(last.state,'done');assert.equal(last.imported,45);assert.equal(last.rejected,1);
  x.DB.exec("UPDATE nx_proxy_catalog SET state='relay_ok',probe=?,checked_at=? WHERE id=?",JSON.stringify({evidence:'local',relay_ok:true}),Date.now(),'198.51.100.1:443');
  const repeat=await startProxyImport(x.r(),[rows[0]],'manual');await advanceProxyImport(x.r(),repeat.id,0);
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_proxy_catalog').n,45);assert.equal(x.DB.row("SELECT state FROM nx_proxy_catalog WHERE id='198.51.100.1:443'").state,'relay_ok');
  const filtered=await payload(await request(x,'/web-api/proxy/list?country=DE'));assert.equal(filtered.total,22);assert.equal(filtered.items.length,20);assert.ok(filtered.next);assert.equal(filtered.countries.length,2);
});
test('catalog hard cap is exact and does not block updating an existing entry', async t => {
  const x=await f(t);const rows=Array.from({length:1998},(_,i)=>({id:'relay'+i+'.example.test:443',host:'relay'+i+'.example.test'}));
  x.DB.exec("INSERT INTO nx_proxy_catalog(id,host,port,source,imported_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.host'),443,'manual',0 FROM json_each(?)",JSON.stringify(rows));
  const job=await startProxyImport(x.r(),Array.from({length:20},(_,i)=>({endpoint:'198.51.100.'+(i+1)+':443',country:'DE'})),'manual');const result=await advanceProxyImport(x.r(),job.id,0);
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_proxy_catalog').n,2000);assert.equal(result.imported,2);assert.equal(result.rejected,18);
  const update=await startProxyImport(x.r(),[{endpoint:rows[0].id,country:'US'}],'manual');assert.equal((await advanceProxyImport(x.r(),update.id,0)).imported,1);
});
test('external source is opt-in, cannot redirect credentials, and refresh failure preserves the catalog', async t => {
  const x=await f(t);await entry(x);let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;assert.equal(init.headers.Authorization,undefined);return new Response(null,{status:302,headers:{Location:'https://other.example.test/data'}});});
  assert.equal((await post(x,'proxy/sync',{})).status,403);assert.equal(calls,0);
  x.DB.exec("UPDATE nx_settings SET value=json_set(value,'$.external_enabled',json('true')) WHERE key='proxy'");invalidate(x.r());
  const response=await post(x,'proxy/sync',{});assert.equal(response.status,502);assert.equal((await response.json()).error,'redirect_forbidden');assert.equal(calls,1);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_proxy_catalog').n,1);
});
test('catalog import cancellation and malformed imports never change active relay policy', async t => {
  const x=await f(t);const job=await payload(await post(x,'proxy/import',{data:[{ip:'198.51.100.1'}]}));
  assert.equal((await post(x,'proxy/cancel-import',{id:job.id})).status,200);assert.equal((await payload(await post(x,'proxy/continue',{id:job.id,cursor:0}))).state,'cancelled');
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_proxy_catalog').n,0);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_proxy_policies').n,0);
  assert.equal((await post(x,'proxy/import',{data:'this is not a valid catalog'})).status,200); // staged, validated by bounded continuation
  assert.equal((await post(x,'proxy/import',{data:{data:[]}})).status,400);
});
test('TLS trace parser handles content-length and chunking, not fabricated generic HTTP/colo data', () => {
  for(const chunked of [false,true])assert.deepEqual(parseProxyTrace(traceResponse(traceBody(),chunked)),{exit_ip:'203.0.113.19',exit_country:'US',trace_colo:'IAD'});
  for(const bytes of [traceResponse(traceBody({h:'evil.example.test'})),traceResponse(traceBody({ip:'127.0.0.1'})),new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\ncolo=FRA\ncountry=DE'),new TextEncoder().encode('HTTP/1.1 302 Found\r\n\r\n'+traceBody()),new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\n'+traceBody())])assert.throws(()=>parseProxyTrace(bytes));
});
test('native TLS probe uses expected hostname, releases sockets, and observes trace exit rather than worker/source country', async t => {
  const x=await f(t),row=await entry(x),sock=socketFixture(t);
  const data=await payload(await post(x,'proxy/probe',{id:row.id,mode:'relay'},{cf:{colo:'FRA',country:'IR'}}));
  assert.equal(data.state,'relay_ok');assert.equal(data.probe.exit_country,'US');assert.equal(data.probe.from_colo,'FRA');assert.equal(data.probe.trace_colo,'IAD');
  assert.deepEqual(sock.calls[0],{address:{hostname:'198.51.100.8',port:443},options:{secureTransport:'starttls',allowHalfOpen:false}});assert.deepEqual(sock.tlsNames,['www.cloudflare.com']);
  assert.match(sock.requests[0],/^GET \/cdn-cgi\/trace HTTP\/1.1/);assert.match(sock.requests[0],/Host: www.cloudflare.com/);assert.ok(!sock.requests[0].includes(x.env.SETUP_KEY));assert.ok(sock.closes()>=1);
  assert.equal(x.DB.row('SELECT country,exit_country FROM nx_proxy_catalog').country,'DE');assert.equal(x.DB.row('SELECT exit_country FROM nx_proxy_catalog').exit_country,'US');
  const second=await post(x,'proxy/probe',{id:row.id,mode:'relay'});assert.equal(second.status,429);assert.equal(sock.calls.length,1);
});
test('TCP-only and TLS certificate failure are never promoted to working relay or observed country', async t => {
  const sock=socketFixture(t,{tlsFailure:true});
  const tcp=await localProxyProbe('198.51.100.8:8443','tcp',100);assert.equal(tcp.tcp_ok,true);assert.equal(tcp.relay_ok,false);assert.equal(tcp.exit_country,null);assert.equal(sock.tlsNames.length,0);
  const tls=await localProxyProbe('198.51.100.8:8443','relay',100);assert.equal(tls.tcp_ok,true);assert.equal(tls.relay_ok,false);assert.equal(tls.error,'proxy_tls_failed');assert.equal(tls.exit_ip,null);
  assert.equal(sock.calls[0].address.port,8443);
});
test('stalled and oversized probes are time/body bounded and close their sockets', async t => {
  const sock=socketFixture(t,{stalled:true});const started=Date.now();const result=await localProxyProbe('198.51.100.8','relay',25);
  assert.equal(result.error,'socket_timeout');assert.ok(Date.now()-started<500);assert.ok(sock.closes()>0);
  socketFixture(t,{bytes:new Uint8Array(16385)});assert.equal((await localProxyProbe('198.51.100.8','relay',100)).error,'proxy_response_too_large');
});
test('daily diagnostic budget is durable, limited and counts attempted probes before networking', async t => {
  const x=await f(t),a=await entry(x),b=await entry(x,{ip:undefined,endpoint:'198.51.100.9:443'}),sock=socketFixture(t);
  x.DB.exec("UPDATE nx_settings SET value=json_set(value,'$.daily_test_limit',1) WHERE key='proxy'");invalidate(x.r());
  assert.equal((await post(x,'proxy/probe',{id:a.id,mode:'tcp'})).status,200);const response=await post(x,'proxy/probe',{id:b.id,mode:'tcp'});assert.equal(response.status,429);assert.equal((await response.json()).error,'proxy_daily_test_budget');assert.equal(sock.calls.length,1);
});
test('external checker sees only the candidate, is explicitly attributed and cannot assert a verified exit', async t => {
  const x=await f(t),row=await entry(x);let call;
  t.mock.method(globalThis,'fetch',async(url,init)=>{call={url:new URL(String(url)),init};return Response.json({success:true,responseTime:17,ip:'203.0.113.19',country:'US',supports_ipv4:true});});
  assert.equal((await post(x,'proxy/probe',{id:row.id,mode:'external'})).status,403);assert.equal(call,undefined);
  x.DB.exec("UPDATE nx_settings SET value=json_set(value,'$.checker_enabled',json('true')) WHERE key='proxy'");invalidate(x.r());
  const data=await payload(await post(x,'proxy/probe',{id:row.id,mode:'external'}));assert.equal(data.state,'reported_ok');assert.equal(data.probe.relay_ok,false);assert.equal(data.probe.evidence,'third_party');assert.equal(data.probe.exit_ip,null);assert.equal(data.exit_country,'');
  assert.equal(call.url.searchParams.get('proxyip'),row.id);assert.equal(call.url.searchParams.size,1);assert.equal(call.init.headers.Authorization,undefined);assert.equal(call.init.headers.Cookie,undefined);
  assert.equal((await post(x,'proxy/apply',{target:'self',ids:[row.id],version:0})).status,409);
});
test('apply is never automatic; fresh target evidence or explicit override is required, and rollback really changes local fallback', async t => {
  const x=await f(t),row=await entry(x);assert.deepEqual(JSON.parse(x.DB.row("SELECT value FROM nx_settings WHERE key='panel'").value).proxy_ips,[]);
  await assert.rejects(applyProxyPolicy(x.r(),{target:'self',ids:[row.id],version:0}),/fresh_target_relay_test/);
  socketFixture(t);await payload(await post(x,'proxy/probe',{id:row.id,mode:'relay'}));
  const applied=await applyProxyPolicy(x.r(),{target:'self',ids:[row.id],version:0});assert.equal(applied.scope,'local_fallback');assert.equal(applied.affects_existing_inheriting_accounts,true);
  assert.deepEqual(JSON.parse(x.DB.row("SELECT value FROM nx_settings WHERE key='panel'").value).proxy_ips,[row.id]);
  await assert.rejects(applyProxyPolicy(x.r(),{target:'self',ids:[],version:0}),/version_conflict/);
  const back=await applyProxyPolicy(x.r(),{target:'self',version:1},true);assert.deepEqual(back.endpoints,[]);assert.equal(back.version,2);assert.deepEqual(JSON.parse(x.DB.row("SELECT value FROM nx_settings WHERE key='panel'").value).proxy_ips,[]);
});
test('stale or wrong-node evidence requires explicit override; manual edits fence rollback', async t => {
  const x=await f(t),row=await entry(x);node(x,{id:'remote',local:false});
  x.DB.exec("UPDATE nx_proxy_catalog SET state='relay_ok',checked_at=?,probe=?",Date.now(),JSON.stringify({evidence:'node:remote',relay_ok:true}));
  await assert.rejects(applyProxyPolicy(x.r(),{target:'self',ids:[row.id],version:0}),/fresh_target_relay_test/);
  x.DB.exec('UPDATE nx_proxy_catalog SET checked_at=?,probe=?',Date.now()-31*60000,JSON.stringify({evidence:'local',relay_ok:true}));
  await assert.rejects(applyProxyPolicy(x.r(),{target:'self',ids:[row.id],version:0}),/fresh_target_relay_test/);
  await applyProxyPolicy(x.r(),{target:'self',ids:[row.id],version:0,allow_unverified:true});
  x.DB.exec("UPDATE nx_settings SET value=json_set(value,'$.proxy_ips',json('[\"owner-change.example.test\"]')) WHERE key='panel'");invalidate(x.r());
  await assert.rejects(applyProxyPolicy(x.r(),{target:'self',version:1},true),/proxy_changed_since_apply/);
});
test('remote-node selection applies only to future creations, using a panel key, not master changes', async t => {
  const x=await f(t),n=node(x,{id:'remote',local:false}),row=await entry(x),net=mockNetwork(t);
  const existing=(await nodeRequest(x.r(),n,'POST','',{name:'existing_fixture',expiryDays:1},'','old')).user;
  const result=await applyProxyPolicy(x.r(),{target:'node:remote',ids:[row.id],version:0,allow_unverified:true});assert.equal(result.scope,'new_accounts');assert.equal(result.affects_existing_inheriting_accounts,false);
  assert.equal(net.calls.length,1);const created=(await nodeRequest(x.r(),n,'POST','',{name:'new_fixture',expiryDays:1},'','new')).user;
  assert.equal(created.proxyIp,row.id);assert.equal(existing.proxyIp,undefined);assert.equal(net.calls[1].headers.Authorization,'Bearer '+x.env.NODE_KEY_DE);assert.ok(!net.calls.some(c=>c.url.pathname.endsWith('/web-api/config')));
  await applyProxyPolicy(x.r(),{target:'node:remote',version:1},true);assert.deepEqual(JSON.parse(x.DB.row("SELECT endpoints FROM nx_proxy_policies WHERE target='node:remote'").endpoints),[]);
});
test('native remote probe endpoint accepts registered node keys and hub attributes the result to that node', async t => {
  const x=await f(t),n=node(x,{id:'remote',local:false}),row=await entry(x);let call;
  t.mock.method(globalThis,'fetch',async(url,init)=>{call={url:String(url),init};return Response.json({success:true,probe:{mode:'relay',endpoint:row.id,evidence:'local',tcp_ok:true,relay_ok:true,tcp_ms:15,tls_ms:40,total_ms:70,from_colo:'AMS',trace_colo:'IAD',exit_country:'US',exit_ip:'203.0.113.19',error:null}});});
  const data=await payload(await post(x,'proxy/probe',{id:row.id,mode:'relay',node_id:n.id}));assert.equal(data.probe.evidence,'node:remote');assert.equal(data.probe.from_colo,'AMS');assert.equal(call.init.headers.Authorization,'Bearer '+x.env.NODE_KEY_DE);assert.ok(call.url.endsWith('/sync/api/proxy-check'));
  const y=await f(t,'node');y.DB.exec('INSERT INTO nx_panel_keys(id,name,secret_ref,created_at) VALUES(?,?,?,?)','hub','Synthetic hub','NODE_KEY_DE',Date.now());socketFixture(t);
  const res=await worker.fetch(new Request('https://node.example.test/sync/api/proxy-check',{method:'POST',headers:{Authorization:'Bearer '+y.env.NODE_KEY_DE,'Content-Type':'application/json'},body:JSON.stringify({endpoint:row.id,mode:'tcp'})}),y.env,{});assert.equal(res.status,200);assert.equal((await res.json()).probe.tcp_ok,true);
});
test('catalog deletion leaves active policy untouched and GET requests do not make outbound probes', async t => {
  const x=await f(t),row=await entry(x);await applyProxyPolicy(x.r(),{target:'self',ids:[row.id],version:0,allow_unverified:true});
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('No fetch is allowed for these reads');});
  assert.equal((await request(x,'/web-api/proxy/list')).status,200);assert.equal((await request(x,'/web-api/overview')).status,200);
  assert.equal((await post(x,'proxy/remove',{id:row.id})).status,200);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_proxy_catalog').n,0);
  assert.deepEqual(JSON.parse(x.DB.row("SELECT value FROM nx_settings WHERE key='panel'").value).proxy_ips,[row.id]);
});

test('a completed schema without seeding is not considered initialized by public/control paths',async t=>{
  const x=await f(t),DB=new FakeD1();t.after(()=>DB.close());const env={...x.env,DB};
  for(let i=0;i<MIGRATIONS.length;i++)await migrate(runtime(env));
  const res=await worker.fetch(new Request(origin+'/sync/api/users',{headers:{Authorization:'Bearer '+env.MASTER_KEY}}),env,{});
  assert.equal(res.status,503);assert.equal((await res.json()).error,'run_setup_migrations');
  await migrate(runtime(env));const good=await worker.fetch(new Request(origin+'/sync/api/users',{headers:{Authorization:'Bearer '+env.MASTER_KEY}}),env,{});assert.equal(good.status,200);
});
test('dedicated web/setup control secrets cannot be registered as weaker node keys, including legacy API',async t=>{
  const x=await f(t);x.env.WEB_ADMIN_KEY='dedicated_'+x.env.MASTER_KEY;x.env.NODE_KEY_DUPLICATE=x.env.WEB_ADMIN_KEY;
  let response=await post(x,'keys',{name:'Bad shared key',secret_ref:'NODE_KEY_DUPLICATE'});assert.equal(response.status,400);
  response=await worker.fetch(new Request(origin+'/sync/api/keys',{method:'POST',headers:{Authorization:'Bearer '+x.env.MASTER_KEY,'Content-Type':'application/json'},body:JSON.stringify({name:'Bad shared key',secret_ref:'NODE_KEY_DUPLICATE'})}),x.env,{});assert.equal(response.status,400);
  x.env.NODE_KEY_DUPLICATE=x.env.SETUP_KEY;response=await post(x,'keys',{name:'Bad shared setup key',secret_ref:'NODE_KEY_DUPLICATE'});assert.equal(response.status,400);
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_panel_keys').n,0);
});
test('malformed remote proof cannot be stored as a verified relay result',async t=>{
  const x=await f(t),row=await entry(x);node(x,{id:'remote',local:false});
  t.mock.method(globalThis,'fetch',async()=>Response.json({success:true,probe:{mode:'relay',endpoint:row.id,evidence:'local',tcp_ok:false,relay_ok:true,tcp_ms:0,tls_ms:0,total_ms:0,exit_ip:'example.test',exit_country:'US',trace_colo:'FRA'}}));
  const response=await post(x,'proxy/probe',{id:row.id,mode:'relay',node_id:'remote'});assert.equal(response.status,502);assert.equal((await response.json()).error,'invalid_node_probe');
  assert.equal(x.DB.row('SELECT state FROM nx_proxy_catalog').state,'untested');
});
test('cancellation racing an in-flight import never resurrects the cancelled job',async t=>{
  const x=await f(t),job=await startProxyImport(x.r(),[{ip:'198.51.100.1',country:'DE'}],'manual'),r=x.r(),original=r.batch;
  r.batch=async items=>{x.DB.exec("UPDATE nx_proxy_imports SET state='cancelled' WHERE id=?",job.id);return original(items);};
  const result=await advanceProxyImport(r,job.id,0);assert.equal(result.state,'cancelled');assert.equal(x.DB.row('SELECT state FROM nx_proxy_imports WHERE id=?',job.id).state,'cancelled');
});
test('truly simultaneous import jobs serialize and cannot exceed the shared catalog capacity',async t=>{
  const x=await f(t);
  for(let i=0;i<1999;i++)x.DB.exec('INSERT INTO nx_proxy_catalog(id,host,port,source,imported_at) VALUES(?,?,?,?,?)','reserved-'+i+'.example.test:443','reserved-'+i+'.example.test',443,'manual',Date.now());
  const jobs=await Promise.all([startProxyImport(x.r(),[{ip:'198.51.100.201'}],'manual'),startProxyImport(x.r(),[{ip:'198.51.100.202'}],'manual')]);
  const results=await Promise.allSettled(jobs.map(j=>advanceProxyImport(x.r(),j.id,0)));
  for(let i=0;i<results.length;i++)if(results[i].status==='rejected'){assert.equal(results[i].reason.code,'busy');await advanceProxyImport(x.r(),jobs[i].id,0);}
  assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_proxy_catalog').n,2000);
  assert.equal(x.DB.row("SELECT SUM(imported) AS n FROM nx_proxy_imports WHERE state='done'").n,1);
});
test('20-row import and a four-endpoint policy stay inside D1 invocation budgets',async t=>{
  const x=await f(t),job=await startProxyImport(x.r(),Array.from({length:20},(_,i)=>({ip:'198.51.100.'+(i+1),country:'DE'})),'manual'),r=x.r();
  await advanceProxyImport(r,job.id,0);assert.ok(r.queries<=46);
  const r2=x.r();await applyProxyPolicy(r2,{target:'self',ids:[1,2,3,4].map(i=>'198.51.100.'+i+':443'),version:0,allow_unverified:true});assert.ok(r2.queries<=46);
  t.diagnostic('Bounded helper statements: import20='+r.queries+', apply4='+r2.queries+' (HTTP authentication adds its own small bounded reads).');
});
test('remote provisioning with ProxyIP defaults and five configured owners retains the guarded SQL budget',async t=>{
  const x=await f(t,'hub');x.env.ADMIN_IDS='901,902,903,904,905';node(x,{id:'remote',local:false});
  const net=mockNetwork(t,{node(call,remote){if(call.url.searchParams.get('action')==='configs'){const u=[...remote.values()].find(u=>u.id===call.url.searchParams.get('id'));if(u)return Response.json({success:true,user:u,bases:Array.from({length:4},(_,i)=>({protocol:'vless',id:u.id,server:'transport-'+i+'.example.test',host:call.url.hostname,sni:call.url.hostname,port:443,path:'/sync/ws',alpn:[]}))});}}});
  for(let i=0;i<9;i++)net.remote.set('occupied_'+i,{id:crypto.randomUUID(),name:'occupied_'+i,expiryMs:Date.now()+86400000});
  x.DB.exec('INSERT INTO nx_proxy_policies(target,version,endpoints,previous,updated_at) VALUES(?,1,?,?,?)','node:remote',JSON.stringify(['198.51.100.42:8443']),'[]',Date.now());
  pendingOrder(x);await approveOrder(x.r(),901,'order1');const r=x.r(),result=await processOp(r,'oorder1');assert.equal(result.state,'done');assert.ok(r.queries<=46);
  const create=net.calls.find(c=>c.method==='POST'&&c.url.pathname.endsWith('/api/users'));assert.equal(create.payload.proxyIp,'198.51.100.42:8443');assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_subs').n,1);t.diagnostic('Four-base remote issuance with policy: '+r.queries+' guarded statements, '+r.external+' external fetches.');
});
test('a legacy node api_route=admin keeps its API, dashboard and subscription endpoint alongside the new web UI',async t=>{
  const x=await f(t),p=validatePanel({...DEFAULT_PANEL,api_route:'admin'});
  x.DB.exec("UPDATE nx_settings SET value=? WHERE key='panel'",JSON.stringify(p));invalidate(x.r());
  const u=await panelCreate(x.r(),{name:'legacy_admin_route_account',trafficLimit:1,expiryDays:1},'legacy_admin_route');
  let res=await worker.fetch(new Request(origin+'/admin/api/users',{headers:{Authorization:'Bearer '+x.env.MASTER_KEY}}),x.env,{});assert.equal(res.status,200);assert.equal((await res.json()).users[0].id,u.id);
  res=await worker.fetch(new Request(origin+'/admin?sub='+u.name+'&format=base64'),x.env,{});assert.equal(res.status,200);assert.ok(!res.headers.get('Content-Type').includes('text/html'));assert.match(atob(await res.text()),/vless:/);
  res=await worker.fetch(new Request(origin+'/admin/dash'),x.env,{});assert.equal(res.status,200);assert.match(await res.text(),/master/);
  res=await worker.fetch(new Request(origin+'/admin'),x.env,{});assert.equal(res.status,200);assert.match(await res.text(),/login-screen/);
  assert.equal((await request(x,'/web-api/session')).status,200);
});
test('import data, cursor and counts commit together even if the later response read fails',async t=>{
  const x=await f(t),job=await startProxyImport(x.r(),[{ip:'198.51.100.230'}],'manual'),r=x.r(),first=r.first;
  r.first=(sql,...args)=>{if(sql.startsWith('SELECT id,cursor,total'))throw new Error('synthetic post-commit read interruption');return first(sql,...args);};
  await assert.rejects(advanceProxyImport(r,job.id,0),/post-commit/);
  const recovered=await advanceProxyImport(x.r(),job.id,0);assert.equal(recovered.state,'done');assert.equal(recovered.cursor,1);assert.equal(recovered.imported,1);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx_proxy_catalog').n,1);
});
