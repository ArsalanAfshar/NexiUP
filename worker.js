/*!
 * NexiUP 2.1.1 — Telegram sales hub, web control panel and compatible node.
 * Copyright (c) 2026 NexiUP Contributors. MIT; see LICENSE and THIRD_PARTY.md.
 * One ES module; paste directly into Cloudflare Workers. No runtime npm dependencies.
 * Nahan source is NOT vendored: its inspected license grant was incomplete.
 * Original web UI / ProxyIP diagnostics; embedded QR: MIT; embedded font: SIL OFL-1.1.
 * Full font and QR notices are included below. No remote UI assets or auto-deploy.
 */
import { connect } from 'cloudflare:sockets';

const VERSION = '2.1.1';
const knownFaults = new WeakSet();

/** @typedef {{ label: string, action?: string, id?: string | number, url?: string }} MenuButton */
/** @typedef {(MenuButton | MenuButton[])[]} MenuButtons */
const DAY = 86400000;
const GIB = 1073741824;
const enc = new TextEncoder();
const dec = new TextDecoder();
const CACHE_MS = 15000;
const caches = new WeakMap();
const initialized = new WeakMap();
const localTraffic = new WeakMap();
const openTunnels = new Map();
let liveWebSockets = 0;
const authFailures = new Map();

class Fault extends Error {
  constructor(code, status = 400, retry = 0) { super(code); this.code = code; this.status = status; this.retry = retry; knownFaults.add(this); }
}
const fail = (code, status = 400) => { throw new Fault(code, status); };
const now = () => Date.now();
const randomId = (bytes = 12) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const copy = x => JSON.parse(JSON.stringify(x));
const parse = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const changes = r => Number(r?.meta?.changes || 0);
const html = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const codeOf = e => knownFaults.has(e) ? e.code : 'internal_error'; // Never store remote error bodies, URLs or stacks.
const stamp = ms => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
const t = (u, fa, en) => u?.lang === 'en' ? en : fa;
const noStore = { 'X-NexiUP-Version':VERSION, 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers:{ ...noStore, 'Content-Type':'application/json; charset=utf-8', ...extra } });
function constantTimeEqual(a, b) {
  a=String(a||'');b=String(b||'');if(a.length>1024||b.length>1024)return false;
  a=enc.encode(a);b=enc.encode(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a[i] || 0) ^ (b[i] || 0);
  return d === 0;
}
function number(x, min, max, integer = false) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max || (integer && !Number.isSafeInteger(x))) fail('invalid_number');
  return x;
}
function string(x, max = 1000, min = 0) {
  if (typeof x !== 'string' || x.length < min || enc.encode(x).length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x)) fail('invalid_text');
  return x;
}
function keys(obj, allowed) {
  if (!isObject(obj) || Object.keys(obj).some(k => !allowed.includes(k))) fail('unknown_field');
}
function bool(x) { if (typeof x !== 'boolean') fail('invalid_boolean'); return x; }
function ident(x, max = 64) { if (typeof x !== 'string' || !new RegExp(`^[a-zA-Z0-9_-]{1,${max}}$`).test(x)) fail('invalid_identifier'); return x; }
function ref(x) { if (typeof x !== 'string' || !/^NODE_KEY_[A-Z0-9_]{1,45}$/.test(x)) fail('invalid_secret_reference'); return x; }
function publicHost(x) {
  string(x, 253, 1);
  const h = x.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.includes('%')) fail('private_host');
  if (h.includes(':')) {
    if (!/^[a-f0-9:]+$/.test(h) || /^(::|fc|fd|fe8|fe9|fea|feb|ff)/.test(h)) fail('private_host');
    try { new URL(`https://[${h}]`); } catch { fail('invalid_host'); }
  } else if (/^[0-9.]+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255) || [0,10,127].includes(p[0]) || p[0] >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)) fail('private_host');
  } else if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(h)) fail('invalid_host');
  return h;
}
function httpsOrigin(x) {
  string(x, 240, 1); let u;
  try { u = new URL(x); } catch { fail('invalid_https_origin'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.port && u.port !== '443')) fail('invalid_https_origin');
  publicHost(u.hostname);
  return u.origin;
}
function httpsUrl(x) {
  let u; try { u = new URL(x); } catch { fail('invalid_https_url'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) fail('invalid_https_url');
  publicHost(u.hostname); return u.toString();
}
const hostPort = h => h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
function listHosts(v, max = 4) {
  if (typeof v === 'string') v = v.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (!Array.isArray(v) || v.length > max) fail('too_many_hosts');
  return [...new Set(v.map(publicHost))];
}
function validNodeKey(node,key) {
  // Stock Nahan 3.0.4 generates ~23-character nahan_* keys. Preserve interoperability
  // without weakening NexiUP's own 32+ character keys; never fall back to a master key.
  return strongSecret(key)||(node.adapter==='nahan'&&typeof key==='string'&&/^nahan_[a-z0-9]{6,16}_[a-z0-9]{6,16}$/.test(key));
}
function strongSecret(v) { return typeof v === 'string' && v.length >= 32 && v.length <= 256; }
function controlSecret(env,key) { return ['MASTER_KEY','SETUP_KEY','WEB_ADMIN_KEY'].some(name=>strongSecret(env[name])&&constantTimeEqual(key,env[name])); }
function getRole(env) { const r = env.ROLE || 'all'; if (!['hub','node','all'].includes(r)) fail('invalid_role', 503); return r; }
function ownerIds(env) { return String(env.ADMIN_IDS || '').split(',').filter(x => /^\d{1,16}$/.test(x.trim())).map(x => Number(x.trim())).filter(x => x > 0 && Number.isSafeInteger(x)).slice(0, 5); }

// Unknown rejections can be null, primitives or objects with throwing getters. Never
// assume Error/instanceof or serialize their messages, SQL, request URLs or stacks.
function errorField(error, name) { try { return error?.[name]; } catch { return undefined; } }
function errorMessage(error) {
  const parts=[];
  for(let i=0;i<3&&error!=null;i++){
    const message=errorField(error,'message');if(typeof message==='string')parts.push(message.slice(0,2000));
    error=errorField(error,'cause');
  }
  return parts.join(' '); // Internal classification only; never return/log this string.
}
function schemaMissing(error) { return /no such table:\s*(?:main\.)?(?:schema_version|nx_[a-z0-9_]+)\b/i.test(errorMessage(error)); }
function requestSurface(request) {
  try{
    const path=new URL(request.url).pathname;
    if(request.headers.get('upgrade')?.toLowerCase()==='websocket')return 'tunnel';
    if(path==='/setup')return 'setup';if(path==='/health')return 'health';
    if(path.startsWith('/admin/web-api/'))return 'admin_api';if(path.startsWith('/sub/'))return 'subscription';
    if(path==='/webhook')return 'webhook';if(path.includes('/api/'))return 'node_api';
  }catch{}
  return 'request';
}
function logRuntimeError(error,env,metadata) {
  // Explicit opt-in. Only fixed categories, version, random correlation ID and
  // numeric source positions; not even an exception's name/message is trusted.
  try{
    if(env?.NEXIUP_DIAGNOSTICS!=='true')return;
    let position={};const stack=errorField(error,'stack');
    if(typeof stack==='string'){
      const match=stack.slice(0,12000).match(/^\s+at [^\n]*\bworker\.js:(\d{1,7}):(\d{1,7})(?:\)|\s|$)/m);
      if(match)position={line:Number(match[1]),column:Number(match[2])};
    }
    console.error(JSON.stringify({event:'nexiup_runtime_error',version:VERSION,...metadata,...position}));
  }catch{} // A failed logger/property access must not crash the recovery path.
}
function requestFailure(error,request,env,r) {
  try{
    const fault=knownFaults.has(error)?error:null;
    const databaseFailure=r?.databaseFailed(error)===true;
    const status=fault?fault.status:databaseFailure?503:500;
    const code=fault?fault.code:databaseFailure?'d1_unavailable':'internal_error';
    const headers=fault?.retry?{'Retry-After':String(fault.retry)}:{};
    if(status<500)return json({error:code},status,headers);
    let requestId='unavailable';try{requestId=randomId();}catch{}
    logRuntimeError(error,env,{request_id:requestId,surface:request?requestSurface(request):'scheduled',code});
    return json({error:code,version:VERSION,request_id:requestId},status,{...headers,'X-NexiUP-Request-ID':requestId});
  }catch{
    // Last-resort response contains literals only. Platform/module-startup faults
    // and resource exhaustion remain outside a JavaScript request error boundary.
    return new Response('{"error":"internal_error"}',{status:500,headers:{...noStore,'Content-Type':'application/json'}});
  }
}
async function readDeadline(operation,ms=8000) {
  let timer;
  try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Fault('d1_read_timeout',503)),ms);})]);}
  finally{clearTimeout(timer);}
}

/** Counts statements, not just batch round trips. Leaves room below D1's Free 50.
 * Binding acquisition is lazy: liveness and the public login/setup shell need no D1.
 * Only SELECT reads have a deadline. Never time out/retry an in-flight mutation.
 */
function runtime(env = {}, execution = {}) {
  let raw, queries=0, external=0, sawDatabaseFailure=false, lastDatabaseError;
  const database=()=>{
    if(raw)return raw;
    let candidate;
    try{candidate=env.DB;}catch{throw new Fault('d1_binding_unavailable',503);}
    if(candidate==null)throw new Fault('d1_binding_missing',503);
    try{if(typeof candidate!=='object'||typeof candidate.prepare!=='function'||typeof candidate.batch!=='function')throw new Fault('d1_binding_invalid',503);}
    catch(error){if(knownFaults.has(error))throw error;throw new Fault('d1_binding_invalid',503);}
    raw=candidate;return raw;
  };
  const dbError=error=>{
    sawDatabaseFailure=true;lastDatabaseError=error;
    if(errorMessage(error).includes('insufficient_balance'))throw new Fault('insufficient_balance',409);
    throw error;
  };
  const reserve=n=>{if(queries+n>46)throw new Fault('query_budget',503,60);queries+=n;};
  const st=(sql,args)=>database().prepare(sql).bind(...args);
  const read=(sql,operation)=>/^\s*SELECT\b/i.test(sql)?readDeadline(operation):operation;
  return {
    env, execution, get raw(){return database();},
    get queries(){return queries;},get external(){return external;},
    databaseFailed(error){return sawDatabaseFailure&&lastDatabaseError===error;},
    async first(sql,...args){reserve(1);try{return await read(sql,st(sql,args).first());}catch(error){return dbError(error);}},
    async all(sql,...args){reserve(1);try{return (await read(sql,st(sql,args).all())).results||[];}catch(error){return dbError(error);}},
    async run(sql,...args){reserve(1);try{return await st(sql,args).run();}catch(error){return dbError(error);}},
    async batch(items){reserve(items.length);try{return await database().batch(items.map(([sql,...args])=>st(sql,args)));}catch(error){return dbError(error);}},
    async fetch(url, init = {}, timeout = 8000, maxBytes = 1024 * 1024) {
      if (++external > 40) throw new Fault('fetch_budget', 503, 60);
      // Disallow redirects so Authorization never follows a node to a different origin.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { ...init, redirect:'manual', signal:controller.signal });
        if(res.status>=300&&res.status<400){await res.body?.cancel();throw new Fault('redirect_forbidden',502);}
        // Workers supports manual/follow, not redirect:error. Never forward credentials.
        // Body reads must be bounded by the same deadline, not just response headers.
        const bytes = await boundedBody(res, maxBytes);
        return new Response([204,205,304].includes(res.status)?null:bytes, { status:res.status, headers:res.headers });
      } finally { clearTimeout(timer); }
    },
  };
}
async function boundedBody(req, max) {
  if (Number(req.headers.get('content-length')) > max) fail('body_too_large', 413);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(); const chunks = []; let len = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      len += value.length; if (len > max) { await reader.cancel(); fail('body_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(len); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; } return out;
}
async function bodyJson(req, max = 32768) { try { return JSON.parse(dec.decode(await boundedBody(req, max))); } catch (e) { if (e instanceof Fault) throw e; fail('invalid_json'); } }

// All v2 tables are namespaced. Original v1 bot tables and stock kv_store are untouched.
const MIGRATIONS = [
  [
    `CREATE TABLE IF NOT EXISTS nx_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_users (id INTEGER PRIMARY KEY, username TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'fa', terms_at INTEGER NOT NULL DEFAULT 0, referrer INTEGER, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), banned INTEGER NOT NULL DEFAULT 0, admin INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_catalog (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(kind,id))`,
    `CREATE TABLE IF NOT EXISTS nx_orders (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, plan_id TEXT, kind TEXT NOT NULL, renewal_id TEXT, location TEXT, snapshot TEXT NOT NULL, total INTEGER NOT NULL CHECK(total>=0), wallet_paid INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, receipt TEXT, reason TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_orders_state ON nx_orders(status,created_at)`,
    `CREATE INDEX IF NOT EXISTS nx_orders_user ON nx_orders(user_id,created_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS nx_open_cart ON nx_orders(user_id,plan_id,location,COALESCE(renewal_id,'')) WHERE kind='sale' AND status IN ('pending_payment','pending')`,
    `CREATE TABLE IF NOT EXISTS nx_ledger (key TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES nx_users(id), amount INTEGER NOT NULL, balance_after INTEGER, kind TEXT NOT NULL, reference TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_ledger_user ON nx_ledger(user_id,created_at)`,
    `CREATE TRIGGER IF NOT EXISTS nx_wallet_check BEFORE INSERT ON nx_ledger WHEN NOT EXISTS(SELECT 1 FROM nx_ledger WHERE key=NEW.key) BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM nx_users WHERE id=NEW.user_id AND balance+NEW.amount>=0) THEN RAISE(ABORT,'insufficient_balance') END; END`,
    `CREATE TRIGGER IF NOT EXISTS nx_wallet_apply AFTER INSERT ON nx_ledger BEGIN UPDATE nx_users SET balance=balance+NEW.amount WHERE id=NEW.user_id; UPDATE nx_ledger SET balance_after=(SELECT balance FROM nx_users WHERE id=NEW.user_id) WHERE key=NEW.key; END`,
    `CREATE TABLE IF NOT EXISTS nx_withdrawals (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_coupon_uses (order_id TEXT PRIMARY KEY, coupon_id TEXT NOT NULL, user_id INTEGER NOT NULL, discount INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_coupon_counts ON nx_coupon_uses(coupon_id,user_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS nx_first_offer ON nx_coupon_uses(user_id) WHERE coupon_id='__first_offer'`
  ],
  [
    `CREATE TABLE IF NOT EXISTS nx_nodes (id TEXT PRIMARY KEY, code TEXT NOT NULL, label TEXT NOT NULL, base_url TEXT NOT NULL, api_route TEXT NOT NULL, api_key_ref TEXT NOT NULL, max_users INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL, adapter TEXT NOT NULL DEFAULT 'nexiup', local INTEGER NOT NULL DEFAULT 0, last_health_ok INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_nodes_assignment ON nx_nodes(enabled,code,purpose)`,
    `CREATE TABLE IF NOT EXISTS nx_ops (id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER NOT NULL, order_id TEXT UNIQUE, node_id TEXT, name TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'new', remote_id TEXT, sub_id TEXT, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_ops_queue ON nx_ops(state,retry_at)`,
    `CREATE TABLE IF NOT EXISTS nx_subs (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, op_id TEXT UNIQUE, node_id TEXT, remote_id TEXT, name TEXT NOT NULL, limits TEXT NOT NULL, bases TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', expires_at INTEGER NOT NULL, reminded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_subs_owner ON nx_subs(user_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS nx_subs_node ON nx_subs(node_id,status,expires_at)`,
    `CREATE TABLE IF NOT EXISTS nx_test_slots (user_id INTEGER PRIMARY KEY, op_id TEXT, next_at INTEGER NOT NULL DEFAULT 0, last_success INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS nx_test_grants (op_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, node_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, granted_at INTEGER, expires_at INTEGER, error TEXT)`,
    `CREATE TABLE IF NOT EXISTS nx_locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until_ms INTEGER NOT NULL, not_before INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS nx_limits (key TEXT PRIMARY KEY, next_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_profile_versions (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,version))`
  ],
  [
    `CREATE TABLE IF NOT EXISTS nx_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_states (user_id INTEGER PRIMARY KEY, step TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_updates (id INTEGER PRIMARY KEY, status TEXT NOT NULL, owner TEXT NOT NULL, until_ms INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_jobs (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_jobs_queue ON nx_jobs(status,due,created_at)`,
    `CREATE TABLE IF NOT EXISTS nx_tickets (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_messages (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, sender INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_messages_ticket ON nx_messages(ticket_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS nx_members (user_id INTEGER NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,channel))`,
    `CREATE TABLE IF NOT EXISTS nx_broadcasts (id TEXT PRIMARY KEY, actor INTEGER NOT NULL, text TEXT NOT NULL, segment TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued', due INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`
  ],
  [
    `CREATE TABLE IF NOT EXISTS nx_panel_users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, data TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, create_key TEXT UNIQUE, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_panel_usage (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL DEFAULT '', day_up INTEGER NOT NULL DEFAULT 0, day_down INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS nx_panel_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_ref TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_panel_requests (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_flush (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TRIGGER IF NOT EXISTS nx_flush_apply AFTER INSERT ON nx_flush BEGIN
      INSERT INTO nx_panel_usage(id,epoch,up,down,day,day_up,day_down)
      SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.epoch'),json_extract(j.value,'$.up'),json_extract(j.value,'$.down'),json_extract(j.value,'$.day'),json_extract(j.value,'$.up'),json_extract(j.value,'$.down')
      FROM json_each(NEW.data) AS j JOIN nx_panel_users u ON u.id=json_extract(j.value,'$.id') AND u.epoch=json_extract(j.value,'$.epoch') WHERE 1
      ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,
        up=CASE WHEN nx_panel_usage.epoch=excluded.epoch THEN nx_panel_usage.up ELSE 0 END+excluded.up,
        down=CASE WHEN nx_panel_usage.epoch=excluded.epoch THEN nx_panel_usage.down ELSE 0 END+excluded.down,
        day=MAX(nx_panel_usage.day,excluded.day),
        day_up=CASE WHEN nx_panel_usage.epoch=excluded.epoch AND nx_panel_usage.day=excluded.day THEN nx_panel_usage.day_up+excluded.day_up WHEN nx_panel_usage.day>excluded.day THEN nx_panel_usage.day_up ELSE excluded.day_up END,
        day_down=CASE WHEN nx_panel_usage.epoch=excluded.epoch AND nx_panel_usage.day=excluded.day THEN nx_panel_usage.day_down+excluded.day_down WHEN nx_panel_usage.day>excluded.day THEN nx_panel_usage.day_down ELSE excluded.day_down END;
      END`,
    `CREATE TRIGGER IF NOT EXISTS nx_reset_apply AFTER INSERT ON nx_panel_requests WHEN NEW.action='reset' BEGIN
      UPDATE nx_panel_users SET epoch=epoch+1 WHERE id=NEW.user_id;
      DELETE FROM nx_panel_usage WHERE id=NEW.user_id;
      END`
  ],
  [
    `CREATE TABLE IF NOT EXISTS nx_web_sessions (token_hash TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS nx_web_session_expiry ON nx_web_sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS nx_proxy_catalog (id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'ZZ', label TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, imported_at INTEGER NOT NULL, probe TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'untested', checked_at INTEGER, exit_country TEXT NOT NULL DEFAULT '')`,
    `CREATE INDEX IF NOT EXISTS nx_proxy_country ON nx_proxy_catalog(country,id)`,
    `CREATE TABLE IF NOT EXISTS nx_proxy_imports (id TEXT PRIMARY KEY, source TEXT NOT NULL, data TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, original_total INTEGER NOT NULL, imported INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS nx_proxy_budgets (day TEXT PRIMARY KEY, tests INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS nx_proxy_policies (target TEXT PRIMARY KEY, endpoints TEXT NOT NULL, previous TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)`
  ]
];

/** One migration per call: safe to repeat concurrently, and fits the 50-query ceiling. */
async function migrate(r) {
  await r.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const v = (await r.first('SELECT MAX(version) AS version FROM schema_version'))?.version || 0;
  if(v>MIGRATIONS.length)fail('schema_newer_than_worker',503);
  if (v < MIGRATIONS.length) {
    await r.batch([...MIGRATIONS[v].map(sql => [sql]), ['INSERT OR IGNORE INTO schema_version(version,applied_at) VALUES(?,?)', v + 1, now()]]);
    return { ready:false, version:v + 1, remaining:MIGRATIONS.length - v - 1 };
  }
  await seed(r);
  initialized.set(r.raw, true);
  return { ready:true, version:v };
}
async function ready(r) {
  if (initialized.has(r.raw)) return;
  try {
    const row = await r.first("SELECT MAX(version) AS version,(SELECT COUNT(*) FROM nx_settings WHERE key IN ('bot','test','panel','proxy')) AS seeded,(SELECT COUNT(*) FROM nx_profiles) AS profiles FROM schema_version");
    if(row?.version>MIGRATIONS.length)fail('schema_newer_than_worker',503);
    if (row?.version === MIGRATIONS.length && row.seeded === 4 && row.profiles > 0) { initialized.set(r.raw, true); return; }
  } catch(error) { if(!schemaMissing(error))throw error; }
  fail('run_setup_migrations', 503);
}
function cache(r) { if (!caches.has(r.raw)) caches.set(r.raw, new Map()); return caches.get(r.raw); }
function invalidate(r, key = '') { if (!key) cache(r).clear(); else cache(r).delete(key); }
const DEFAULT_SETTINGS = {
  main_url:'', support:'', currency:'تومان', maintenance:false, announcement:'',
  order_hours:2, referral_percent:10, first_discount_percent:0, topup_bonus_percent:0,
  min_topup:10000, min_withdrawal:50000, max_pending:3, daily_report_hour:20,
  terms_fa:'استفاده باید مطابق شرایط Cloudflare و قوانین محل شما باشد. سهمیه و انقضا طبق پلن است. دسترسی در همه شبکه‌ها تضمین نمی‌شود.',
  terms_en:'Use must comply with Cloudflare Terms and local law. Plan quotas and expiry apply. Reachability is not guaranteed on every network.',
  guides_fa:'Android: کانفیگ کامل Xray را در کلاینت سازگار وارد کنید.\niOS: سازگاری ECH/Final Mask را در نسخه کلاینت خود بررسی کنید.\nWindows: JSON کامل را در کلاینت Xray وارد کنید. cs در همه واردکننده‌های URI حفظ نمی‌شود.',
  guides_en:'Android: import full Xray JSON into a compatible client.\niOS: verify ECH/Final Mask support in your client version.\nWindows: import full JSON in an Xray client. Not every URI importer preserves cs.',
  bot_username:''
};
const DEFAULT_TEST = { enabled:false, traffic_gb:1, daily_gb:1, days:1, cooldown_hours:48, node_id:'', allow_sales_node:false };
const DEFAULT_PANEL = { api_route:'sync', protocol:'vless', clean_ips:[], proxy_ips:[], user_nodes:[], ports:[443], paused:false, dns_url:'', usage_flush_seconds:30, max_tunnel_seconds:600, auto_update:false, remote_deploy:false, repository:'ArsalanAfshar/NexiUP' };
async function setting(r, key, fresh = false) {
  const c = cache(r).get('settings:' + key);
  if (!fresh && c && c.until > now()) return copy(c.value);
  const fallback = ({ bot:DEFAULT_SETTINGS, test:DEFAULT_TEST, panel:DEFAULT_PANEL, proxy:DEFAULT_PROXY })[key] || {};
  const row = await r.first('SELECT value FROM nx_settings WHERE key=?', key);
  const value = { ...copy(fallback), ...parse(row?.value, {}) };
  cache(r).set('settings:' + key, { value, until:now() + CACHE_MS }); return copy(value);
}
async function putSetting(r, key, value, actor) {
  await r.batch([
    ['INSERT INTO nx_settings(key,value,version,updated_at) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=version+1,updated_at=excluded.updated_at', key, JSON.stringify(value), now()],
    auditStmt(actor, 'setting_saved', key, { fields:Object.keys(value), validation:'passed' })
  ]);
  invalidate(r, 'settings:' + key);
}
function auditStmt(actor, action, target, detail = {}) { return ['INSERT INTO nx_audit(actor,action,target,detail,created_at) VALUES(?,?,?,?,?)', actor===WEB_ACTOR?'web:owner':String(actor), action, String(target), JSON.stringify(detail), now()]; }
async function audit(r, actor, action, target, detail = {}) { const [sql, ...args] = auditStmt(actor, action, target, detail); await r.run(sql, ...args); }
async function rate(r, key, milliseconds) {
  const row = await r.first(`INSERT INTO nx_limits(key,next_at) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET next_at=excluded.next_at WHERE nx_limits.next_at<=? RETURNING key`, key, now() + milliseconds, now());
  if (!row) throw new Fault('rate_limited', 429, Math.ceil(milliseconds / 1000));
}
async function lock(r, name, cooldown = 0) {
  const owner = randomId();
  const row = await r.first(`INSERT INTO nx_locks(name,owner,until_ms,not_before) VALUES(?,?,?,0) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms WHERE nx_locks.until_ms<=? AND nx_locks.not_before<=? RETURNING owner`, name, owner, now() + 60000, now(), now());
  if (!row) throw new Fault('busy', 409, 15);
  return async () => { await r.run('UPDATE nx_locks SET owner=?,until_ms=0,not_before=? WHERE name=? AND owner=?', '', now() + cooldown, name, owner); };
}
async function enqueue(r, id, userId, kind, data, due = now()) {
  await r.run('INSERT OR IGNORE INTO nx_jobs(id,user_id,kind,data,due,created_at) VALUES(?,?,?,?,?,?)', id, userId, kind, JSON.stringify(data), due, now());
}
async function notifyAdmins(r, id, text, buttons = null) {
  const admins = await r.all('SELECT id FROM nx_users WHERE admin=1 LIMIT 5');
  for (const uid of [...new Set([...ownerIds(r.env), ...admins.map(x => x.id)])].slice(0,5)) await enqueue(r, `${id}:${uid}`, uid, 'text', { text, buttons });
}

// ---------------- Operator profiles: immutable revisions and lossless formats ----------------
const DEFAULT_PROFILES = [
  { id:'irancell', label:'ایرانسل و سایر اپراتورها', label_en:'Irancell and other networks', enabled:true, fingerprint:'unsafe', ech:[],
    finalmask:{ tcp:[
      { type:'fragment', settings:{ packets:'tlshello', lengths:['0','104','1'], delays:['0'], maxSplit:'0' } },
      { type:'fragment', settings:{ packets:'1-1', lengths:['114','1'], delays:['1'], maxSplit:'11' } }
    ] },
    cipher_suites:'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256'
  },
  { id:'hamrah', label:'همراه اول', label_en:'Hamrah-e Aval', enabled:true, fingerprint:'chrome', finalmask:null, cipher_suites:'', ech:['cloudflare-ech.com+udp://1.1.1.1','cloudflare-ech.com+udp://8.8.8.8'] },
  { id:'standard', label:'استاندارد؛ بدون روش ویژه اپراتور', label_en:'Standard; no operator workaround', enabled:false, fingerprint:'chrome', finalmask:null, cipher_suites:'', ech:[] }
];
async function seed(r) {
  const items = [
    ...[['bot',DEFAULT_SETTINGS],['test',DEFAULT_TEST],['panel',DEFAULT_PANEL],['proxy',DEFAULT_PROXY]].map(([k,v]) => ['INSERT OR IGNORE INTO nx_settings(key,value,updated_at) VALUES(?,?,?)', k, JSON.stringify(v), now()]),
    ...DEFAULT_PROFILES.map(p => ['INSERT OR IGNORE INTO nx_profiles(id,data,updated_at) VALUES(?,?,?)', p.id, JSON.stringify(p), now()])
  ];
  await r.batch(items);
}
function rangeString(x, max = 65535) {
  if (typeof x !== 'string' || !/^\d{1,5}(?:-\d{1,5})?$/.test(x)) fail('invalid_fragment_range');
  const [a,b = a] = x.split('-').map(Number);
  if (a > b || b > max) fail('invalid_fragment_range');
  return [a,b];
}
function validateProfile(p) {
  keys(p, ['id','label','label_en','enabled','fingerprint','finalmask','cipher_suites','ech']);
  ident(p.id, 24); string(p.label, 100, 1); string(p.label_en, 100, 1); bool(p.enabled);
  if (!['chrome','firefox','safari','ios','android','edge','randomized','unsafe'].includes(p.fingerprint)) fail('unsupported_fingerprint');
  if (p.finalmask !== null) {
    keys(p.finalmask, ['tcp']);
    if (!Array.isArray(p.finalmask.tcp) || !p.finalmask.tcp.length || p.finalmask.tcp.length > 4) fail('invalid_finalmask');
    for (const part of p.finalmask.tcp) {
      keys(part, ['type','settings']); if (part.type !== 'fragment') fail('unsupported_mask');
      const s = part.settings; keys(s, ['packets','lengths','delays','maxSplit']);
      if (s.packets !== 'tlshello') { const [a] = rangeString(s.packets, 255); if (a < 1) fail('invalid_packets'); }
      for (const k of ['lengths','delays']) {
        if (!Array.isArray(s[k]) || !s[k].length || s[k].length > 8) fail('invalid_fragment_array');
        s[k].forEach(x => rangeString(x, k === 'delays' ? 1000 : 65535));
      }
      if (rangeString(s.lengths.at(-1))[0] === 0) fail('fragment_last_length_zero');
      rangeString(s.maxSplit, 1000);
    }
    if (JSON.stringify(p.finalmask).length > 1600) fail('finalmask_too_large');
  }
  string(p.cipher_suites, 1800);
  if (p.cipher_suites && !/^(TLS_[A-Z0-9_]+)(:TLS_[A-Z0-9_]+)*$/.test(p.cipher_suites)) fail('invalid_cipher_list');
  // Restrict to known TLS names; no speculative arbitrary field strings.
  const known = new Set(DEFAULT_PROFILES[0].cipher_suites.split(':'));
  if (p.cipher_suites && p.cipher_suites.split(':').some(s => !known.has(s))) fail('unsupported_cipher_suite');
  if (!Array.isArray(p.ech) || p.ech.length > 2 || new Set(p.ech).size !== p.ech.length) fail('invalid_ech_list');
  for (const entry of p.ech) {
    string(entry, 220, 1);
    const parts = entry.split('+');
    if (parts.length !== 2) fail('invalid_ech_entry');
    publicHost(parts[0]);
    let resolver; try { resolver = new URL(parts[1]); } catch { fail('invalid_ech_resolver'); }
    if (!['udp:','https:','tcp:','tls:'].includes(resolver.protocol) || resolver.username || resolver.password || resolver.hash || resolver.search) fail('invalid_ech_resolver');
    publicHost(resolver.hostname);
    if (resolver.protocol !== 'https:' && resolver.pathname && resolver.pathname !== '/') fail('invalid_ech_resolver');
  }
  return copy(p);
}
async function profiles(r, fresh = false) {
  const c = cache(r).get('profiles');
  if (!fresh && c && c.until > now()) return copy(c.value);
  const rows = await r.all('SELECT id,data,version FROM nx_profiles ORDER BY id LIMIT 7');
  if (rows.length > 6) fail('too_many_profiles');
  const value = rows.map(row => ({ ...validateProfile(parse(row.data)), version:row.version }));
  cache(r).set('profiles', { value, until:now() + CACHE_MS }); return copy(value);
}
async function saveProfile(r, actor, profile, expectedVersion = 0) {
  let p;
  try { p = validateProfile(profile); }
  catch (e) { await audit(r, actor, 'profile_invalid', String(profile?.id || '').slice(0,24), { validation:codeOf(e) }); throw e; }
  const release=await lock(r,'profile-set');
  try {
  const set=await r.all('SELECT id,data FROM nx_profiles LIMIT 7');
  const weight=profile=>profile.enabled?Math.max(1,profile.ech.length):0;
  if(set.filter(x=>x.id!==p.id).reduce((sum,x)=>sum+weight(parse(x.data)),0)+weight(p)>6)fail('profile_set_exceeds_variant_budget',422);
  const old = await r.first('SELECT * FROM nx_profiles WHERE id=?', p.id);
  if (old && old.version !== expectedVersion) fail('version_conflict', 409);
  if (!old && (await r.first('SELECT COUNT(*) AS n FROM nx_profiles')).n >= 6) fail('too_many_profiles');
  const items = [];
  if (old) items.push(['INSERT OR IGNORE INTO nx_profile_versions(id,version,data,actor,created_at) VALUES(?,?,?,?,?)', p.id, old.version, old.data, String(actor), now()]);
  items.push(['INSERT INTO nx_profiles(id,data,version,updated_at) VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=nx_profiles.version+1,updated_at=excluded.updated_at WHERE nx_profiles.version=?', p.id, JSON.stringify(p), now(), expectedVersion]);
  items.push(auditStmt(actor, 'profile_saved', p.id, { old:old ? parse(old.data) : null, next:p, validation:'passed', expectedVersion }));
  const out = await r.batch(items);
  if (!changes(out[old ? 1 : 0])) fail('version_conflict', 409);
  invalidate(r, 'profiles'); return { ...p, version:old ? old.version + 1 : 1 };
  } finally { await release(); }
}
async function rollbackProfile(r, actor, id) {
  const old = await r.first('SELECT * FROM nx_profile_versions WHERE id=? ORDER BY version DESC LIMIT 1', id);
  const active = await r.first('SELECT version FROM nx_profiles WHERE id=?', id);
  if (!old || !active) fail('no_previous_profile');
  return saveProfile(r, actor, parse(old.data), active.version); // Monotonic revision; rollback is itself auditable.
}
function base64Utf8(s) { let b = ''; for (const x of enc.encode(s)) b += String.fromCharCode(x); return btoa(b); }
function decodeBase64Utf8(s) { const b = atob(s.trim()); return dec.decode(Uint8Array.from(b, c => c.charCodeAt(0))); }
function parseBaseUri(link) {
  let u; try { u = new URL(link.trim()); } catch { fail('invalid_node_config'); }
  const protocol = u.protocol.slice(0,-1);
  if (!['vless','trojan'].includes(protocol) || u.password) fail('unsupported_node_protocol');
  const id = decodeURIComponent(u.username);
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) fail('invalid_node_identity');
  const params = u.searchParams;
  if (params.get('security') !== 'tls' || params.get('type') !== 'ws') fail('only_tls_websocket_supported');
  if (params.get('allowInsecure') === '1' || params.get('insecure') === '1' || params.get('allowInsecure') === 'true') fail('insecure_node_config');
  const server = publicHost(u.hostname), sni = publicHost(params.get('sni') || params.get('host') || server), host = publicHost(params.get('host') || sni);
  const path = params.get('path') || '/'; string(path, 800, 1);
  if (!path.startsWith('/')) fail('invalid_ws_path');
  const allowed = new Set(['encryption','security','sni','type','host','path','fp','alpn','fm','fragment','cs','ech','allowInsecure','insecure']);
  for (const key of params.keys()) if (!allowed.has(key)) fail('unrepresentable_node_parameter');
  if (params.has('encryption') && params.get('encryption') !== 'none') fail('unsupported_encryption');
  const alpn = (params.get('alpn') || '').split(',').filter(Boolean);
  if (alpn.some(x => !['http/1.1','h2'].includes(x))) fail('unsupported_alpn');
  return { protocol, id:id.toLowerCase(), server, port:number(Number(u.port || 443),1,65535,true), host, sni, path, alpn };
}
function aggregate(bases, activeProfiles) {
  if (!Array.isArray(bases) || !bases.length || bases.length > 4) fail('invalid_base_configs', 503);
  const variants = []; const seen = new Set();
  for (const raw of bases) {
    const b = typeof raw === 'string' ? parseBaseUri(raw) : parseBaseUri(baseUri(raw));
    for (const prof of activeProfiles.filter(p => p.enabled)) {
      const { version, ...data } = prof; const p = validateProfile(data);
      // A scalar echConfigList is required by Xray. Never join the two resolver strings.
      for (const ech of p.ech.length ? p.ech : ['']) {
        const key = JSON.stringify([b,p.id,ech]); if (seen.has(key)) continue; seen.add(key);
        const label = `${p.label} / ${p.label_en}${ech ? ' • ' + ech.split('+')[1] : ''} • ${b.protocol} ${b.server}:${b.port}`;
        variants.push({ ...b, profile:p.id, label, fingerprint:p.fingerprint, finalmask:p.finalmask, cipher_suites:p.cipher_suites, ech, version:version || 1 });
      }
    }
  }
  if (!variants.length) fail('no_enabled_profiles', 422);
  if (variants.length > 24) fail('too_many_variants', 422);
  return variants;
}
function baseUri(b) {
  const u = new URL(`${b.protocol}://${b.id}@${hostPort(b.server)}:${b.port}`);
  Object.entries({ encryption:'none',security:'tls',type:'ws',host:b.host,sni:b.sni,path:b.path,alpn:(b.alpn || []).join(',') }).forEach(([k,v]) => u.searchParams.set(k,v));
  return u.toString();
}
function variantUri(v) {
  const u = new URL(baseUri(v)); u.searchParams.set('fp',v.fingerprint);
  if (v.finalmask) u.searchParams.set('fm',JSON.stringify(v.finalmask));
  if (v.cipher_suites) u.searchParams.set('cs',v.cipher_suites);
  if (v.ech) u.searchParams.set('ech',v.ech);
  u.hash = v.label; return u.toString();
}
function xrayConfig(v) {
  const settings = v.protocol === 'vless'
    ? { vnext:[{ address:v.server, port:v.port, users:[{ id:v.id, encryption:'none' }] }] }
    : { servers:[{ address:v.server, port:v.port, password:v.id }] };
  const tlsSettings = { serverName:v.sni, fingerprint:v.fingerprint, allowInsecure:false };
  if (v.cipher_suites) tlsSettings.cipherSuites = v.cipher_suites;
  if (v.ech) tlsSettings.echConfigList = v.ech;
  if (v.alpn.length) tlsSettings.alpn = v.alpn;
  const streamSettings = { network:'ws', security:'tls', tlsSettings, wsSettings:{ path:v.path, headers:{ Host:v.host } } };
  if (v.finalmask) streamSettings.finalmask = v.finalmask;
  return { remarks:v.label, log:{ loglevel:'warning' }, inbounds:[{ tag:'socks', listen:'127.0.0.1',port:10808,protocol:'socks',settings:{udp:false} }], outbounds:[{tag:'proxy',protocol:v.protocol,settings,streamSettings},{tag:'direct',protocol:'freedom',settings:{}}] };
}
function renderSubscription(variants, format = 'base64') {
  if (['xray','vjson','v2ray'].includes(format)) return { body:JSON.stringify(variants.map(xrayConfig)), type:'application/json', warnings:[] };
  if (format === 'raw' || format === 'base64') {
    const s = variants.map(variantUri).join('\n');
    return { body:format === 'raw' ? s : base64Utf8(s),type:'text/plain; charset=utf-8',warnings:variants.some(v => v.cipher_suites) ? ['URI importers may discard cs; use full Xray JSON to retain cipherSuites.'] : [] };
  }
  if (!['clash','yaml','sing-box','singbox'].includes(format)) fail('unsupported_format', 422);
  const supported = variants.filter(v => !v.finalmask && !v.cipher_suites && !v.ech && v.fingerprint !== 'unsafe');
  const warnings = [...new Set(variants.filter(v => !supported.includes(v)).map(v => `Excluded ${v.profile}: Xray-specific settings; use format=xray.`))];
  if (!supported.length) throw new Fault('format_cannot_represent_enabled_profiles_use_xray', 422);
  if (format.startsWith('sing')) {
    return { type:'application/json', warnings, body:JSON.stringify({ inbounds:[{ type:'socks',tag:'socks-in',listen:'127.0.0.1',listen_port:10808 }], outbounds:[
      {type:'selector',tag:'proxy',outbounds:supported.map((v,i) => `nexiup-${i+1}`)},
      ...supported.map((v,i) => ({ type:v.protocol,tag:`nexiup-${i+1}`,server:v.server,server_port:v.port,...(v.protocol === 'vless' ? {uuid:v.id} : {password:v.id}),tls:{enabled:true,server_name:v.sni,insecure:false,utls:{enabled:true,fingerprint:v.fingerprint},...(v.alpn.length ? {alpn:v.alpn} : {})},transport:{type:'ws',path:v.path,headers:{Host:v.host}} }))
    ],route:{final:'proxy'}}) };
  }
  // JSON is valid YAML 1.2. Emit readable YAML with JSON scalars to avoid YAML injection.
  const proxies = supported.map((v,i) => ({ name:`${i+1} ${v.label}`,type:v.protocol,server:v.server,port:v.port,...(v.protocol === 'vless' ? {uuid:v.id,tls:true} : {password:v.id}),udp:false,servername:v.sni,'client-fingerprint':v.fingerprint,'skip-cert-verify':false,network:'ws','ws-opts':{path:v.path,headers:{Host:v.host}},...(v.alpn.length ? {alpn:v.alpn} : {}) }));
  return {type:'text/yaml; charset=utf-8',warnings,body:warnings.map(w => '# ' + w).join('\n') + '\n' + JSON.stringify({'mixed-port':7890,'allow-lan':false,mode:'rule',proxies,'proxy-groups':[{name:'NexiUP',type:'select',proxies:proxies.map(p => p.name)}],rules:['MATCH,NexiUP']},null,2)};
}
function mainSubscriptionUrl(settings, token) {
  if (!/^[a-f0-9]{32}$/.test(token)) fail('invalid_token');
  return httpsOrigin(settings.main_url) + '/sub/' + token;
}
function safeConfigParts(text, max = 3800) {
  const parts = []; let s = text;
  while (s.length > max) {
    let n = max;
    // Do not split a surrogate pair or an escaped URI byte. Rejoining parts is byte-for-byte exact.
    if (/[\uD800-\uDBFF]/.test(s[n-1])) n--;
    while (n > max-6 && /%(?:[a-f0-9])?$/i.test(s.slice(0,n))) n--;
    parts.push(s.slice(0,n)); s = s.slice(n);
  }
  if (s) parts.push(s); return parts;
}

// PNG encoder: 1-bit grayscale scanlines + uncompressed DEFLATE; no native/image dependency.
function crc32(data) { let c = 0xffffffff; for (const b of data) { c ^= b; for (let k=0;k<8;k++) c = (c>>>1) ^ ((c&1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function u32(x) { return Uint8Array.of(x>>>24,(x>>>16)&255,(x>>>8)&255,x&255); }
function concat(...chunks) { const out = new Uint8Array(chunks.reduce((n,c) => n+c.length,0)); let i=0; for (const c of chunks) { out.set(c,i);i+=c.length; } return out; }
function pngChunk(type, data) { const bytes = concat(enc.encode(type),data); return concat(u32(data.length),bytes,u32(crc32(bytes))); }
function qrMatrix(text) {
  string(text, 300, 1);
  // Fixed mask avoids evaluating eight masks on a 10 ms Free CPU budget. Valid ISO QR, medium ECC.
  const qr = qrcodegen.QrCode.encodeSegments([qrcodegen.QrSegment.makeBytes([...enc.encode(text)])], qrcodegen.QrCode.Ecc.MEDIUM, 1, 15, 0, false);
  return Array.from({length:qr.size},(_,y) => Array.from({length:qr.size},(_,x) => qr.getModule(x,y)));
}
function qrPng(text) {
  const matrix = qrMatrix(text), scale = 5, side = (matrix.length + 8) * scale, stride = Math.ceil(side/8);
  const raw = new Uint8Array((stride+1)*side);
  for (let y=0;y<side;y++) {
    const off=y*(stride+1); raw[off]=0; raw.fill(255,off+1,off+stride+1);
    for (let x=0;x<side;x++) {
      const mx=Math.floor(x/scale)-4,my=Math.floor(y/scale)-4;
      if (matrix[my]?.[mx]) raw[off+1+(x>>>3)] &= ~(128 >>> (x&7));
    }
  }
  let a=1,b=0; for(const v of raw){ a=(a+v)%65521; b=(b+a)%65521; }
  const blocks=[];
  for(let p=0;p<raw.length;p+=65535){const chunk=raw.slice(p,p+65535), n=chunk.length; blocks.push(Uint8Array.of(p+n===raw.length?1:0,n&255,n>>>8,(~n)&255,((~n)>>>8)&255),chunk);}
  const z=concat(Uint8Array.of(0x78,0x01),...blocks,u32(((b<<16)|a)>>>0));
  return concat(Uint8Array.of(137,80,78,71,13,10,26,10),pngChunk('IHDR',concat(u32(side),u32(side),Uint8Array.of(1,0,0,0,0))),pngChunk('IDAT',z),pngChunk('IEND',new Uint8Array()));
}

// ---------------- Original node implementation; Nahan users-API wire contract ----------------
function validatePanel(p) {
  keys(p,Object.keys(DEFAULT_PANEL)); ident(p.api_route,48);
  if (['setup','webhook','sub','health'].includes(p.api_route)) fail('reserved_route');
  if (!['vless','trojan','both'].includes(p.protocol)) fail('invalid_protocol');
  p.clean_ips=listHosts(p.clean_ips); p.proxy_ips=listProxyEndpoints(p.proxy_ips); p.user_nodes=listHosts(p.user_nodes);
  if (!Array.isArray(p.ports) || !p.ports.length || p.ports.length>4) fail('invalid_ports');
  p.ports.forEach(n => { if (![443,2053,2083,2087,2096,8443].includes(n)) fail('unsupported_tls_port'); });
  bool(p.paused); if(p.dns_url) p.dns_url=httpsUrl(p.dns_url);
  number(p.usage_flush_seconds,30,300,true); number(p.max_tunnel_seconds,60,600,true);
  if (p.auto_update !== false || p.remote_deploy !== false || p.repository !== 'ArsalanAfshar/NexiUP') fail('remote_code_execution_disabled');
  return copy(p);
}
function validatePanelUser(input, previous = null) {
  const allowed=['name','trafficLimit','dailyLimit','expiryDays','expiryMs','notes','connLimit','maxConfigs','proxyIp','cleanIp','userNodes','userPanelUrl','userMode','userPorts','isPaused'];
  keys(input,allowed);
  const d=previous ? copy(previous) : {name:'',trafficLimit:0,dailyLimit:0,expiryMs:0,notes:'',connLimit:0,maxConfigs:4,proxyIp:'',cleanIp:'',userNodes:'',userPanelUrl:'',userMode:'',userPorts:'',isPaused:false};
  if(input.name!==undefined) d.name=ident(input.name,64);
  if(!d.name) fail('name_required');
  for(const k of ['trafficLimit','dailyLimit']) if(input[k]!==undefined) d[k]=number(Number(input[k]),0,1000000);
  for(const k of ['connLimit','maxConfigs']) if(input[k]!==undefined) d[k]=number(Number(input[k]),0,k==='connLimit'?100:4,true);
  if(input.expiryDays!==undefined) d.expiryMs=input.expiryDays ? now()+number(Number(input.expiryDays),1,3650,true)*DAY : 0;
  if(input.expiryMs!==undefined) d.expiryMs=number(input.expiryMs,0,now()+3650*DAY,true);
  if(input.notes!==undefined) d.notes=string(input.notes,600);
  for(const k of ['proxyIp','cleanIp','userNodes']) if(input[k]!==undefined) d[k]=(k==='proxyIp'?listProxyEndpoints(input[k]||[]):listHosts(input[k]||[])).join(',');
  if(input.userPanelUrl!==undefined) d.userPanelUrl=input.userPanelUrl ? httpsOrigin(input.userPanelUrl) : '';
  if(input.userMode!==undefined) { if(!['','alpha','beta','both'].includes(input.userMode)) fail('invalid_user_mode'); d.userMode=input.userMode; }
  if(input.userPorts!==undefined) {
    const ports=String(input.userPorts).split(',').filter(Boolean).map(Number);
    if(ports.length>4 || ports.some(n=>![443,2053,2083,2087,2096,8443].includes(n))) fail('invalid_user_ports'); d.userPorts=ports.join(',');
  }
  if(input.isPaused!==undefined) d.isPaused=bool(input.isPaused);
  return d;
}
function dayKey() { return new Date(now()).toISOString().slice(0,10); }
function enrichedPanel(row, usage=null, origin='', route='sync') {
  const d=parse(row.data); const day=dayKey();
  const total=(usage?.up||0)+(usage?.down||0),daily=usage?.day===day ? (usage.day_up||0)+(usage.day_down||0) : 0;
  return { ...d,id:row.id,epoch:row.epoch,createdAt:row.created_at,
    limitTotalReq:d.trafficLimit*6000,limitDailyReq:d.dailyLimit*6000,
    usage:{total,limit:Math.floor(d.trafficLimit*GIB),dailyBytes:daily,daily:daily/GIB*6000,dailyLimit:d.dailyLimit*6000,upload:usage?.up||0,download:usage?.down||0},
    status:d.isPaused?'paused':(d.expiryMs && d.expiryMs<=now())?'expired':((d.trafficLimit && total>=d.trafficLimit*GIB)||(d.dailyLimit && daily>=d.dailyLimit*GIB))?'limited':'active',
    ...(origin ? {subscriptionUrl:`${origin}/${route}?sub=${encodeURIComponent(d.name)}`} : {})
  };
}
async function panelGet(r,id,origin='') {
  const row=await r.first('SELECT u.*,x.up,x.down,x.day,x.day_up,x.day_down FROM nx_panel_users u LEFT JOIN nx_panel_usage x ON x.id=u.id AND x.epoch=u.epoch WHERE u.id=? OR u.name=? COLLATE NOCASE',id,id);
  if(!row) fail('user_not_found',404);
  return enrichedPanel(row,row,origin,(await setting(r,'panel')).api_route);
}
async function panelCreate(r,input,idempotency='') {
  const d=validatePanelUser(input); const id=crypto.randomUUID();
  const res=await r.run('INSERT OR IGNORE INTO nx_panel_users(id,name,data,create_key,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM nx_panel_users)<100',id,d.name,JSON.stringify(d),idempotency||null,now());
  if(!changes(res)) {
    const old=await r.first('SELECT * FROM nx_panel_users WHERE name=? COLLATE NOCASE OR create_key=?',d.name,idempotency||null);
    if(!old)fail('node_user_safety_limit',409);
    if(!idempotency || old?.create_key!==idempotency || old.name!==d.name) fail('duplicate_name',409);
    return enrichedPanel(old);
  }
  invalidate(r,'panel-users'); return enrichedPanel({id,data:JSON.stringify(d),epoch:0,created_at:now()});
}
async function panelMutate(r,id,method,input={},action='',key='') {
  const row=await r.first('SELECT * FROM nx_panel_users WHERE id=?',id); if(!row) fail('user_not_found',404);
  if(method==='DELETE') {
    await r.batch([['DELETE FROM nx_panel_users WHERE id=?',id],['DELETE FROM nx_panel_usage WHERE id=?',id]]); invalidate(r,'panel-users'); return {success:true};
  }
  if(action==='reset') {
    // Epoch fencing prevents buffered pre-reset bytes from resurrecting after a reset.
    await r.run('INSERT OR IGNORE INTO nx_panel_requests(key,user_id,action,created_at) VALUES(?,?,?,?)',key||randomId(),id,'reset',now());
  } else if(action==='toggle') {
    const mutation='toggle:'+(key||randomId());
    await r.batch([
      ['INSERT OR IGNORE INTO nx_panel_requests(key,user_id,action,created_at) VALUES(?,?,?,?)',mutation,id,'toggle_pending',now()],
      ["UPDATE nx_panel_users SET data=json_set(data,'$.isPaused',json(CASE WHEN json_extract(data,'$.isPaused')=1 THEN 'false' ELSE 'true' END)) WHERE id=? AND EXISTS(SELECT 1 FROM nx_panel_requests WHERE key=? AND user_id=? AND action='toggle_pending')",id,mutation,id],
      ["UPDATE nx_panel_requests SET action='toggle_done' WHERE key=? AND user_id=? AND action='toggle_pending'",mutation,id]
    ]);
  } else if(method==='PUT') {
    const d=validatePanelUser(input,parse(row.data));
    try { await r.run('UPDATE nx_panel_users SET name=?,data=? WHERE id=?',d.name,JSON.stringify(d),id); } catch { fail('duplicate_name',409); }
  } else fail('invalid_user_action');
  invalidate(r,'panel-users'); return {success:true,user:await panelGet(r,id)};
}
function panelBases(user, panel, origin) {
  const originHost=new URL(httpsOrigin(origin)).hostname;
  const hosts=listHosts(user.userNodes || panel.user_nodes); if(!hosts.length) hosts.push(publicHost(originHost));
  const clean=listHosts(user.cleanIp || panel.clean_ips);
  const ports=user.userPorts ? user.userPorts.split(',').map(Number) : panel.ports;
  const mode=({alpha:'vless',beta:'trojan',both:'both'})[user.userMode] || panel.protocol;
  const protocols=mode==='both'?['vless','trojan']:[mode];
  const out=[];
  for(const h of hosts) for(const server of clean.length?clean:[h]) for(const port of ports) for(const protocol of protocols) {
    out.push({protocol,id:user.id,server,port,host:h,sni:h,path:`/${panel.api_route}/ws`,alpn:[]});
  }
  const cap=user.maxConfigs || 4;
  if(out.length>cap) fail('base_config_count_exceeds_maxConfigs',422); // Never silently trim operator variants.
  return out;
}
async function panelAuth(r,request,masterOnly=false) {
  if(!strongSecret(r.env.MASTER_KEY)) fail('master_key_required_min_32',503);
  const ip=String(request.headers.get('cf-connecting-ip')||'unknown'); const bucket=authFailures.get(ip);
  if(bucket && bucket.until>now() && bucket.count>=8) throw new Fault('auth_throttled',429,60);
  const header=request.headers.get('authorization')||'';
  const key=header.startsWith('Bearer ')?header.slice(7):'';
  let actor='master',ok=constantTimeEqual(key,r.env.MASTER_KEY);
  if(!ok && !masterOnly && key) {
    const allowed=await r.all('SELECT id,secret_ref FROM nx_panel_keys LIMIT 8');
    for(const v of allowed) if(strongSecret(r.env[v.secret_ref]) && constantTimeEqual(key,r.env[v.secret_ref])) {ok=true;actor=v.id;}
  }
  if(!ok) {
    if(authFailures.size>1000) authFailures.clear();
    authFailures.set(ip,{count:(bucket?.until>now()?bucket.count:0)+1,until:now()+60000});
    fail('unauthorized',401);
  }
  // Durable API control-plane throttle (not used for tunnel packets).
  const allowance=await r.first(`INSERT INTO nx_limits(key,next_at) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET next_at=MAX(nx_limits.next_at,?)+100 WHERE nx_limits.next_at<=? RETURNING key`,'panel-api:'+actor+':'+ip,now()+100,now(),now()+2000);
  if(!allowance)throw new Fault('panel_api_rate_limit',429,1);
  return actor;
}
async function panelApi(r,request,url,panel) {
  const route=`/${panel.api_route}/api/`, endpoint=url.pathname.slice(route.length);
  const actor=await panelAuth(r,request,['config','keys','backup','restore','logs','usage','update'].includes(endpoint));
  const id=url.searchParams.get('id'),action=url.searchParams.get('action')||'', method=request.method;
  if(endpoint==='users') {
    if(method==='GET') {
      if(id) {const user=await panelGet(r,id,url.origin);return json({success:true,user,...(action==='configs'?{bases:panelBases(user,panel,url.origin)}:{})});}
      const q=(url.searchParams.get('q')||'').slice(0,40),limit=20,cursor=url.searchParams.get('cursor')||'';
      const rows=await r.all('SELECT u.*,x.up,x.down,x.day,x.day_up,x.day_down FROM nx_panel_users u LEFT JOIN nx_panel_usage x ON x.id=u.id AND x.epoch=u.epoch WHERE u.id>? AND (u.name LIKE ? OR u.id=?) ORDER BY u.id LIMIT ?',cursor,'%'+q+'%',q,limit+1);
      const total=(await r.first('SELECT COUNT(*) AS n FROM nx_panel_users')).n;
      return json({success:true,total,users:rows.slice(0,limit).map(row=>enrichedPanel(row,row,url.origin,panel.api_route)),next:rows.length>limit?rows[limit-1].id:null,capabilities:{nexiup:2,idempotency:true,absoluteExpiry:true}});
    }
    const key=string(request.headers.get('idempotency-key')||'',100);
    let result;
    if(method==='POST'&&!id) result={success:true,user:await panelCreate(r,await bodyJson(request),key)};
    else if(id && ['POST','PUT','DELETE'].includes(method)) result=await panelMutate(r,id,method,method==='PUT'?await bodyJson(request):{},action,key);
    else fail('method_not_allowed',405);
    const auditIdentity=result.user?.id||id||'';
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(auditIdentity)));
    await audit(r,actor,'panel_user_'+(action||method.toLowerCase()),'user#'+Array.from(digest.slice(0,8),b=>b.toString(16).padStart(2,'0')).join(''),{});
    if(result.user) result.subscriptionUrl=`${url.origin}/${panel.api_route}?sub=${encodeURIComponent(result.user.name)}`;
    return json(result,method==='POST'&&!id?201:200);
  }
  if(endpoint==='config') {
    if(method==='GET') return json({success:true,config:panel,version:VERSION});
    if(method==='PUT') { const p=validatePanel(await bodyJson(request)); await putSetting(r,'panel',p,actor); return json({success:true}); }
  }
  if(endpoint==='keys') {
    if(method==='GET') return json({success:true,keys:await r.all('SELECT id,name,secret_ref,created_at FROM nx_panel_keys ORDER BY created_at LIMIT 8')});
    if(method==='DELETE'&&id) { await r.run('DELETE FROM nx_panel_keys WHERE id=?',id); await audit(r,actor,'key_revoked',id); return json({success:true}); }
    if(method==='POST') {
      const data=await bodyJson(request); keys(data,['name','secret_ref']);string(data.name,80,1);ref(data.secret_ref);
      if(!strongSecret(r.env[data.secret_ref])||controlSecret(r.env,r.env[data.secret_ref])) fail('set_distinct_panel_key_secret_first');
      if((await r.first('SELECT COUNT(*) AS n FROM nx_panel_keys')).n>=8) fail('too_many_keys');
      const kid=randomId(8);
      await r.run('INSERT INTO nx_panel_keys(id,name,secret_ref,created_at) VALUES(?,?,?,?)',kid,data.name,data.secret_ref,now());
      await audit(r,actor,'key_registered',kid,{secret_ref:data.secret_ref});return json({success:true,id:kid},201);
    }
  }
  if(endpoint==='proxy-check'&&method==='POST') {
    const b=await bodyJson(request);keys(b,['endpoint','mode']);const endpoint=proxyEndpoint(b.endpoint).endpoint;
    if(!['tcp','relay'].includes(b.mode))fail('invalid_probe_mode');
    const settings=await setting(r,'proxy',true);
    await rate(r,'node:proxy-probe:'+b.mode+':'+endpoint,30000);await spendProxyBudget(r,settings);
    return json({success:true,probe:await localProxyProbe(endpoint,b.mode,settings.timeout_ms,request.cf?.colo||'')});
  }
  if(endpoint==='stats'&&method==='GET') return json({success:true,colo:request.cf?.colo||null,request_country:request.cf?.country||null,proxy_exit:{verified:false,ip:null,country:null},users:(await r.first('SELECT COUNT(*) AS n FROM nx_panel_users')).n,version:VERSION});
  if(endpoint==='logs'&&method==='GET') return json({success:true,logs:await r.all('SELECT * FROM nx_audit WHERE id>? ORDER BY id LIMIT 20',Number(url.searchParams.get('after')||0))});
  if(endpoint==='backup'&&method==='GET') {
    const page=url.searchParams.get('cursor')||'';
    const users=await r.all('SELECT * FROM nx_panel_users WHERE id>? ORDER BY id LIMIT 21',page);
    await audit(r,actor,'panel_backup',page);
    return json({project:'NexiUP',version:2,config:panel,users:users.slice(0,20),next:users.length>20?users[19].id:null,notice:'Configuration/identities only. Export D1 for accounting and full recovery; keep this private.'});
  }
  if(endpoint==='restore'&&method==='POST') {
    const data=await bodyJson(request,64000);if(data.project!=='NexiUP'||!Array.isArray(data.users)||data.users.length>20)fail('invalid_backup');
    const rows=data.users.map(row=>{if(!/^[a-f0-9-]{36}$/i.test(row.id)) fail('invalid_uuid');const d=validatePanelUser(parse(row.data));return [row,d];});
    // Restore is upsert-only; never clears traffic or resurrects deleted identities implicitly.
    const stmts=rows.map(([row,d])=>['INSERT INTO nx_panel_users(id,name,data,epoch,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data',row.id,d.name,JSON.stringify(d),number(row.epoch||0,0,1e9,true),row.created_at||now()]);
    if(data.config) {const p=validatePanel(data.config);stmts.push(['UPDATE nx_settings SET value=?,version=version+1,updated_at=? WHERE key=?',JSON.stringify(p),now(),'panel']);}
    stmts.push(auditStmt(actor,'panel_restore','',{users:rows.length}));await r.batch(stmts);invalidate(r);return json({success:true});
  }
  if(endpoint==='update') return json({enabled:false,repository:'https://github.com/ArsalanAfshar/NexiUP',notice:'Manual reviewed upgrades only. No remote execution or phone-home.'});
  fail('not_found',404);
}

// ---------------- Tunnels: bounded WS/TCP, VLESS, Trojan, optional DNS-only UDP ----------------
// Original FIPS 180-4 SHA-224 implementation for Trojan password hashes (WebCrypto has no SHA-224).
function sha224(text) {
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const input=enc.encode(text),len=Math.ceil((input.length+9)/64)*64,b=new Uint8Array(len);b.set(input);b[input.length]=128;
  new DataView(b.buffer).setUint32(len-4,input.length*8);
  const h=[0xc1059ed8,0x367cd507,0x3070dd17,0xf70e5939,0xffc00b31,0x68581511,0x64f98fa7,0xbefa4fa4],w=new Uint32Array(64),ro=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let p=0;p<len;p+=64){
    const v=new DataView(b.buffer,p,64);for(let i=0;i<16;i++)w[i]=v.getUint32(i*4);
    for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(ro(x,7)^ro(x,18)^(x>>>3))+w[i-7]+(ro(y,17)^ro(y,19)^(y>>>10)))>>>0;}
    let [a,c,d,e,f,g,j,k]=h;
    for(let i=0;i<64;i++){const x=(k+(ro(f,6)^ro(f,11)^ro(f,25))+((f&g)^(~f&j))+K[i]+w[i])>>>0,y=((ro(a,2)^ro(a,13)^ro(a,22))+((a&c)^(a&d)^(c&d)))>>>0;k=j;j=g;g=f;f=(e+x)>>>0;e=d;d=c;c=a;a=(x+y)>>>0;}
    [a,c,d,e,f,g,j,k].forEach((x,i)=>h[i]=(h[i]+x)>>>0);
  }
  return h.slice(0,7).map(x=>x.toString(16).padStart(8,'0')).join('');
}
function addressAt(b,offset,type,domainType,ipv6Type) {
  let host,p=offset;
  if(type===1){if(b.length<p+4)return null;host=Array.from(b.slice(p,p+4)).join('.');p+=4;}
  else if(type===domainType){if(b.length<p+1||b.length<p+1+b[p])return null;const n=b[p++];host=dec.decode(b.slice(p,p+n));p+=n;}
  else if(type===ipv6Type){if(b.length<p+16)return null;host=Array.from({length:8},(_,i)=>((b[p+i*2]<<8)|b[p+i*2+1]).toString(16)).join(':');p+=16;}
  else fail('unsupported_address');
  return {host:publicHost(host),offset:p};
}
function parseTunnelHeader(bytes) {
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(!b.length)return null;
  if(b[0]===0) {
    if(b.length<18)return null;
    const uuid=Array.from(b.slice(1,17),x=>x.toString(16).padStart(2,'0')).join('');
    const p=18+b[17];if(b.length<p+4)return null;
    const command=b[p],port=(b[p+1]<<8)|b[p+2];if(![1,2].includes(command))fail('unsupported_command');
    const a=addressAt(b,p+4,b[p+3],2,3);if(!a)return null;
    return {protocol:'vless',identity:uuid,port,host:a.host,udp:command===2,payload:b.slice(a.offset),response:Uint8Array.of(b[0],0)};
  }
  if(b.length<60)return null;
  const hash=dec.decode(b.slice(0,56));if(!/^[0-9a-f]{56}$/.test(hash)||b[56]!==13||b[57]!==10||b[58]!==1)fail('invalid_trojan_header');
  const a=addressAt(b,60,b[59],3,4);if(!a||b.length<a.offset+4)return null;
  const port=(b[a.offset]<<8)|b[a.offset+1];if(b[a.offset+2]!==13||b[a.offset+3]!==10)fail('invalid_trojan_header');
  return {protocol:'trojan',identity:hash,port,host:a.host,udp:false,payload:b.slice(a.offset+4),response:new Uint8Array()};
}
async function tunnelUsers(r,fresh=false) {
  const c=cache(r).get('panel-users');if(!fresh&&c&&c.until>now())return c.value;
  const rows=await r.all('SELECT u.*,x.up,x.down,x.day,x.day_up,x.day_down FROM nx_panel_users u LEFT JOIN nx_panel_usage x ON x.id=u.id AND x.epoch=u.epoch LIMIT 101');
  if(rows.length>100)fail('node_user_safety_limit',503);
  const value=rows.map(row=>({user:enrichedPanel(row,row),uuid:row.id.replaceAll('-',''),hash:sha224(row.id)}));
  cache(r).set('panel-users',{value,until:now()+10000});return value;
}
function trafficState(r) { if(!localTraffic.has(r.raw))localTraffic.set(r.raw,{deltas:new Map(),inflight:null,last:0});return localTraffic.get(r.raw); }
function trackBytes(r,user,up,down) {
  const s=trafficState(r),day=dayKey(),key=user.id+':'+user.epoch+':'+day;
  const d=s.deltas.get(key)||{id:user.id,epoch:user.epoch,day,up:0,down:0};d.up+=up;d.down+=down;s.deltas.set(key,d);
}
async function flushUsage(r,force=false) {
  const s=trafficState(r),p=await setting(r,'panel');
  if(s.inflight===true)return;
  if(!force&&now()-s.last<p.usage_flush_seconds*1000)return;
  if(!s.inflight){if(!s.deltas.size)return;s.inflight={id:randomId(),data:[...s.deltas.values()].slice(0,20)};for(const d of s.inflight.data)s.deltas.delete(d.id+':'+d.epoch+':'+d.day);}
  const batch=s.inflight;s.inflight=true;
  try { await r.run('INSERT OR IGNORE INTO nx_flush(id,data,created_at) VALUES(?,?,?)',batch.id,JSON.stringify(batch.data),now());s.last=now();s.inflight=null; }
  catch(e){s.inflight=batch;throw e;} // Retry the exact batch id, never double-add after an ambiguous D1 response.
}
function checkQuota(r,user) {
  if(user.isPaused||(user.expiryMs&&user.expiryMs<=now()))fail('account_inactive',403);
  const state=trafficState(r),d=[...state.deltas.values()].filter(x=>x.id===user.id&&x.epoch===user.epoch);
  const pending=d.reduce((n,x)=>n+x.up+x.down,0),today=d.filter(x=>x.day===dayKey()).reduce((n,x)=>n+x.up+x.down,0);
  if(user.trafficLimit && user.usage.total+pending>=user.trafficLimit*GIB)fail('total_quota',403);
  if(user.dailyLimit && user.usage.dailyBytes+today>=user.dailyLimit*GIB)fail('daily_quota',403);
}
async function timed(p,ms,onTimeout=()=>{}) {let id;try{return await Promise.race([p,new Promise((_,reject)=>{id=setTimeout(()=>{onTimeout();reject(new Fault('socket_timeout',504));},ms);})]);}finally{clearTimeout(id);}}
function closeSocket(socket){try{const p=socket?.close();p?.catch?.(()=>{});}catch{}}
async function tunnel(r,request,panel) {
  if(panel.paused)fail('node_paused',503);
  if(liveWebSockets>=64)fail('isolate_busy',503);
  const users=await tunnelUsers(r);
  if(liveWebSockets>=64)fail('isolate_busy',503);
  liveWebSockets++;
  const pair=new WebSocketPair(),client=pair[0],ws=pair[1];ws.accept();
  let header=new Uint8Array(),auth=null,counted=false,socket=null,writer=null,queue=Promise.resolve(),queued=0,closed=false,responsePrefix=null,dnsBuffer=new Uint8Array(),dnsCount=0,periodic,lifetime,handshakeTimer;
  const close=()=>{
    if(closed)return;closed=true;liveWebSockets=Math.max(0,liveWebSockets-1);clearInterval(periodic);clearTimeout(lifetime);clearTimeout(handshakeTimer);
    try{ws.close(1000,'closed');}catch{}closeSocket(socket);
    if(auth&&counted){const n=(openTunnels.get(auth.id)||1)-1;if(n>0)openTunnels.set(auth.id,n);else openTunnels.delete(auth.id);}
    // A bounded tail flush is best-effort. Isolate eviction can still lose buffered bytes.
    if(auth&&r.queries<40)r.execution.waitUntil?.(queue.then(()=>flushUsage(r)).catch(()=>{}));
  };
  async function send(data){if(closed)return;if(responsePrefix){data=concat(responsePrefix,data);responsePrefix=null;}ws.send(data);}
  async function dns(data){
    dnsBuffer=concat(dnsBuffer,data);if(dnsBuffer.length>8192)fail('dns_buffer_limit');
    while(dnsBuffer.length>=2){const n=(dnsBuffer[0]<<8)|dnsBuffer[1];if(n>4096)fail('dns_packet_limit');if(dnsBuffer.length<n+2)return;
      if(++dnsCount>16)fail('dns_request_limit');const packet=dnsBuffer.slice(2,n+2);dnsBuffer=dnsBuffer.slice(n+2);
      const response=await r.fetch(panel.dns_url,{method:'POST',headers:{'Content-Type':'application/dns-message','Accept':'application/dns-message'},body:packet});
      if(!response.ok)fail('dns_upstream',502);const out=new Uint8Array(await response.arrayBuffer());if(out.length>4096)fail('dns_response_limit');
      trackBytes(r,auth,packet.length,out.length);checkQuota(r,auth);await send(concat(Uint8Array.of(out.length>>>8,out.length&255),out));
    }
  }
  async function consume(data){
    if(closed)return;if(!auth){
      header=concat(header,data);if(header.length>8192)fail('handshake_too_large');
      const parsed=parseTunnelHeader(header);if(!parsed)return;
      const found=users.find(v=>constantTimeEqual(parsed.identity,parsed.protocol==='vless'?v.uuid:v.hash));
      if(!found)fail('tunnel_unauthorized',401);auth=copy(found.user);
      const mode=({alpha:'vless',beta:'trojan',both:'both'})[auth.userMode]||panel.protocol;
      if(mode!=='both'&&mode!==parsed.protocol)fail('protocol_disabled');
      checkQuota(r,auth);const n=openTunnels.get(auth.id)||0;if(auth.connLimit&&n>=auth.connLimit){auth=null;fail('connection_limit');}
      openTunnels.set(auth.id,n+1);counted=true;clearTimeout(handshakeTimer);responsePrefix=parsed.response;header=null;
      if(parsed.udp){if(parsed.port!==53||!panel.dns_url)fail('only_configured_dns_udp_supported');auth.udp=true;return dns(parsed.payload);}
      if(!parsed.port||parsed.port===25)fail('destination_port_denied');
      // Client-supplied proxyip query strings are never trusted. Only admin-stored fallback hosts.
      const proxies=listProxyEndpoints(auth.proxyIp||panel.proxy_ips).map(p=>proxyEndpoint(p,parsed.port));
      for(const destination of [{host:parsed.host,port:parsed.port},...proxies]) {
        try{socket=connect({hostname:destination.host,port:destination.port});socket.closed?.catch(()=>{});await timed(socket.opened,5000,()=>closeSocket(socket));break;}catch{closeSocket(socket);socket=null;}
      }
      if(!socket)fail('tcp_connect_failed',502);writer=socket.writable.getWriter();
      if(parsed.payload.length){await timed(writer.write(parsed.payload),5000,close);trackBytes(r,auth,parsed.payload.length,0);}
      const read=async()=>{try{const reader=socket.readable.getReader();while(!closed){const {value,done}=await reader.read();if(done)break;trackBytes(r,auth,0,value.length);checkQuota(r,auth);await send(value);}}catch{}finally{close();}};
      r.execution.waitUntil?.(read());return;
    }
    checkQuota(r,auth);if(auth.udp)return dns(data);
    if(writer){await timed(writer.write(data),10000,close);trackBytes(r,auth,data.length,0);}
  }
  function incoming(event){
    if(typeof event.data==='string')return close();const data=new Uint8Array(event.data);
    queued+=data.length;if(queued>1024*1024||data.length>262144)return close();
    queue=queue.then(()=>consume(data)).catch(close).finally(()=>queued-=data.length);
  }
  ws.addEventListener('message',incoming);ws.addEventListener('close',close);ws.addEventListener('error',close);
  const early=request.headers.get('sec-websocket-protocol');
  if(early){try{if(early.length>5464)fail('early_data_limit');const s=atob(early.replaceAll('-','+').replaceAll('_','/'));incoming({data:Uint8Array.from(s,c=>c.charCodeAt(0)).buffer});}catch{close();return json({error:'invalid_early_data'},400);}}
  periodic=setInterval(()=>{
    if(closed)return;
    // At most 20 refresh cycles; no per-packet D1 access. Budget closes unusually expensive tunnels.
    queue=queue.then(async()=>{if(r.queries>38)return close();await flushUsage(r);const p=await setting(r,'panel');if(p.paused)return close();if(auth){const latest=(await tunnelUsers(r,true)).find(x=>x.user.id===auth.id);if(!latest)return close();auth={...latest.user,udp:auth.udp};checkQuota(r,auth);}}).catch(close);
  },Math.max(30000,panel.usage_flush_seconds*1000));
  handshakeTimer=setTimeout(()=>{if(!auth)close();},10000);
  lifetime=setTimeout(close,panel.max_tunnel_seconds*1000);
  return new Response(null,{status:101,webSocket:client});
}

// ---------------- Hub registry, paid/test idempotency and provisioning ----------------
function validatePlan(p) {
  keys(p,['id','name','description','days','daily_gb','total_gb','conn_limit','price','locations','enabled','reset_usage','max_configs']);
  ident(p.id,24);string(p.name,100,1);string(p.description,600);number(p.days,1,3650,true);
  number(p.daily_gb,0,1000000);number(p.total_gb,0,1000000);number(p.conn_limit,0,100,true);number(p.price,0,1e12,true);
  if(!Array.isArray(p.locations)||!p.locations.length||p.locations.some(x=>!['de','us'].includes(x))||new Set(p.locations).size!==p.locations.length)fail('invalid_locations');
  bool(p.enabled);bool(p.reset_usage);number(p.max_configs,1,4,true);return copy(p);
}
function validateNode(n) {
  keys(n,['id','code','label','base_url','api_route','api_key_ref','max_users','enabled','purpose','adapter','local']);
  ident(n.id,24);ident(n.code,16);string(n.label,100,1);n.base_url=httpsOrigin(n.base_url);ident(n.api_route,48);
  number(n.max_users,1,100,true);bool(n.enabled);bool(n.local);
  if(!['sales','test'].includes(n.purpose)||!['nexiup','nahan'].includes(n.adapter))fail('invalid_node_type');
  if(n.purpose==='sales'&&!['de','us'].includes(n.code))fail('invalid_sales_location');
  if(!n.local)ref(n.api_key_ref);else if(n.adapter!=='nexiup')fail('local_node_must_be_nexiup');
  return copy(n);
}
async function saveNode(r,n,actor) {
  n=validateNode(n);
  if(n.local&&getRole(r.env)==='hub')fail('local_requires_all_role');
  if(n.local&&!strongSecret(r.env.MASTER_KEY))fail('master_key_required_min_32',503);
  if(!n.local&&(!validNodeKey(n,r.env[n.api_key_ref])||controlSecret(r.env,r.env[n.api_key_ref])))fail('distinct_node_secret_required');
  if(n.local){const other=await r.first('SELECT id FROM nx_nodes WHERE local=1 AND id<>?',n.id);if(other)fail('one_local_node_registry_entry_only');}
  const previous=await r.first('SELECT * FROM nx_nodes WHERE id=?',n.id);
  if(previous){
    const used=await r.first('SELECT id FROM nx_subs WHERE node_id=? UNION SELECT id FROM nx_ops WHERE node_id=? LIMIT 1',n.id,n.id);
    if(used&&['base_url','api_route','adapter','local','code','purpose'].some(k=>String(previous[k])!==String(k==='local'?Number(n[k]):n[k])))fail('node_in_use_change_endpoint_via_new_node');
  }
  await r.batch([
    [`INSERT INTO nx_nodes(id,code,label,base_url,api_route,api_key_ref,max_users,enabled,purpose,adapter,local,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,label=excluded.label,base_url=excluded.base_url,api_route=excluded.api_route,api_key_ref=excluded.api_key_ref,max_users=excluded.max_users,enabled=excluded.enabled,purpose=excluded.purpose,adapter=excluded.adapter,local=excluded.local`,n.id,n.code,n.label,n.base_url,n.api_route,n.api_key_ref,n.max_users,+n.enabled,n.purpose,n.adapter,+n.local,now()],
    auditStmt(actor,'node_saved',n.id,{fields:Object.keys(n),validation:'passed'})
  ]);
}
async function nodeRequest(r,node,method='GET',id='',payload=null,action='',idempotency='') {
  if(method==='POST'&&!id&&payload&&payload.proxyIp===undefined&&!node.local){
    const policy=await r.first('SELECT endpoints FROM nx_proxy_policies WHERE target=?','node:'+node.id);
    if(policy)payload={...payload,proxyIp:listProxyEndpoints(parse(policy.endpoints,[])).join(',')};
  }
  if(node.local) {
    if(getRole(r.env)==='hub')fail('local_requires_all_role',503);
    if(!strongSecret(r.env.MASTER_KEY))fail('master_key_required_min_32',503);
    if(method==='GET'&&id)return {success:true,user:await panelGet(r,id,node.base_url)};
    if(method==='GET')return {success:true,total:(await r.first('SELECT COUNT(*) AS n FROM nx_panel_users')).n};
    if(method==='POST'&&!id)return {success:true,user:await panelCreate(r,payload,idempotency)};
    return panelMutate(r,id,method,payload||{},action,idempotency);
  }
  const key=r.env[node.api_key_ref];
  if(!validNodeKey(node,key)||controlSecret(r.env,key))fail('node_api_key_missing_or_master',503);
  const url=new URL(`${httpsOrigin(node.base_url)}/${ident(node.api_route,48)}/api/users`);
  if(id)url.searchParams.set('id',id);if(action)url.searchParams.set('action',action);
  let res;
  try {res=await r.fetch(url.toString(),{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...(idempotency?{'Idempotency-Key':idempotency}:{})},...(payload?{body:JSON.stringify(payload)}:{})});}
  catch(e){if(e instanceof Fault && ['fetch_budget','query_budget'].includes(e.code))throw e;throw new Fault(method==='GET'?'node_unreachable':'node_result_ambiguous',502);}
  if(res.status===404)fail('user_not_found',404);
  if([400,401,403,409,422,429].includes(res.status))throw new Fault('node_rejected_'+res.status,res.status,Math.min(120,Number(res.headers.get('Retry-After'))||15));
  if(!res.ok)throw new Fault(method==='GET'?'node_unreachable':'node_result_ambiguous',502);
  const data=parse(await res.text());
  if(data?.success!==true)throw new Fault(method==='GET'?'invalid_node_response':'node_result_ambiguous',502);
  return data;
}
async function eligibleNodes(r,location,purpose='sales',exclude=[]) {
  const rows=await r.all(`SELECT n.*, (SELECT COUNT(*) FROM nx_subs s WHERE s.node_id=n.id AND s.status='active' AND s.expires_at>?) + (SELECT COUNT(*) FROM nx_ops o WHERE o.node_id=n.id AND o.state NOT IN ('done','failed')) AS load FROM nx_nodes n WHERE n.enabled=1 AND n.code=? AND n.purpose=? ORDER BY load*1.0/n.max_users,n.created_at LIMIT 10`,now(),location,purpose);
  return rows.filter(n=>!exclude.includes(n.id)&&n.load<n.max_users);
}
function userPayload(name,p) { return {name,trafficLimit:p.total_gb,dailyLimit:p.daily_gb,expiryDays:p.days,connLimit:p.conn_limit,maxConfigs:p.max_configs,notes:'NexiUP managed account'}; }
function normalizeRemoteUser(u) {
  if(!u||typeof u.id!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(u.id)||!u.name)fail('invalid_remote_identity',502);
  return {...u,id:u.id.toLowerCase(),expiryMs:Number(u.expiryMs)||0,trafficLimit:u.trafficLimit??(u.limitTotalReq||0)/6000,dailyLimit:u.dailyLimit??(u.limitDailyReq||0)/6000};
}
async function baseConfigs(r,node,user) {
  if(node.local)return panelBases(user,await setting(r,'panel'),node.base_url);
  if(node.adapter==='nexiup') {
    // Authenticated retrieval also works when a retained-usage renewal is still capped.
    // Public subscriptions correctly reject inactive accounts, but the hub must be able
    // to snapshot an already-created identity without recreating or resetting it.
    const response=await nodeRequest(r,node,'GET',user.id,null,'configs');
    const bases=response.bases;if(!Array.isArray(bases)||!bases.length||bases.length>4)fail('invalid_node_configs');
    return bases.map(b=>{const parsed=parseBaseUri(baseUri(b));if(parsed.id!==user.id)fail('node_identity_mismatch');return parsed;});
  }
  const url=`${node.base_url}/${node.api_route}?sub=${encodeURIComponent(user.name)}&flag=base64`;
  const res=await r.fetch(url);if(!res.ok)fail('node_configs_unavailable',502);
  let text=await res.text();if(!/^(vless|trojan):\/\//.test(text.trim())){try{text=decodeBase64Utf8(text);}catch{fail('invalid_node_configs');}}
  const out=[],seen=new Set();
  for(const line of text.split(/\r?\n/).filter(Boolean).slice(0,100)) {
    // Stock Nahan emits fake usage/expiry entries with a zero identity. Drop only those.
    if(line.includes('00000000-0000-0000-0000-000000000000@127.0.0.1'))continue;
    const b=parseBaseUri(line);if(b.id!==user.id)fail('node_identity_mismatch');
    const key=JSON.stringify(b);if(!seen.has(key)){seen.add(key);out.push(b);}
  }
  if(!out.length||out.length>4)fail('stock_node_config_count_adjust_maxConfigs',422);
  return out;
}
async function requestTest(r,userId,key) {
  const test=await setting(r,'test',true);const bot=await setting(r,'bot');httpsOrigin(bot.main_url);
  if(!test.enabled)fail('tests_disabled');
  const node=await r.first('SELECT * FROM nx_nodes WHERE id=? AND enabled=1',test.node_id);
  if(!node)fail('designate_test_node_first');
  if(node.purpose!=='test'&&!test.allow_sales_node)fail('sales_node_not_explicitly_allowed_for_tests');
  const id='t'+ident(key,24),name=`test_${userId}_${randomId(10)}`;
  const p={plan:{days:test.days,total_gb:test.traffic_gb,daily_gb:test.daily_gb,conn_limit:1,max_configs:4,reset_usage:false},cooldown_hours:test.cooldown_hours,node_id:node.id,location:node.code,purpose:node.purpose};
  const res=await r.batch([
    [`INSERT INTO nx_test_slots(user_id,op_id,next_at) VALUES(?,?,0) ON CONFLICT(user_id) DO UPDATE SET op_id=excluded.op_id WHERE nx_test_slots.op_id IS NULL AND nx_test_slots.next_at<=? RETURNING op_id`,userId,id,now()],
    [`INSERT OR IGNORE INTO nx_ops(id,kind,user_id,node_id,name,payload,state,created_at) SELECT ?,?,?,?,?,?,'queued',? FROM nx_test_slots WHERE user_id=? AND op_id=?`,id,'test',userId,node.id,name,JSON.stringify(p),now(),userId,id],
    [`INSERT OR IGNORE INTO nx_test_grants(op_id,user_id,node_id,status,created_at) SELECT ?,?,?,'queued',? FROM nx_test_slots WHERE user_id=? AND op_id=?`,id,userId,node.id,now(),userId,id]
  ]);
  if(!res[0].results?.length){const slot=await r.first('SELECT * FROM nx_test_slots WHERE user_id=?',userId);if(slot?.op_id)return {id:slot.op_id,pending:true};throw new Fault('test_cooldown',429,Math.max(1,Math.ceil((slot.next_at-now())/1000)));}
  return {id,pending:true};
}
async function resetTestCooldown(r,actor,userId) {
  await r.batch([
    ['INSERT INTO nx_test_slots(user_id,next_at) VALUES(?,0) ON CONFLICT(user_id) DO UPDATE SET next_at=0',userId],
    auditStmt(actor,'test_cooldown_reset',userId,{does_not_clear_pending_request:true})
  ]);
}
async function approveOrder(r,actor,orderId) {
  if(!await isAdmin(r,actor))fail('admin_required',403);
  const order=await r.first('SELECT * FROM nx_orders WHERE id=?',orderId);if(!order)fail('order_not_found',404);
  if(order.status!=='pending')return {status:order.status};
  if(!order.receipt&&order.wallet_paid<order.total)fail('receipt_required');
  if(order.kind==='topup') {
    const bot=await setting(r,'bot');const credit=order.total+Math.floor(order.total*bot.topup_bonus_percent/100);
    await r.batch([
      [`INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) SELECT ?,user_id,?,'topup',id,? FROM nx_orders WHERE id=? AND kind='topup' AND status='pending'`,'topup:'+orderId,credit,now(),orderId],
      [`UPDATE nx_orders SET status='done' WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM nx_ledger WHERE key=?)`,orderId,'topup:'+orderId],
      auditStmt(actor,'topup_approved',orderId,{credit})
    ]);
    await enqueue(r,'topup-done:'+orderId,order.user_id,'text',{text:`✅ ${credit} — شارژ کیف پول / Wallet credited`});return {status:'done'};
  }
  const id='o'+orderId,p=parse(order.snapshot);
  await r.batch([
    [`INSERT OR IGNORE INTO nx_ops(id,kind,user_id,order_id,name,payload,state,sub_id,created_at) SELECT ?,?,user_id,id,?,?,'queued',renewal_id,? FROM nx_orders WHERE id=? AND status='pending'`,id,order.renewal_id?'renew':'sale',`sale_${order.user_id}_${randomId(10)}`,JSON.stringify({plan:p,location:order.location,purpose:'sales'}),now(),orderId],
    [`UPDATE nx_orders SET status='processing' WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM nx_ops WHERE id=?)`,orderId,id],
    auditStmt(actor,'order_approved',orderId,{provisioning:'queued'})
  ]);
  return {status:'processing',id};
}
async function finishOrder(r,orderId,status,reason,actor) {
  if(!['rejected','cancelled'].includes(status))fail('invalid_order_state');
  string(reason,500);
  const order=await r.first('SELECT * FROM nx_orders WHERE id=?',orderId);if(!order)fail('order_not_found');
  const isOwner=order.user_id===actor;
  if(status==='rejected'&&!await isAdmin(r,actor))fail('admin_required',403);
  if(status==='cancelled'&&!isOwner&&actor!=='cron'&&!await isAdmin(r,actor))fail('forbidden',403);
  const allowed=status==='cancelled'?['pending_payment']:['pending_payment','pending'];
  if(!allowed.includes(order.status))return false;
  const statusClause=status==='cancelled'?"status='pending_payment'":"status IN ('pending_payment','pending')";
  const decision=await r.batch([
    [`UPDATE nx_orders SET status=?,reason=? WHERE id=? AND ${statusClause}`,status,reason,orderId],
    [`INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) SELECT ?,user_id,wallet_paid,'refund',id,? FROM nx_orders WHERE id=? AND status=? AND wallet_paid>0`,'refund:'+orderId,now(),orderId,status],
    auditStmt(actor,'order_'+status,orderId,{reason_recorded:true})
  ]);
  if(!changes(decision[0]))return false;
  await enqueue(r,'order-'+status+':'+orderId,order.user_id,'text',{notice:status==='rejected'?'rejected':'',text:`${status==='rejected'?'❌':'⏰'} ${orderId}\n${reason}\nبخش کیف پول برگشت داده شد؛ واریز بانکی نیاز به پیگیری دارد. / Wallet portion refunded; bank-transfer refunds require support.`});return true;
}
async function walletPay(r,userId,orderId,split=false) {
  const rows=await r.batch([
    [`INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) SELECT ?,o.user_id,-MIN(u.balance,o.total),'purchase',o.id,? FROM nx_orders o JOIN nx_users u ON u.id=o.user_id WHERE o.id=? AND o.user_id=? AND o.kind='sale' AND o.status='pending_payment' AND u.balance>0 AND (?=1 OR u.balance>=o.total)`,'purchase:'+orderId,now(),orderId,userId,+split],
    [`UPDATE nx_orders SET wallet_paid=COALESCE((SELECT -amount FROM nx_ledger WHERE key=?),0),status=CASE WHEN COALESCE((SELECT -amount FROM nx_ledger WHERE key=?),0)>=total THEN 'pending' ELSE 'pending_payment' END WHERE id=? AND user_id=? AND status='pending_payment'`,'purchase:'+orderId,'purchase:'+orderId,orderId,userId]
  ]);
  const order=await r.first('SELECT * FROM nx_orders WHERE id=? AND user_id=?',orderId,userId);
  if(!order)fail('order_not_found');if(!order.wallet_paid && order.total>0)fail('insufficient_balance');
  if(order.status==='pending')await notifyAdmins(r,'review:'+orderId,`💳 ${orderId} — پرداخت کیف پول / Wallet payment`,[{label:'بررسی / Review',action:'review',id:orderId}]);
  return order;
}
async function submitReceipt(r,userId,orderId,receipt) {
  keys(receipt,['type','file_id','note']);if(!['photo','document','text'].includes(receipt.type))fail('invalid_receipt');
  string(receipt.file_id,300);string(receipt.note,500);
  if(!receipt.file_id&&!receipt.note)fail('receipt_required');
  await rate(r,'receipt:'+userId,15000);
  const row=await r.first(`UPDATE nx_orders SET receipt=?,status='pending' WHERE id=? AND user_id=? AND status='pending_payment' RETURNING *`,JSON.stringify(receipt),orderId,userId);
  if(!row)return {duplicate:true};
  const admins=await adminIds(r);
  for(const id of admins)await enqueue(r,`receipt:${orderId}:${id}`,id,'receipt',{order_id:orderId});
  return {duplicate:false};
}
function renewalExpiry(expiry,days,at=now()) {const target=Math.max(Number(expiry)||0,at)+days*DAY;return {target,expiryDays:Math.ceil((target-at)/DAY)};}
async function markOpFailure(r,op,code,ambiguous=false) {
  const state=ambiguous?'reconcile':'failed';
  const items=[['UPDATE nx_ops SET state=?,error=?,retry_at=? WHERE id=?',state,code,now()+60000,op.id]];
  if(op.kind==='test'){
    items.push(['UPDATE nx_test_grants SET status=?,error=? WHERE op_id=?',state,code,op.id]);
    if(!ambiguous)items.push(['UPDATE nx_test_slots SET op_id=NULL WHERE user_id=? AND op_id=?',op.user_id,op.id]);
  }
  items.push(auditStmt('system','provision_'+state,op.id,{code}));await r.batch(items);
  await enqueue(r,'op-error:'+op.id+':'+state,op.user_id,'text',{text:ambiguous?'⏳ نتیجه نود مبهم است؛ برای جلوگیری از اشتراک تکراری در حال بررسی است. / Node result uncertain; reconciling without creating duplicates.':'⚠️ صدور انجام نشد؛ پرداخت محفوظ است و مدیر می‌تواند دوباره تلاش کند. / Provisioning failed; payment is retained for recovery.'});
  if(r.queries<34)await notifyAdmins(r,'op-admin:'+op.id+':'+state,`⚠️ ${op.id}: ${code}\nNo credentials logged. Retry/reconcile in Operations.`,[{label:'عملیات / Operations',action:'ops',id:'0'}]);
}
async function finalizeOp(r,op,user,bases) {
  const p=parse(op.payload),plan=p.plan,subId=op.sub_id||randomId(8);
  const limits={total_gb:plan.total_gb,daily_gb:plan.daily_gb,days:plan.days,conn_limit:plan.conn_limit,plan_id:plan.id||null,test:op.kind==='test',reset_usage:!!plan.reset_usage};
  const expiry=user.expiryMs;if(!expiry)fail('remote_expiry_missing',502);
  const items=[
    ['INSERT INTO nx_subs(id,token,user_id,op_id,node_id,remote_id,name,limits,bases,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET limits=excluded.limits,bases=excluded.bases,status=excluded.status,expires_at=excluded.expires_at,reminded=0',subId,randomId(16),op.user_id,op.id,op.node_id,user.id,user.name,JSON.stringify(limits),JSON.stringify(bases),'active',expiry,now()],
    ['UPDATE nx_ops SET state=?,phase=?,remote_id=?,sub_id=?,error=NULL WHERE id=?','done','done',user.id,subId,op.id],
    ['INSERT OR IGNORE INTO nx_jobs(id,user_id,kind,data,due,created_at) VALUES(?,?,?,?,?,?)','deliver:'+op.id,op.user_id,'subscription',JSON.stringify({sub_id:subId}),now(),now()]
  ];
  if(op.kind==='test'){
    items.push(['UPDATE nx_test_slots SET op_id=NULL,next_at=?,last_success=? WHERE user_id=? AND op_id=?',now()+p.cooldown_hours*3600000,now(),op.user_id,op.id]);
    items.push(['UPDATE nx_test_grants SET status=?,granted_at=?,expires_at=?,error=NULL WHERE op_id=?','granted',now(),expiry,op.id]);
  }
  if(op.order_id){
    items.push(['UPDATE nx_orders SET status=? WHERE id=? AND status=?','done',op.order_id,'processing']);
    const bot=await setting(r,'bot');
    items.push([`INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) SELECT ?,u.referrer,CAST(o.total*?/100 AS INTEGER),'referral',o.id,? FROM nx_orders o JOIN nx_users u ON u.id=o.user_id JOIN nx_users referrer ON referrer.id=u.referrer WHERE o.id=? AND o.status='done' AND u.referrer<>u.id AND CAST(o.total*?/100 AS INTEGER)>0`,'referral:'+op.order_id,bot.referral_percent,now(),op.order_id,bot.referral_percent]);
  }
  items.push(auditStmt('system','provision_done',op.id,{sub_id:subId,node_id:op.node_id,reset_usage:!!plan.reset_usage}));
  await r.batch(items);return subId;
}
async function nodeLease(r,node,opId='') {
  if(node.adapter==='nahan'){
    const uncertain=await r.first("SELECT id FROM nx_ops WHERE node_id=? AND id<>? AND (state='reconcile' OR (state='creating' AND phase='create_sent')) LIMIT 1",node.id,opId);
    if(uncertain)throw new Fault('node_quarantined',409,60);
  }
  return lock(r,'node:'+node.id,node.adapter==='nahan'?11000:0);
}
async function processOp(r,id) {
  const release=await lock(r,'op:'+id);let nodeRelease=null,op;
  try {
    op=await r.first('SELECT * FROM nx_ops WHERE id=?',id);if(!op||op.state==='done')return op;
    const p=parse(op.payload);let node=op.node_id?await r.first('SELECT * FROM nx_nodes WHERE id=?',op.node_id):null;
    if(op.kind==='renew')return await processRenewal(r,op,p);
    let user=null;
    if(op.phase==='create_sent'||op.phase==='remote_ready'||op.state==='reconcile') {
      if(!node)fail('pinned_node_missing',503);
      nodeRelease=await nodeLease(r,node,id);
      try{user=normalizeRemoteUser((await nodeRequest(r,node,'GET',op.remote_id||op.name)).user);}
      catch(e){
        if(e.status===404&&node.adapter==='nexiup'&&op.state!=='failed') {
          // Own node has a durable unique create_key/name; safe retry of the same identity.
          user=normalizeRemoteUser((await nodeRequest(r,node,'POST','',userPayload(op.name,p.plan),'',op.id)).user);
        } else if(e.status===404&&node.adapter==='nahan') {await r.run('UPDATE nx_ops SET state=?,error=?,retry_at=? WHERE id=?','reconcile','stock_result_not_proven_absent',now()+60000,id);return {state:'reconcile'};}
        else throw e;
      }
    } else {
      const candidates=op.kind==='test'?(node&&node.enabled?[node]:[]):await eligibleNodes(r,p.location,p.purpose);
      if(!candidates.length)fail('no_matching_capacity',503);
      let last='no_matching_capacity';
      // At most two candidates per invocation. Never fail over after an ambiguous mutation.
      for(const n of candidates.slice(0,2)) {
        try {
          nodeRelease=await nodeLease(r,n,id);node=n;
          try{user=normalizeRemoteUser((await nodeRequest(r,n,'GET',op.name)).user);}catch(e){if(e.status!==404)throw e;}
          if(!user){
            const info=await nodeRequest(r,n);if(!Number.isSafeInteger(Number(info.total)))fail('node_capacity_unknown',502);if(Number(info.total)>=n.max_users)fail('node_full',409);n.provisioningLoad=Number(info.total)+1;
            // Persist target and intent BEFORE the irreversible network operation.
            await r.run('UPDATE nx_ops SET node_id=?,phase=?,state=?,error=NULL WHERE id=?',n.id,'create_sent','creating',id);
            op.node_id=n.id;op.phase='create_sent';
            user=normalizeRemoteUser((await nodeRequest(r,n,'POST','',userPayload(op.name,p.plan),'',op.id)).user);
          }
          op.node_id=n.id;
          if(user.name!==op.name)fail('node_name_mismatch',502);
          break;
        } catch(e) {
          last=codeOf(e);
          if(op.phase==='create_sent' && !/^node_rejected_(400|401|403|422)$/.test(last))throw e;
          if(nodeRelease){await nodeRelease();nodeRelease=null;}
          if(['busy','node_quarantined'].includes(last))continue;
          op.phase='new';op.node_id=null;
          await r.run('UPDATE nx_ops SET phase=?,node_id=NULL,state=? WHERE id=?','new','queued',id);
        }
      }
      if(!user)throw new Fault(last,503);
    }
    await r.run('UPDATE nx_ops SET remote_id=?,node_id=?,phase=?,state=? WHERE id=?',user.id,node.id,'remote_ready','ready',id);
    op.remote_id=user.id;op.node_id=node.id;op.phase='remote_ready';
    // Saved independently from account creation: configuration retrieval failure never recreates it.
    const bases=await baseConfigs(r,node,user);
    const subId=await finalizeOp(r,op,user,bases);
    if(r.queries<32){
      const count=Math.max(node.provisioningLoad||0,(await r.first('SELECT COUNT(*) AS n FROM nx_subs WHERE node_id=? AND status=? AND expires_at>?',node.id,'active',now())).n);
      if(count/node.max_users>=0.8)await notifyAdmins(r,'capacity:'+node.id+':'+dayKey(),`⚠️ ${node.label}: ${count}/${node.max_users} (≥80%)`);
    }
    return {state:'done',sub_id:subId};
  } catch(e) {
    if(!op)throw e;
    const code=codeOf(e);
    if(['busy','node_quarantined','query_budget','fetch_budget'].includes(code)) {if(r.queries<42)await r.run('UPDATE nx_ops SET retry_at=? WHERE id=?',now()+15000,id);return {state:'queued'};}
    if(op.phase==='remote_ready') {await r.run('UPDATE nx_ops SET state=?,error=?,retry_at=? WHERE id=?','ready',code,now()+60000,id);return {state:'ready'};}
    await markOpFailure(r,op,code,op.phase==='create_sent'||code==='node_result_ambiguous');return {state:'failed',code};
  } finally {
    if(nodeRelease)await nodeRelease();await release();
  }
}
async function processRenewal(r,op,p) {
  const sub=await r.first('SELECT * FROM nx_subs WHERE id=? AND user_id=?',op.sub_id,op.user_id);if(!sub)fail('renewal_subscription_missing');
  const node=await r.first('SELECT * FROM nx_nodes WHERE id=?',sub.node_id);if(!node)fail('pinned_node_missing');
  const release=await nodeLease(r,node,op.id);
  try {
    let user=normalizeRemoteUser((await nodeRequest(r,node,'GET',sub.remote_id)).user);
    const marker=`[nx:${op.id}]`;
    if(!p.target_expiry){p.target_expiry=renewalExpiry(user.expiryMs,p.plan.days).target;await r.run('UPDATE nx_ops SET payload=?,node_id=? WHERE id=?',JSON.stringify(p),node.id,op.id);op.payload=JSON.stringify(p);op.node_id=node.id;}
    if(!(user.notes||'').includes(marker)) {
      const remaining=Math.max(1,Math.ceil((p.target_expiry-now())/DAY));
      const payload={trafficLimit:p.plan.total_gb,dailyLimit:p.plan.daily_gb,connLimit:p.plan.conn_limit,maxConfigs:p.plan.max_configs,isPaused:false,notes:((user.notes||'').replace(/\[nx:[^\]]+\]/g,'').slice(0,400)+' '+marker).trim(),...(node.adapter==='nexiup'?{expiryMs:p.target_expiry}:{expiryDays:remaining})};
      // Stock Nahan doesn't support isPaused on PUT: explicitly toggle after reading if needed.
      if(node.adapter==='nahan')delete payload.isPaused;
      await r.run('UPDATE nx_ops SET phase=? WHERE id=?','renew_sent',op.id);op.phase='renew_sent';
      await nodeRequest(r,node,'PUT',user.id,payload,'',op.id+':renew');
      user=normalizeRemoteUser((await nodeRequest(r,node,'GET',user.id)).user);
      // Stock isolates may return a stale config: wait for another invocation instead of resetting twice.
      if(!(user.notes||'').includes(marker)) {await r.run('UPDATE nx_ops SET retry_at=?,state=? WHERE id=?',now()+12000,'queued',op.id);return {state:'queued'};}
    }
    if(user.isPaused&&node.adapter==='nahan') {
      await nodeRequest(r,node,'POST',user.id,null,'toggle',op.id+':unpause');
      await r.run('UPDATE nx_ops SET retry_at=?,state=? WHERE id=?',now()+12000,'queued',op.id);return {state:'queued'};
    }
    if(p.plan.reset_usage && op.phase!=='reset_done') {
      if(op.phase==='reset_sent'&&node.adapter==='nahan') {await r.run('UPDATE nx_ops SET state=?,error=? WHERE id=?','reconcile','stock_reset_outcome_requires_admin',op.id);return {state:'reconcile'};}
      await r.run('UPDATE nx_ops SET phase=? WHERE id=?','reset_sent',op.id);op.phase='reset_sent';
      await nodeRequest(r,node,'POST',user.id,null,'reset',op.id+':reset');
      await r.run('UPDATE nx_ops SET phase=? WHERE id=?','reset_done',op.id);op.phase='reset_done';
    }
    const bases=await baseConfigs(r,node,user);op.node_id=node.id;
    await finalizeOp(r,op,user,bases);return {state:'done',sub_id:sub.id};
  } catch(e){if(e.code==='node_result_ambiguous') {await r.run('UPDATE nx_ops SET state=?,error=?,retry_at=? WHERE id=?','reconcile','renewal_result_ambiguous',now()+60000,op.id);return {state:'reconcile'};}throw e;}
  finally{await release();}
}

// ---------------- Typed, editable administration (Telegram and panel) ----------------
function validateBotSettings(x) {
  keys(x,Object.keys(DEFAULT_SETTINGS));
  if(x.main_url)x.main_url=httpsOrigin(x.main_url);
  string(x.support,200);string(x.currency,30,1);bool(x.maintenance);string(x.announcement,800);
  number(x.order_hours,1,168,true);number(x.referral_percent,0,100);number(x.first_discount_percent,0,100);number(x.topup_bonus_percent,0,100);
  number(x.min_topup,1,1e12,true);number(x.min_withdrawal,1,1e12,true);number(x.max_pending,1,5,true);number(x.daily_report_hour,0,23,true);
  for(const k of ['terms_fa','terms_en','guides_fa','guides_en'])string(x[k],2000,1);
  if(x.bot_username&&!/^[A-Za-z0-9_]{5,32}$/.test(x.bot_username))fail('invalid_bot_username');
  return copy(x);
}
function validateTestSettings(x) {
  keys(x,Object.keys(DEFAULT_TEST));bool(x.enabled);bool(x.allow_sales_node);
  number(x.traffic_gb,0.01,1000);number(x.daily_gb,0.01,1000);number(x.days,1,30,true);number(x.cooldown_hours,1,8760,true);
  if(x.node_id)ident(x.node_id,24);if(x.enabled&&!x.node_id)fail('designate_test_node_first');return copy(x);
}
function validateCatalog(kind,x) {
  if(kind==='plans')return validatePlan(x);
  const common=['id','enabled'];
  if(kind==='payments'){keys(x,[...common,'name','details','instructions']);ident(x.id,24);bool(x.enabled);string(x.name,100,1);string(x.details,1000,1);string(x.instructions,600);}
  else if(kind==='guides'){keys(x,[...common,'title','title_en','text','text_en']);ident(x.id,24);bool(x.enabled);string(x.title,100,1);string(x.title_en,100,1);string(x.text,3000,1);string(x.text_en,3000,1);}
  else if(kind==='coupons'){
    keys(x,[...common,'type','value','max_uses','per_user','minimum','expires_at']);ident(x.id,24);bool(x.enabled);
    if(!['percent','fixed'].includes(x.type))fail('invalid_coupon_type');number(x.value,0,x.type==='percent'?100:1e12,true);number(x.max_uses,0,1e6,true);number(x.per_user,1,100,true);number(x.minimum,0,1e12,true);number(x.expires_at,0,now()+3650*DAY,true);
  }else if(kind==='channels'){
    keys(x,[...common,'title','chat_id','invite_url']);ident(x.id,24);bool(x.enabled);string(x.title,100,1);
    if(!/^(@[A-Za-z0-9_]{5,32}|-100\d{5,16})$/.test(x.chat_id))fail('invalid_channel');
    const u=new URL(httpsUrl(x.invite_url));if(u.hostname!=='t.me')fail('telegram_invite_required');
  }else if(kind==='texts'){
    keys(x,[...common,'fa','en']);if(!['welcome','main','support','payment','test','approved','rejected'].includes(x.id))fail('unknown_text_key');bool(x.enabled);string(x.fa,1000);string(x.en,1000);
  }else fail('unknown_catalog');
  return copy(x);
}
async function catalog(r,kind,enabled=true,cursor='',limit=8) {
  return (await r.all(`SELECT id,data,version FROM nx_catalog WHERE kind=? AND (?=0 OR enabled=1) AND id>? ORDER BY id LIMIT ?`,kind,+enabled,cursor,limit)).map(row=>({...parse(row.data),version:row.version}));
}
async function catalogItem(r,kind,id) {const row=await r.first('SELECT * FROM nx_catalog WHERE kind=? AND id=?',kind,id);return row?{...parse(row.data),version:row.version}:null;}
async function saveCatalog(r,actor,kind,doc,version) {
  const p=validateCatalog(kind,doc);
  if(kind==='channels'&&p.enabled){const n=(await r.first("SELECT COUNT(*) AS n FROM nx_catalog WHERE kind='channels' AND enabled=1 AND id<>?",p.id)).n;if(n>=3)fail('max_three_forced_channels');}
  const result=await r.batch([
    ['INSERT INTO nx_catalog(kind,id,data,enabled,version) VALUES(?,?,?,?,1) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,enabled=excluded.enabled,version=nx_catalog.version+1 WHERE nx_catalog.version=?',kind,p.id,JSON.stringify(p),+p.enabled,version],
    auditStmt(actor,'catalog_saved',kind+':'+p.id,{fields:Object.keys(p),validation:'passed',version})
  ]);
  if(!changes(result[0]))fail('version_conflict',409);
}
async function editableDoc(r,kind,id) {
  if(['bot','test','panel','proxy'].includes(kind))return {doc:await setting(r,kind,true),version:0};
  if(kind==='profiles'){const p=(await profiles(r,true)).find(p=>p.id===id);if(p){const {version,...doc}=p;return {doc,version};}return {doc:{...copy(DEFAULT_PROFILES[2]),id:id||'custom'},version:0};}
  if(kind==='nodes'){
    const n=await r.first('SELECT * FROM nx_nodes WHERE id=?',id);
    if(n){const {last_health_ok,created_at,...doc}=n;doc.enabled=!!doc.enabled;doc.local=!!doc.local;return {doc,version:0};}
    return {doc:{id:'',code:'',label:'',base_url:'',api_route:'sync',api_key_ref:'',max_users:10,enabled:false,purpose:'sales',adapter:'nexiup',local:false},version:0};
  }
  const existing=await catalogItem(r,kind,id);if(existing){const {version,...doc}=existing;return {doc,version};}
  const templates={
    plans:{id:'',name:'',description:'',days:30,daily_gb:1,total_gb:30,conn_limit:2,price:0,locations:['de','us'],enabled:false,reset_usage:false,max_configs:4},
    payments:{id:'',name:'',details:'',instructions:'',enabled:false},
    guides:{id:'',title:'',title_en:'',text:'',text_en:'',enabled:false},
    channels:{id:'',title:'',chat_id:'',invite_url:'',enabled:false},
    coupons:{id:'',type:'percent',value:0,max_uses:1,per_user:1,minimum:0,expires_at:0,enabled:false},
    texts:{id:'welcome',fa:'',en:'',enabled:true}
  };
  if(!templates[kind])fail('unknown_editor');return {doc:templates[kind],version:0};
}
async function validateEdit(r,kind,doc) {
  if(kind==='bot')return validateBotSettings(doc);
  if(kind==='panel')return validatePanel(doc);
  if(kind==='proxy')return validateProxySettings(doc);
  if(kind==='test'){
    const t=validateTestSettings(doc);if(t.enabled){const n=await r.first('SELECT * FROM nx_nodes WHERE id=? AND enabled=1',t.node_id);if(!n)fail('test_node_unavailable');if(n.purpose!=='test'&&!t.allow_sales_node)fail('sales_node_not_explicitly_allowed_for_tests');}return t;
  }
  if(kind==='profiles')return validateProfile(doc);
  if(kind==='nodes')return validateNode(doc);
  return validateCatalog(kind,doc);
}
async function applyEdit(r,actor,kind,doc,version) {
  const value=await validateEdit(r,kind,doc);
  if(['bot','test','panel','proxy'].includes(kind))return putSetting(r,kind,value,actor);
  if(kind==='profiles')return saveProfile(r,actor,value,version);
  if(kind==='nodes')return saveNode(r,value,actor);
  return saveCatalog(r,actor,kind,value,version);
}

// ---------------- ProxyIP catalog and bounded, explicit live diagnostics (original implementation) ----------------
const DEFAULT_PROXY = {
  source_url:'https://zip.cm.edu.kg.cmliussss.net/all.json', external_enabled:false,
  checker_url:'https://api.090227.xyz/check', checker_enabled:false,
  timeout_ms:5000, daily_test_limit:500
};
const PROXY_TRACE_HOST = 'www.cloudflare.com';
const PROXY_MAX_ENTRIES = 2000;
const PROXY_IMPORT_PAGE = 20;
function proxyEndpoint(value,defaultPort=443) {
  const raw=string(value,300,1).trim();let host,port=defaultPort,explicit=false;
  if(raw.startsWith('[')){
    const match=/^\[([a-fA-F0-9:]+)\](?::([0-9]{1,5}))?$/.exec(raw);if(!match)fail('invalid_proxy_endpoint');
    host=match[1];if(match[2]){port=Number(match[2]);explicit=true;}
  }else{
    const colons=(raw.match(/:/g)||[]).length;
    if(colons===1){const parts=raw.split(':');if(!/^[0-9]{1,5}$/.test(parts[1]))fail('invalid_proxy_endpoint');host=parts[0];port=Number(parts[1]);explicit=true;}
    else host=raw;
  }
  host=publicHost(host);
  // Normalize IPv6 before validating it; block mapped/expanded private forms too.
  if(host.includes(':'))host=new URL('https://['+host+']').hostname.slice(1,-1);
  host=publicHost(host);
  if(/^[0-9.]+$/.test(host))host=host.split('.').map(Number).join('.');
  if(port!==null){number(port,1,65535,true);if(port===25)fail('destination_port_denied');}
  return {host,port,explicit,endpoint:hostPort(host)+(port===null?'':':'+port)};
}
function listProxyEndpoints(value,max=4) {
  if(typeof value==='string')value=value.split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
  if(!Array.isArray(value)||value.length>max)fail('too_many_proxy_endpoints');
  // Legacy bare hosts keep the destination port; explicit endpoints use their configured port.
  return [...new Set(value.map(v=>proxyEndpoint(v,null).endpoint))];
}
function validateProxySettings(p) {
  keys(p,Object.keys(DEFAULT_PROXY));
  for(const field of ['source_url','checker_url']){
    p[field]=httpsUrl(string(p[field],500,1));
    const u=new URL(p[field]);if(u.search||u.hash||(u.port&&u.port!=='443'))fail('public_https_url_without_query_required');
  }
  bool(p.external_enabled);bool(p.checker_enabled);
  number(p.timeout_ms,2000,8000,true);number(p.daily_test_limit,1,5000,true);
  return copy(p);
}
function proxySourceRows(input) {
  if(typeof input==='string'){
    const s=input.trim();
    if(s.startsWith('[')||s.startsWith('{')){input=parse(s);if(!input)fail('invalid_catalog_json');}
    else{
      const lines=s.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
      if(lines[0]&&/^(country|country_code)[,\t]/i.test(lines[0]))lines.shift();
      input=lines.map(line=>{const [country,endpoint,label='']=line.split(/[,\t]/);return {country,endpoint,label};});
    }
  }
  const rows=Array.isArray(input)?input:input?.data||input?.proxies;
  if(!Array.isArray(rows)||!rows.length)fail('empty_or_unsupported_catalog');
  return rows;
}
function normalizeProxyRecord(row) {
  if(!isObject(row))fail('invalid_proxy_record');
  const address=row.endpoint||row.proxy||row.ip||row.host;
  if(typeof address!=='string')fail('proxy_address_required');
  let port=443;
  if(row.port!==undefined){
    if(Array.isArray(row.port)){if(!row.port.includes(443))fail('catalog_no_tls_443');}
    else port=number(Number(row.port),1,65535,true);
  }
  const ep=proxyEndpoint(address,port),meta=isObject(row.meta)?row.meta:{};
  const claimed=String(row.country_code||row.country||meta.country||'ZZ').toUpperCase();
  const country=/^[A-Z]{2}$/.test(claimed)?claimed:'ZZ';
  const label=String(row.label||meta.asOrganization||row.asOrganization||'').replace(/[\x00-\x1f]/g,'').slice(0,100);
  const city=String(row.city||meta.city||'').replace(/[\x00-\x1f]/g,'').slice(0,80);
  // Provider clientIp, colo and lat/lon are NOT promoted to independently measured exit evidence.
  return {id:ep.endpoint,host:ep.host,port:ep.port,country,label,city};
}
async function startProxyImport(r,input,source) {
  const rows=proxySourceRows(input),taken=rows.slice(0,PROXY_MAX_ENTRIES),id=randomId(12),created=now();
  const text=JSON.stringify(taken);if(enc.encode(text).length>1024*1024)fail('catalog_too_large',413);
  await r.batch([
    ['DELETE FROM nx_proxy_imports WHERE expires_at<=?',created],
    ['DELETE FROM nx_proxy_imports WHERE id IN (SELECT id FROM nx_proxy_imports ORDER BY created_at DESC LIMIT -1 OFFSET 3)'],
    ['INSERT INTO nx_proxy_imports(id,source,data,total,original_total,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',id,source,text,taken.length,rows.length,created,created+3600000],
    auditStmt(WEB_ACTOR,'proxy_import_started',id,{source:source==='manual'?'manual':'configured_url',rows:taken.length,truncated:rows.length>taken.length})
  ]);
  return {id,total:taken.length,original_total:rows.length,cursor:0,imported:0,rejected:0,state:'pending',truncated:rows.length>taken.length};
}
async function advanceProxyImport(r,id,expectedCursor) {
  ident(id,48);number(expectedCursor,0,PROXY_MAX_ENTRIES,true);
  const release=await lock(r,'proxy:catalog-import');
  try{
    const job=await r.first('SELECT * FROM nx_proxy_imports WHERE id=? AND expires_at>?',id,now());
    if(!job)fail('import_expired_or_missing',404);
    if(job.cursor!==expectedCursor||job.state!=='pending')return {id,cursor:job.cursor,total:job.total,original_total:job.original_total,imported:job.imported,rejected:job.rejected,state:job.state};
    const input=parse(job.data,[]).slice(job.cursor,job.cursor+PROXY_IMPORT_PAGE),rows=[],errors={};
    for(const raw of input){try{rows.push(normalizeProxyRecord(raw));}catch(e){const code=codeOf(e);errors[code]=(errors[code]||0)+1;}}
    const count=(await r.first('SELECT COUNT(*) AS n FROM nx_proxy_catalog')).n;
    const existing=new Set((await r.all('SELECT id FROM nx_proxy_catalog WHERE id IN (SELECT value FROM json_each(?))',JSON.stringify(rows.map(row=>row.id)))).map(row=>row.id));
    let space=Math.max(0,PROXY_MAX_ENTRIES-count);
    const admitted=[];for(const row of new Map(rows.map(row=>[row.id,row])).values()){
      if(existing.has(row.id)||space>0){admitted.push(row);if(!existing.has(row.id))space--;}
      else errors.catalog_capacity=(errors.catalog_capacity||0)+1;
    }
    const at=now(),cursor=job.cursor+input.length,state=cursor>=job.total?'done':'pending',imported=admitted.length;
    const result=await r.batch([
      [`INSERT INTO nx_proxy_catalog(id,host,port,country,label,city,source,imported_at)
        SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.host'),json_extract(j.value,'$.port'),json_extract(j.value,'$.country'),json_extract(j.value,'$.label'),json_extract(j.value,'$.city'),?,?
        FROM json_each(?) j WHERE 1
        ON CONFLICT(id) DO UPDATE SET country=excluded.country,label=excluded.label,city=excluded.city,source=excluded.source,imported_at=excluded.imported_at`,job.source,at,JSON.stringify(admitted)],
      ["UPDATE nx_proxy_imports SET cursor=?,state=CASE WHEN state='pending' THEN ? ELSE state END,imported=imported+?,rejected=rejected+? WHERE id=? AND cursor=?",cursor,state,imported,input.length-imported,id,job.cursor]
    ]);
    const current=await r.first('SELECT id,cursor,total,original_total,imported,rejected,state FROM nx_proxy_imports WHERE id=?',id);
    if(!current)fail('import_expired_or_missing',404);
    if(!changes(result[1])||current.state!==state)return current;
    if(state==='done')await audit(r,WEB_ACTOR,'proxy_import_finished',id,{imported:job.imported+imported,rejected:job.rejected+input.length-imported});
    return {id,cursor,total:job.total,original_total:job.original_total,imported:job.imported+imported,rejected:job.rejected+input.length-imported,state,errors,truncated:job.original_total>job.total};
  }finally{await release();}
}
async function spendProxyBudget(r,settings) {
  const row=await r.first('INSERT INTO nx_proxy_budgets(day,tests) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET tests=tests+1 WHERE tests<? RETURNING tests',dayKey(),settings.daily_test_limit);
  if(!row)throw new Fault('proxy_daily_test_budget',429,Math.ceil((DAY-now()%DAY)/1000));
  if(row.tests===1)await r.run('DELETE FROM nx_proxy_budgets WHERE day<?',new Date(now()-7*DAY).toISOString().slice(0,10));
  return settings.daily_test_limit-row.tests;
}
function parseProxyTrace(bytes) {
  const text=dec.decode(bytes),split=text.indexOf('\r\n\r\n');
  if(split<0||split>8192)fail('proxy_invalid_http',502);
  const head=text.slice(0,split),lines=head.split('\r\n');
  if(!/^HTTP\/1\.[01] 200(?: |$)/.test(lines[0]))fail('proxy_trace_not_200',502);
  let body=text.slice(split+4);
  if(/\r\ncontent-encoding:\s*(?!identity\s*$)\S+/im.test('\r\n'+head))fail('proxy_encoded_response',502);
  if(/\r\ntransfer-encoding:\s*chunked\s*$/im.test('\r\n'+head)){
    let decoded='',offset=0,finished=false;
    for(let i=0;i<128;i++){
      const end=body.indexOf('\r\n',offset);if(end<0)fail('proxy_incomplete_chunk',502);
      const hex=body.slice(offset,end).split(';')[0];if(!/^[a-f0-9]{1,6}$/i.test(hex))fail('proxy_invalid_chunk',502);
      const length=parseInt(hex,16);offset=end+2;
      if(length===0){finished=true;break;}
      if(offset+length+2>body.length||body.slice(offset+length,offset+length+2)!=='\r\n')fail('proxy_incomplete_chunk',502);
      decoded+=body.slice(offset,offset+length);offset+=length+2;
    }
    if(!finished)fail('proxy_incomplete_chunk',502);body=decoded;
  }else{
    const match=/\r\ncontent-length:\s*(\d+)\s*$/im.exec('\r\n'+head);
    if(match&&Number(match[1])!==enc.encode(body).length)fail('proxy_incomplete_body',502);
  }
  const fields=Object.create(null);for(const line of body.split('\n')){const p=line.indexOf('=');if(p>0)fields[line.slice(0,p)]=line.slice(p+1).trim();}
  if(fields.h!==PROXY_TRACE_HOST || !/^[A-Z]{2}$/.test(fields.loc||'') || !/^[A-Z]{3}$/.test(fields.colo||''))fail('proxy_invalid_trace',502);
  const ip=string(fields.ip||'',64,1);
  if(!ip.includes(':')&&!/^\d+\.\d+\.\d+\.\d+$/.test(ip))fail('proxy_invalid_exit_ip',502);
  publicHost(ip);
  return {exit_ip:ip,exit_country:fields.loc,trace_colo:fields.colo};
}
async function localProxyProbe(endpoint,mode,timeout,fromColo='') {
  const ep=proxyEndpoint(endpoint),started=now(),deadline=started+timeout;
  if(!['tcp','relay'].includes(mode))fail('invalid_probe_mode');
  let socket=null,raw=null,reader=null,writer=null,stage='tcp';
  const result={mode,endpoint:ep.endpoint,tcp_ok:false,relay_ok:false,tcp_ms:null,tls_ms:null,total_ms:0,exit_ip:null,exit_country:null,trace_colo:null,from_colo:/^[A-Z]{3}$/.test(fromColo)?fromColo:null,evidence:'local',error:null,checked_at:started};
  const wait=p=>timed(p,Math.max(1,deadline-now()),()=>{closeSocket(socket);closeSocket(raw);});
  try{
    raw=connect({hostname:ep.host,port:ep.port},{secureTransport:mode==='relay'?'starttls':'off',allowHalfOpen:false});
    socket=raw;raw.closed?.catch(()=>{});await wait(raw.opened);
    result.tcp_ok=true;result.tcp_ms=now()-started;
    if(mode==='relay'){
      stage='tls';const tlsAt=now();
      // Native TLS validates the certificate for the diagnostic host, not for the relay IP.
      // Never disable certificate verification or send customer UUIDs/subscription URLs.
      socket=raw.startTls({expectedServerHostname:PROXY_TRACE_HOST});socket.closed?.catch(()=>{});
      await wait(socket.opened);result.tls_ms=now()-tlsAt;stage='trace';
      writer=socket.writable.getWriter();
      await wait(writer.write(enc.encode(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${PROXY_TRACE_HOST}\r\nUser-Agent: NexiUP-diagnostic\r\nAccept: text/plain\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`)));
      reader=socket.readable.getReader();const chunks=[];let length=0;
      for(;;){const part=await wait(reader.read());if(part.done)break;length+=part.value.length;if(length>16384)fail('proxy_response_too_large',502);chunks.push(part.value);}
      Object.assign(result,parseProxyTrace(concat(...chunks)));result.relay_ok=true;
    }
  }catch(e){result.error=e instanceof Fault?e.code:'proxy_'+stage+'_failed';}
  finally{try{reader?.releaseLock();writer?.releaseLock();}catch{}closeSocket(socket);if(raw!==socket)closeSocket(raw);result.total_ms=now()-started;}
  return result;
}
async function externalProxyProbe(r,endpoint,settings) {
  if(!settings.checker_enabled)fail('external_checker_opt_in_required',403);
  const ep=proxyEndpoint(endpoint),url=new URL(settings.checker_url),started=now();url.searchParams.set('proxyip',ep.endpoint);
  const base={mode:'external',endpoint:ep.endpoint,evidence:'third_party',checked_at:started,from_colo:null,tcp_ok:false,relay_ok:false,exit_ip:null,exit_country:null,reported_ok:false,reported_ms:null,error:null,total_ms:0};
  try{
    const res=await r.fetch(url.toString(),{headers:{Accept:'application/json'}},settings.timeout_ms,32768);
    const body=parse(await res.text());if(!res.ok||typeof body?.success!=='boolean')fail('checker_invalid_response',502);
    base.reported_ok=body.success;
    const ms=Number(body.responseTime);if(Number.isFinite(ms)&&ms>=0&&ms<120000)base.reported_ms=ms;
    if(!body.success)base.error='checker_reported_failure';
  }catch(e){base.error=e instanceof Fault?e.code:'checker_unavailable';}
  base.total_ms=now()-started;return base;
}
async function nodeProxyProbe(r,node,endpoint,mode) {
  if(node.adapter!=='nexiup')fail('remote_probe_requires_nexiup_2_1',422);
  const key=r.env[node.api_key_ref];if(!validNodeKey(node,key)||controlSecret(r.env,key))fail('node_api_key_missing_or_master',503);
  const res=await r.fetch(`${httpsOrigin(node.base_url)}/${ident(node.api_route,48)}/api/proxy-check`,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({endpoint,mode})},10000,32768);
  if(!res.ok)throw new Fault(res.status===404?'remote_probe_requires_nexiup_2_1':'node_probe_unavailable',502);
  const body=parse(await res.text()),p=body?.probe;
  if(body?.success!==true||!p||p.endpoint!==endpoint||p.mode!==mode||!['tcp','relay'].includes(mode)||p.evidence!=='local'||typeof p.tcp_ok!=='boolean'||typeof p.relay_ok!=='boolean')fail('invalid_node_probe',502);
  if(p.relay_ok && (mode!=='relay'||!p.tcp_ok||!/^[A-Z]{2}$/.test(p.exit_country||'')||!/^[A-Z]{3}$/.test(p.trace_colo||'')||!/^([0-9.]+|[a-fA-F0-9:]+)$/.test(p.exit_ip||'')))fail('invalid_node_probe',502);
  // Even authenticated remote results are parsed, bounded and clearly attributed to that node.
  return {mode,endpoint,evidence:'node:'+node.id,checked_at:now(),tcp_ok:p.tcp_ok,relay_ok:p.relay_ok,
    tcp_ms:p.tcp_ms===null?null:number(p.tcp_ms,0,120000),tls_ms:p.tls_ms===null?null:number(p.tls_ms,0,120000),total_ms:number(p.total_ms,0,120000),
    from_colo:/^[A-Z]{3}$/.test(p.from_colo||'')?p.from_colo:null,trace_colo:/^[A-Z]{3}$/.test(p.trace_colo||'')?p.trace_colo:null,
    exit_ip:p.relay_ok?publicHost(p.exit_ip):null,exit_country:p.relay_ok&&/^[A-Z]{2}$/.test(p.exit_country||'')?p.exit_country:null,
    error:p.error&&/^[a-z0-9_]{1,80}$/.test(p.error)?p.error:null};
}
async function proxyProbe(r,request,b) {
  keys(b,['id','mode','node_id']);const endpoint=proxyEndpoint(b.id).endpoint;
  const row=await r.first('SELECT id FROM nx_proxy_catalog WHERE id=?',endpoint);if(!row)fail('proxy_not_in_catalog',404);
  const settings=await setting(r,'proxy',true),mode=b.mode||'relay',nodeId=b.node_id||'';
  if(!['tcp','relay','external'].includes(mode))fail('invalid_probe_mode');
  let node=null;
  if(nodeId){webHub(r);node=await r.first('SELECT * FROM nx_nodes WHERE id=? AND enabled=1',ident(nodeId));if(!node)fail('node_unavailable',404);if(node.local)webNode(r);}
  if(mode==='external'&&!settings.checker_enabled)fail('external_checker_opt_in_required',403);
  if(mode==='external'&&nodeId)fail('external_checker_not_node_measurement');
  await rate(r,'proxy:probe:'+nodeId+':'+mode+':'+endpoint,30000);
  const remaining=await spendProxyBudget(r,settings);
  const probe=mode==='external'?await externalProxyProbe(r,endpoint,settings):node&&!node.local?await nodeProxyProbe(r,node,endpoint,mode):await localProxyProbe(endpoint,mode,settings.timeout_ms,request.cf?.colo||'');
  const state=mode==='external'?(probe.reported_ok?'reported_ok':'reported_failed'):probe.relay_ok?'relay_ok':mode==='tcp'&&probe.tcp_ok?'tcp_ok':probe.tcp_ok?'relay_failed':'tcp_failed';
  await r.batch([
    ['UPDATE nx_proxy_catalog SET probe=?,state=?,checked_at=?,exit_country=? WHERE id=?',JSON.stringify(probe),state,probe.checked_at,probe.exit_country||'',endpoint],
    auditStmt(WEB_ACTOR,'proxy_tested','probe',{mode,state,from:nodeId||'self'})
  ]);
  return {id:endpoint,probe,state,checked_at:probe.checked_at,exit_country:probe.exit_country||'',remaining};
}
async function proxyPolicy(r,target) {
  if(target==='self'){webNode(r);return {target,node:null};}
  webHub(r);if(!target.startsWith('node:'))fail('invalid_proxy_target');
  const node=await r.first('SELECT * FROM nx_nodes WHERE id=?',ident(target.slice(5)));
  if(!node)fail('node_not_found',404);
  if(node.local)fail('use_self_for_local_node');
  return {target,node};
}
async function applyProxyPolicy(r,b,rollback=false) {
  const {target}=await proxyPolicy(r,string(b.target,80,1));
  const release=await lock(r,'proxy-policy:'+target);
  try{
    const old=await r.first('SELECT * FROM nx_proxy_policies WHERE target=?',target);
    const version=old?.version||0;
    if(number(b.version,0,1e9,true)!==version)fail('version_conflict',409);
    let current=old?parse(old.endpoints,[]):[];
    if(target==='self')current=(await setting(r,'panel',true)).proxy_ips;
    let endpoints;
    if(rollback){
      if(!old||old.previous===null)fail('no_proxy_rollback',409);
      if(target==='self'&&JSON.stringify(current)!==old.endpoints)fail('proxy_changed_since_apply',409);
      endpoints=parse(old.previous,[]);
    }else{
      if(!Array.isArray(b.ids)||b.ids.length>4)fail('max_four_proxy_endpoints');
      endpoints=[...new Set(b.ids.map(id=>proxyEndpoint(id).endpoint))];
      for(const id of endpoints){
        const row=await r.first('SELECT * FROM nx_proxy_catalog WHERE id=?',id);if(!row)fail('proxy_not_in_catalog',404);
        const probe=parse(row.probe,{}),expected=target==='self'?'local':target;
        if(b.allow_unverified!==true && (row.state!=='relay_ok'||row.checked_at<now()-30*60000||probe.evidence!==expected))fail('fresh_target_relay_test_or_explicit_override_required',409);
      }
    }
    const at=now(),stmts=[
      ['INSERT INTO nx_proxy_policies(target,endpoints,previous,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(target) DO UPDATE SET endpoints=excluded.endpoints,previous=excluded.previous,version=version+1,updated_at=excluded.updated_at',target,JSON.stringify(endpoints),JSON.stringify(current),at],
      auditStmt(WEB_ACTOR,rollback?'proxy_rollback':'proxy_applied',target,{count:endpoints.length,version:version+1,unverified_override:b.allow_unverified===true,scope:target==='self'?'local_fallback':'new_accounts'})
    ];
    if(target==='self')stmts.push(["UPDATE nx_settings SET value=json_set(value,'$.proxy_ips',json(?)),version=version+1,updated_at=? WHERE key='panel'",JSON.stringify(endpoints),at]);
    await r.batch(stmts);if(target==='self')invalidate(r,'settings:panel');
    return {success:true,target,endpoints,version:version+1,scope:target==='self'?'local_fallback':'new_accounts',affects_existing_inheriting_accounts:target==='self',existing_per_user_overrides_changed:false};
  }finally{await release();}
}
async function proxyApi(r,request,url,path) {
  const method=request.method;
  if(path==='list'&&method==='GET'){
    const country=string(url.searchParams.get('country')||'',2),state=string(url.searchParams.get('state')||'',30),q=string(url.searchParams.get('q')||'',80),cursor=string(url.searchParams.get('cursor')||'',300);
    if(country&&!/^[A-Z]{2}$/.test(country))fail('invalid_country');
    const where="(?='' OR country=?) AND (?='' OR state=?) AND (id LIKE ? OR label LIKE ?)",args=[country,country,state,state,'%'+q+'%','%'+q+'%'];
    const rows=await r.all(`SELECT * FROM nx_proxy_catalog WHERE ${where} AND id>? ORDER BY id LIMIT 21`,...args,cursor);
    const total=(await r.first(`SELECT COUNT(*) AS n FROM nx_proxy_catalog WHERE ${where}`,...args)).n;
    const countries=await r.all('SELECT country,COUNT(*) AS count,SUM(state=\'relay_ok\') AS verified FROM nx_proxy_catalog GROUP BY country ORDER BY count DESC,country');
    const settings=await setting(r,'proxy'),budget=await r.first('SELECT tests FROM nx_proxy_budgets WHERE day=?',dayKey());
    const nodes=getRole(r.env)!=='node'?await r.all('SELECT id,label,local,adapter,enabled FROM nx_nodes ORDER BY id LIMIT 30'):[];
    const policies=await r.all('SELECT target,endpoints,version,updated_at,previous IS NOT NULL AS can_rollback FROM nx_proxy_policies LIMIT 31');
    const active=getRole(r.env)!=='hub'?(await setting(r,'panel')).proxy_ips:[];
    return json({items:rows.slice(0,20).map(row=>({...row,probe:parse(row.probe,{})})),next:rows.length>20?rows[19].id:null,total,countries,settings,nodes,policies:policies.map(p=>({...p,endpoints:parse(p.endpoints,[])})),active,remaining:Math.max(0,settings.daily_test_limit-(budget?.tests||0)),server_time:now()});
  }
  if(path==='sync'&&method==='POST'){
    const settings=await setting(r,'proxy',true);if(!settings.external_enabled)fail('external_catalog_opt_in_required',403);
    await rate(r,'proxy:source-sync',600000);
    let res;try{res=await r.fetch(settings.source_url,{headers:{Accept:'application/json'}},8000);}catch(e){throw new Fault(e instanceof Fault?e.code:'catalog_source_unavailable',502);}
    if(!res.ok)fail('catalog_source_unavailable',502);
    return json(await startProxyImport(r,await res.text(),settings.source_url));
  }
  if(path==='import'&&method==='POST'){
    const b=await bodyJson(request,1100000);keys(b,['data']);return json(await startProxyImport(r,b.data,'manual'));
  }
  if(path==='continue'&&method==='POST'){
    const b=await bodyJson(request);return json(await advanceProxyImport(r,b.id,b.cursor));
  }
  if(path==='import-status'&&method==='GET'){
    const id=ident(url.searchParams.get('id'),48),row=await r.first('SELECT id,cursor,total,original_total,imported,rejected,state FROM nx_proxy_imports WHERE id=? AND expires_at>?',id,now());
    if(!row)fail('import_expired_or_missing',404);return json(row);
  }
  if(path==='cancel-import'&&method==='POST'){
    const b=await bodyJson(request);await r.run("UPDATE nx_proxy_imports SET state='cancelled' WHERE id=? AND state='pending'",ident(b.id,48));return json({success:true});
  }
  if(path==='probe'&&method==='POST')return json(await proxyProbe(r,request,await bodyJson(request)));
  if(path==='apply'&&method==='POST')return json(await applyProxyPolicy(r,await bodyJson(request)));
  if(path==='rollback'&&method==='POST')return json(await applyProxyPolicy(r,await bodyJson(request),true));
  if(path==='remove'&&method==='POST'){
    const b=await bodyJson(request),id=proxyEndpoint(b.id).endpoint;
    // Removing discovery metadata does not silently alter a live node's fallback settings.
    await r.batch([['DELETE FROM nx_proxy_catalog WHERE id=?',id],auditStmt(WEB_ACTOR,'proxy_catalog_removed','entry')]);return json({success:true});
  }
  fail('not_found',404);
}

// ---------------- Web control plane: owner sessions, shared validators, role boundaries ----------------
const WEB_ACTOR = Symbol('web:owner'); // Not representable in a Telegram update or JSON request.
const WEB_COOKIE = '__Host-nexiup-admin';
const WEB_SESSION_MS = 30 * 60000;
const WEB_EDITORS = ['bot','test','panel','proxy','nodes','profiles','plans','payments','guides','channels','coupons','texts'];
function webSecret(env) {
  const secret = env.WEB_ADMIN_KEY !== undefined ? env.WEB_ADMIN_KEY : getRole(env) === 'node' ? env.MASTER_KEY : env.SETUP_KEY;
  if (!strongSecret(secret)) fail('web_admin_secret_required_min_32',503);
  return secret;
}
async function digestHex(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
}
async function webCsrf(secret, token) {
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode('nexiup:web:csrf:'+token))),b=>b.toString(16).padStart(2,'0')).join('');
}
function webOrigin(request) {
  const url=new URL(request.url),origin=request.headers.get('origin');
  if(url.protocol!=='https:')fail('https_required',400);
  if(origin && origin!==url.origin)fail('origin_forbidden',403);
  if(request.headers.get('sec-fetch-site')==='cross-site')fail('origin_forbidden',403);
}
function webFailure(request,record=false) {
  const ip='web:'+String(request.headers.get('cf-connecting-ip')||'unknown'),bucket=authFailures.get(ip);
  if(bucket?.until>now() && bucket.count>=8)throw new Fault('auth_throttled',429,60);
  if(record){
    if(authFailures.size>1000)authFailures.clear();
    authFailures.set(ip,{count:(bucket?.until>now()?bucket.count:0)+1,until:now()+60000});
    fail('unauthorized',401);
  }
}
function sessionCookie(token='',seconds=0) {
  return `${WEB_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
}
async function webLogin(r,request) {
  webOrigin(request);webFailure(request);
  const secret=webSecret(r.env);
  if(!constantTimeEqual(request.headers.get('authorization'),'Bearer '+secret))webFailure(request,true);
  // Bounded, idempotent migrations are authenticated; no unauthenticated DDL/seed work.
  const progress=await migrate(r);
  if(!progress.ready)return json({migration_required:true,...progress},202);
  await rate(r,'web:login:'+String(request.headers.get('cf-connecting-ip')||'unknown'),1000);
  const token=randomId(32),hash=await digestHex(token),expires=now()+WEB_SESSION_MS;
  await r.batch([
    ['DELETE FROM nx_web_sessions WHERE expires_at<=?',now()],
    ['DELETE FROM nx_web_sessions WHERE token_hash IN (SELECT token_hash FROM nx_web_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 15)'],
    ['INSERT INTO nx_web_sessions(token_hash,credential_hash,role,expires_at) VALUES(?,?,?,?)',hash,await digestHex(secret),getRole(r.env),expires],
    auditStmt(WEB_ACTOR,'web_login','owner')
  ]);
  return json({success:true,role:getRole(r.env),version:VERSION,csrf:await webCsrf(secret,token),expires_at:expires},200,{'Set-Cookie':sessionCookie(token,WEB_SESSION_MS/1000)});
}
async function webAuth(r,request) {
  webOrigin(request);webFailure(request);
  const secret=webSecret(r.env),header=request.headers.get('authorization');
  if(header!==null){
    if(!constantTimeEqual(header,'Bearer '+secret))webFailure(request,true);
    await ready(r);return {actor:WEB_ACTOR,hash:'',csrf:'',expires_at:0};
  }
  const cookies=String(request.headers.get('cookie')||'').split(';').map(s=>s.trim());
  const entry=cookies.find(s=>s.startsWith(WEB_COOKIE+'=')),token=entry?.slice(WEB_COOKIE.length+1)||'';
  if(!/^[a-f0-9]{64}$/.test(token))webFailure(request,true);
  await ready(r);
  const hash=await digestHex(token),session=await r.first('SELECT * FROM nx_web_sessions WHERE token_hash=? AND expires_at>?',hash,now());
  if(!session || session.role!==getRole(r.env) || !constantTimeEqual(session.credential_hash,await digestHex(secret)))webFailure(request,true);
  const csrf=await webCsrf(secret,token);
  if(!['GET','HEAD'].includes(request.method)){
    if(request.headers.get('origin')!==new URL(request.url).origin || !constantTimeEqual(request.headers.get('x-nexiup-csrf'),csrf))fail('csrf_failed',403);
  }
  return {actor:WEB_ACTOR,hash,csrf,expires_at:session.expires_at};
}
function webHub(r) { if(getRole(r.env)==='node')fail('hub_only',403); }
function webNode(r) { if(getRole(r.env)==='hub')fail('node_only',403); }
function webEditor(r,kind) {
  if(!WEB_EDITORS.includes(kind))fail('unknown_editor',404);
  if(kind==='panel')webNode(r);
  else if(!['profiles','proxy'].includes(kind))webHub(r);
  return kind;
}
function webNonce(request) { return ident(request.headers.get('idempotency-key')||'',80); }
async function webOverview(r) {
  const role=getRole(r.env),hub=role!=='node',local=role!=='hub';
  const bot=hub?await setting(r,'bot'):null,panel=local?await setting(r,'panel'):null;
  const summary=hub?await getStats(r,'7d'):null;
  const pending=hub?(await r.first("SELECT COUNT(*) AS n FROM nx_orders WHERE status='pending'")).n:0;
  const ops=hub?await r.all('SELECT state,COUNT(*) AS n FROM nx_ops GROUP BY state'):[];
  const localUsers=local?(await r.first('SELECT COUNT(*) AS n FROM nx_panel_users')).n:0;
  const proxyCounts=await r.first("SELECT COUNT(*) AS total,COUNT(DISTINCT CASE WHEN country<>'ZZ' THEN country END) AS countries,SUM(state='relay_ok') AS verified FROM nx_proxy_catalog");
  const recent=await r.all('SELECT id,actor,action,target,created_at FROM nx_audit ORDER BY id DESC LIMIT 6');
  const days=hub?await r.all("SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch') AS day,COUNT(*) AS orders,COALESCE(SUM(total),0) AS revenue FROM nx_orders WHERE status='done' AND kind='sale' AND created_at>=? GROUP BY day ORDER BY day",now()-7*DAY):[];
  return {role,version:VERSION,server_time:now(),summary,pending,ops,local_users:localUsers,proxies:proxyCounts,recent,days,currency:bot?.currency||'',main_url:bot?.main_url||'',maintenance:!!bot?.maintenance,node_paused:!!panel?.paused,node_ready:local&&strongSecret(r.env.MASTER_KEY),telegram_configured:!!r.env.BOT_TOKEN&&!!ownerIds(r.env).length,external_catalog_enabled:(await setting(r,'proxy')).external_enabled};
}
async function webSettingsSave(r,kind,doc,version) {
  const value=await validateEdit(r,kind,doc);
  if(['bot','test','panel','proxy'].includes(kind)){
    number(version,1,1e9,true);
    const result=await r.run('UPDATE nx_settings SET value=?,version=version+1,updated_at=? WHERE key=? AND version=?',JSON.stringify(value),now(),kind,version);
    if(!changes(result))fail('version_conflict',409);
    invalidate(r,'settings:'+kind);
    await audit(r,WEB_ACTOR,'setting_saved',kind,{fields:Object.keys(value),validation:'passed',version:version+1});
    return;
  }
  await applyEdit(r,WEB_ACTOR,kind,value,version);
}
async function webReceipt(r,id) {
  webHub(r);ident(id,80);
  const row=await r.first('SELECT receipt FROM nx_orders WHERE id=?',id),receipt=parse(row?.receipt);
  if(!receipt)fail('receipt_not_found',404);
  if(!receipt.file_id)return json({note:String(receipt.note||'')});
  await rate(r,'web:receipt:'+id,2000);
  const file=await telegram(r,'getFile',{file_id:receipt.file_id});
  if(!file.file_path || !/^[A-Za-z0-9_./-]+$/.test(file.file_path) || file.file_path.includes('..'))fail('invalid_telegram_file',502);
  const res=await r.fetch(`https://api.telegram.org/file/bot${r.env.BOT_TOKEN}/${file.file_path}`,{},8000,8*1024*1024);
  if(!res.ok)fail('receipt_unavailable',502);
  await audit(r,WEB_ACTOR,'receipt_viewed',id);
  const type=res.headers.get('content-type')?.split(';')[0],image=receipt.type==='photo'&&['image/jpeg','image/png','image/webp'].includes(type);
  return new Response(res.body,{headers:{...noStore,'Content-Type':image?type:'application/octet-stream','Content-Disposition':image?'inline':'attachment; filename="receipt.bin"','Content-Security-Policy':"default-src 'none'; sandbox; frame-ancestors 'none'"}});
}
async function webApi(r,request,url) {
  const path=url.pathname.slice('/admin/web-api/'.length),method=request.method;
  if(path==='login'&&method==='POST')return webLogin(r,request);
  const auth=await webAuth(r,request);
  if(path==='session'&&method==='GET')return json({success:true,role:getRole(r.env),version:VERSION,csrf:auth.csrf,expires_at:auth.expires_at});
  if(path==='logout'&&method==='POST'){
    if(auth.hash)await r.run('DELETE FROM nx_web_sessions WHERE token_hash=?',auth.hash);
    await audit(r,WEB_ACTOR,'web_logout','owner');
    return json({success:true},200,{'Set-Cookie':sessionCookie()});
  }
  if(path==='overview'&&method==='GET')return json(await webOverview(r));
  if(path.startsWith('proxy/'))return proxyApi(r,request,url,path.slice(6));
  if(path==='editor'&&method==='GET'){
    const kind=webEditor(r,url.searchParams.get('kind')),id=url.searchParams.get('id')||'';
    const data=await editableDoc(r,kind,id);
    if(['bot','test','panel','proxy'].includes(kind))data.version=(await r.first('SELECT version FROM nx_settings WHERE key=?',kind))?.version||1;
    return json(data);
  }
  if(['validate','save'].includes(path)&&method==='POST'){
    const b=await bodyJson(request),kind=webEditor(r,b.kind);
    const doc=await validateEdit(r,kind,b.doc);
    if(path==='save')await webSettingsSave(r,kind,doc,number(b.version,0,1e9,true));
    return json({success:true,validated:true,...(path==='validate'?{doc}:{})});
  }
  if(path==='catalog'&&method==='GET'){
    const kind=webEditor(r,url.searchParams.get('kind')),cursor=string(url.searchParams.get('cursor')||'',100),q=string(url.searchParams.get('q')||'',60);
    if(kind==='nodes'){
      const rows=await r.all('SELECT n.*,COUNT(s.id) AS active FROM nx_nodes n LEFT JOIN nx_subs s ON s.node_id=n.id AND s.status=? AND s.expires_at>? WHERE n.id>? AND (n.label LIKE ? OR n.id LIKE ?) GROUP BY n.id ORDER BY n.id LIMIT 21','active',now(),cursor,'%'+q+'%','%'+q+'%');
      return json({items:rows.slice(0,20),next:rows.length>20?rows[19].id:null});
    }
    if(kind==='profiles')return json({items:await profiles(r,true),next:null});
    if(['bot','test','panel','proxy'].includes(kind))fail('use_editor');
    const rows=await r.all('SELECT * FROM nx_catalog WHERE kind=? AND id>? AND (id LIKE ? OR data LIKE ?) ORDER BY id LIMIT 21',kind,cursor,'%'+q+'%','%'+q+'%');
    return json({items:rows.slice(0,20).map(row=>({...parse(row.data),version:row.version})),next:rows.length>20?rows[19].id:null});
  }
  if(path==='profiles/rollback'&&method==='POST'){
    const b=await bodyJson(request);await rollbackProfile(r,WEB_ACTOR,ident(b.id));return json({success:true});
  }
  if(path==='audit'&&method==='GET'){
    const before=number(Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER),1,Number.MAX_SAFE_INTEGER,true);
    const rows=await r.all('SELECT * FROM nx_audit WHERE id<? ORDER BY id DESC LIMIT 21',before);
    return json({items:rows.slice(0,20),next:rows.length>20?rows[19].id:null});
  }
  if(path==='receipt'&&method==='GET')return webReceipt(r,url.searchParams.get('id'));
  if(['orders','subscriptions','customers','operations'].includes(path)&&method==='GET'){
    webHub(r);
    const cursor=string(url.searchParams.get('cursor')||'',100),q=string(url.searchParams.get('q')||'',64),filter=string(url.searchParams.get('status')||'',30),id=url.searchParams.get('id');
    if(id){
      let row;
      if(path==='orders')row=await r.first('SELECT o.*,u.name AS customer,u.username FROM nx_orders o LEFT JOIN nx_users u ON u.id=o.user_id WHERE o.id=?',id);
      else if(path==='subscriptions')row=await r.first('SELECT * FROM nx_subs WHERE id=?',id);
      else if(path==='customers')row=await r.first('SELECT * FROM nx_users WHERE id=?',Number(id));
      else row=await r.first('SELECT * FROM nx_ops WHERE id=?',id);
      if(!row)fail('not_found',404);
      if(path==='orders')row.receipt={type:parse(row.receipt)?.type||'',note:parse(row.receipt)?.note||'',available:!!row.receipt};
      if(path==='subscriptions'){const {token,remote_id,bases,...safe}=row;return json({item:{...safe,has_identity:!!remote_id}});}
      if(path==='operations'){const {remote_id,payload,...safe}=row;return json({item:safe});}
      return json({item:row});
    }
    let rows;
    if(path==='orders')rows=await r.all('SELECT o.id,o.user_id,o.kind,o.plan_id,o.total,o.status,o.created_at,o.location,u.name AS customer FROM nx_orders o LEFT JOIN nx_users u ON u.id=o.user_id WHERE o.id>? AND (?=\'\' OR o.status=?) AND (o.id LIKE ? OR u.name LIKE ? OR CAST(o.user_id AS TEXT)=?) ORDER BY o.id LIMIT 21',cursor,filter,filter,'%'+q+'%','%'+q+'%',q);
    else if(path==='subscriptions')rows=await r.all('SELECT s.id,s.name,s.user_id,s.node_id,s.status,s.expires_at,s.limits FROM nx_subs s WHERE s.id>? AND (?=\'\' OR s.status=?) AND (s.name LIKE ? OR CAST(s.user_id AS TEXT)=?) ORDER BY s.id LIMIT 21',cursor,filter,filter,'%'+q+'%',q);
    else if(path==='customers')rows=await r.all('SELECT id,username,name,lang,balance,banned,admin,last_at,created_at FROM nx_users WHERE id>? AND (name LIKE ? OR username LIKE ? OR CAST(id AS TEXT)=?) ORDER BY id LIMIT 21',Number(cursor||0),'%'+q+'%','%'+q+'%',q);
    else rows=await r.all('SELECT id,kind,user_id,node_id,state,phase,error,retry_at,created_at FROM nx_ops WHERE id>? AND (?=\'\' OR state=?) AND (id LIKE ? OR CAST(user_id AS TEXT)=?) ORDER BY id LIMIT 21',cursor,filter,filter,'%'+q+'%',q);
    return json({items:rows.slice(0,20),next:rows.length>20?String(rows[19].id):null});
  }
  if(path==='orders/decide'&&method==='POST'){
    webHub(r);const b=await bodyJson(request);ident(b.id,80);
    if(b.action==='approve')return json(await approveOrder(r,WEB_ACTOR,b.id));
    if(b.action==='reject'){await finishOrder(r,b.id,'rejected',string(b.reason,500,1),WEB_ACTOR);return json({success:true});}
    fail('invalid_action');
  }
  if(path==='operations/retry'&&method==='POST'){
    webHub(r);const b=await bodyJson(request);if(!['','absent','reset'].includes(b.manual||''))fail('invalid_retry_confirmation');await retryOp(r,WEB_ACTOR,ident(b.id,80),b.manual||'');return json({success:true});
  }
  if(path==='subscriptions/action'&&method==='POST'){
    webHub(r);const b=await bodyJson(request);if(!['toggle','reset','delete'].includes(b.action))fail('invalid_action');
    await adminSubAction(r,WEB_ACTOR,ident(b.id,80),b.action,'web:'+webNonce(request));return json({success:true});
  }
  if(path==='customers/action'&&method==='POST'){
    webHub(r);const b=await bodyJson(request),id=number(b.id,1,Number.MAX_SAFE_INTEGER,true);
    const u=await r.first('SELECT * FROM nx_users WHERE id=?',id);if(!u)fail('user_not_found',404);
    if(b.action==='ban'){
      if(ownerIds(r.env).includes(id)||u.admin)fail('cannot_ban_admin');
      await r.batch([['UPDATE nx_users SET banned=? WHERE id=?',+bool(b.banned),id],auditStmt(WEB_ACTOR,'user_ban_changed',id,{banned:b.banned})]);
    }else if(b.action==='wallet'){
      const key='web-wallet:'+webNonce(request),amount=number(b.amount,-1e12,1e12,true);if(!amount)fail('invalid_amount');
      const reason=string(b.reason,200,1),old=await r.first('SELECT user_id,amount FROM nx_ledger WHERE key=?',key);
      if(old&&(old.user_id!==id||old.amount!==amount))fail('idempotency_conflict',409);
      await r.batch([
        ['INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) VALUES(?,?,?,\'admin_adjustment\',?,?)',key,id,amount,reason,now()],
        auditStmt(WEB_ACTOR,'wallet_adjusted',id,{amount,reference:key})
      ]);
    }else if(b.action==='test_reset')await resetTestCooldown(r,WEB_ACTOR,id);
    else fail('invalid_action');
    return json({success:true});
  }
  if(path==='node-users/validate'&&method==='POST'){webNode(r);return json({validated:true,doc:validatePanelUser(await bodyJson(request))});}
  if(path==='node-users'){
    webNode(r);const id=url.searchParams.get('id')||'',panel=await setting(r,'panel');
    if(method==='GET'){
      if(id){const row=await r.first('SELECT data FROM nx_panel_users WHERE id=?',id);if(!row)fail('user_not_found',404);return json({item:await panelGet(r,id,url.origin),doc:parse(row.data)});}
      const q=string(url.searchParams.get('q')||'',64),cursor=string(url.searchParams.get('cursor')||'',80);
      const rows=await r.all('SELECT u.*,x.up,x.down,x.day,x.day_up,x.day_down FROM nx_panel_users u LEFT JOIN nx_panel_usage x ON x.id=u.id AND x.epoch=u.epoch WHERE u.id>? AND (u.name LIKE ? OR u.id=?) ORDER BY u.id LIMIT 21',cursor,'%'+q+'%',q);
      return json({items:rows.slice(0,20).map(row=>enrichedPanel(row,row,url.origin,panel.api_route)),next:rows.length>20?rows[19].id:null});
    }
    const nonce=webNonce(request);let result;
    if(method==='POST'&&!id)result={user:await panelCreate(r,await bodyJson(request),'web:'+nonce)};
    else if(id&&['POST','PUT','DELETE'].includes(method))result=await panelMutate(r,id,method,method==='PUT'?await bodyJson(request):{},url.searchParams.get('action')||'','web:'+nonce);
    else fail('method_not_allowed',405);
    await audit(r,WEB_ACTOR,'web_node_user_changed','user#'+(await digestHex(result.user?.id||id)).slice(0,16),{method});
    return json({success:true,...result});
  }
  if(path==='nodes/health'&&method==='POST'){
    webHub(r);const b=await bodyJson(request),n=await r.first('SELECT * FROM nx_nodes WHERE id=?',ident(b.id));if(!n)fail('node_not_found',404);
    await rate(r,'web:health:'+n.id,5000);const info=await nodeRequest(r,n);
    await r.run('UPDATE nx_nodes SET last_health_ok=? WHERE id=?',now(),n.id);
    return json({success:true,total:Number(info.total),max_users:n.max_users,exit_country_verified:false});
  }
  if(path==='keys'){
    webNode(r);
    if(method==='GET')return json({items:await r.all('SELECT id,name,secret_ref,created_at FROM nx_panel_keys ORDER BY created_at LIMIT 8')});
    if(method==='POST'){
      const b=await bodyJson(request);keys(b,['name','secret_ref']);string(b.name,80,1);ref(b.secret_ref);
      if(!strongSecret(r.env[b.secret_ref])||controlSecret(r.env,r.env[b.secret_ref]))fail('set_distinct_panel_key_secret_first');
      if((await r.first('SELECT COUNT(*) AS n FROM nx_panel_keys')).n>=8)fail('too_many_keys');
      const id=randomId(8);await r.batch([['INSERT INTO nx_panel_keys(id,name,secret_ref,created_at) VALUES(?,?,?,?)',id,b.name,b.secret_ref,now()],auditStmt(WEB_ACTOR,'key_registered',id,{secret_ref:b.secret_ref})]);return json({success:true,id});
    }
    if(method==='DELETE'){const id=ident(url.searchParams.get('id'));await r.batch([['DELETE FROM nx_panel_keys WHERE id=?',id],auditStmt(WEB_ACTOR,'key_revoked',id)]);return json({success:true});}
  }
  fail('not_found',404);
}

// ---------------- Telegram authentication, bounded client, localized navigation ----------------
async function sign(env,value) {
  if(!strongSecret(env.CALLBACK_SECRET))fail('callback_secret_required',503);
  const key=await crypto.subtle.importKey('raw',enc.encode(env.CALLBACK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(value)));
  return Array.from(bytes.slice(0,8),x=>x.toString(16).padStart(2,'0')).join('');
}
async function callback(env,userId,action,id='0') {
  if(!/^[a-z0-9_]{1,16}$/.test(action)||!/^[a-zA-Z0-9_~.-]{1,39}$/.test(String(id)))fail('invalid_callback');
  const data=action+':'+id+':'+await sign(env,`${userId}:${action}:${id}`);
  if(enc.encode(data).length>64)fail('callback_too_long');return data;
}
async function verifyCallback(env,userId,data) {
  if(typeof data!=='string'||data.length>64)fail('invalid_callback',403);
  const [action,id,mac,...rest]=data.split(':');
  if(rest.length||!action||!id||!mac||!constantTimeEqual(mac,await sign(env,`${userId}:${action}:${id}`)))fail('invalid_callback',403);
  return {action,id};
}
async function telegram(r,method,payload,form=false) {
  if(!r.env.BOT_TOKEN)fail('bot_token_missing',503);
  const res=await r.fetch(`https://api.telegram.org/bot${r.env.BOT_TOKEN}/${method}`,{method:'POST',...(form?{body:payload}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})});
  const data=parse(await res.text());
  if(res.status===429||data?.error_code===429)throw new Fault('telegram_rate_limit',429,Math.max(1,Math.min(86400,Number(data?.parameters?.retry_after)||60)));
  if(res.status===403||data?.error_code===403)throw new Fault('telegram_blocked',403);
  if(!res.ok||!data?.ok)throw new Fault('telegram_error',502,60);
  return data.result;
}
async function markup(r,userId,buttons=[]) {
  const rows=[];
  for(const item of buttons){
    if(Array.isArray(item)){const row=[];for(const b of item)row.push(b.url?{text:b.label,url:b.url}:{text:b.label,callback_data:await callback(r.env,userId,b.action,b.id||'0')});rows.push(row);}
    else rows.push([item.url?{text:item.label,url:item.url}:{text:item.label,callback_data:await callback(r.env,userId,item.action,item.id||'0')}]);
  }
  return {inline_keyboard:rows};
}
async function send(r,u,text,buttons=[]) {
  // No parse_mode: user-supplied names, receipts, JSON and URLs cannot inject Telegram HTML/Markdown.
  string(text,16000);if(text.length>4096)fail('message_too_long');
  return telegram(r,'sendMessage',{chat_id:u.id,text,link_preview_options:{is_disabled:true},reply_markup:await markup(r,u.id,buttons)});
}
const back = u => ({label:t(u,'🔙 منوی اصلی','🔙 Main menu'),action:'home'});
async function adminIds(r){const db=await r.all('SELECT id FROM nx_users WHERE admin=1 LIMIT 5');return [...new Set([...ownerIds(r.env),...db.map(x=>x.id)])].slice(0,5);}
async function isAdmin(r,id){if(id===WEB_ACTOR)return true;if(ownerIds(r.env).includes(Number(id)))return true;const u=await r.first('SELECT admin,banned FROM nx_users WHERE id=?',id);return !!u?.admin&&!u.banned;}
async function userRow(r,from,start='') {
  number(from.id,1,Number.MAX_SAFE_INTEGER,true);
  let u=await r.first('SELECT * FROM nx_users WHERE id=?',from.id);
  if(!u){
    const rid=/^ref_(\d{1,16})$/.exec(start)?.[1];const referrer=rid&&Number(rid)!==from.id?await r.first('SELECT id FROM nx_users WHERE id=?',Number(rid)):null;
    await r.run('INSERT OR IGNORE INTO nx_users(id,username,name,referrer,created_at,last_at) VALUES(?,?,?,?,?,?)',from.id,String(from.username||'').slice(0,32),String(from.first_name||'').slice(0,80),referrer?.id||null,now(),now());
    u=await r.first('SELECT * FROM nx_users WHERE id=?',from.id);
  }else if(now()-u.last_at>3600000){await r.run('UPDATE nx_users SET last_at=?,username=?,name=?,blocked=0 WHERE id=?',now(),String(from.username||'').slice(0,32),String(from.first_name||'').slice(0,80),from.id);}
  return u;
}
async function state(r,id,step,data={}) {await r.run('INSERT INTO nx_states(user_id,step,data,expires_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET step=excluded.step,data=excluded.data,expires_at=excluded.expires_at',id,step,JSON.stringify(data),now()+30*60000);}
async function clearState(r,id){await r.run('DELETE FROM nx_states WHERE user_id=?',id);}
async function customText(r,u,id,fallback) {const c=await catalogItem(r,'texts',id);const text=c?.enabled ? (u.lang==='en'?c.en:c.fa)||fallback : fallback;return text.replaceAll('{name}',u.name||'').replaceAll('{brand}','NexiUP');}
async function showTerms(r,u) {
  const bot=await setting(r,'bot');return send(r,u,u.lang==='en'?bot.terms_en:bot.terms_fa,[{label:t(u,'می‌پذیرم','I accept'),action:'terms'},[{label:'فارسی',action:'lang',id:'fa'},{label:'English',action:'lang',id:'en'}]]);
}
async function membership(r,u) {
  const channels=await catalog(r,'channels',true,'',4);if(channels.length>3)fail('max_three_forced_channels');const missing=[];
  for(const ch of channels){
    const key=`member:${u.id}:${ch.id}`,cached=cache(r).get(key);let joined=cached?.until>now()?cached.joined:null;
    if(joined===null){
      const m=await telegram(r,'getChatMember',{chat_id:ch.chat_id,user_id:u.id});joined=['creator','administrator','member'].includes(m.status)||(m.status==='restricted'&&m.is_member);
      cache(r).set(key,{joined,until:now()+60000});
      await r.run('INSERT INTO nx_members(user_id,channel,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at WHERE nx_members.status<>excluded.status',u.id,ch.chat_id,joined?'joined':'left',now());
    }
    if(!joined)missing.push(ch);
  }
  if(missing.length){await send(r,u,t(u,'ابتدا عضو کانال‌ها شوید؛ سپس بررسی عضویت را بزنید.','Join the required channels, then check membership.'),[...missing.map(c=>({label:c.title,url:c.invite_url})),{label:t(u,'بررسی عضویت','Check membership'),action:'join'},back(u)]);return false;}
  return true;
}
async function home(r,u) {
  const bot=await setting(r,'bot'),admin=await isAdmin(r,u.id);
  const text=await customText(r,u,'main',t(u,'به NexiUP خوش آمدید. چه کاری انجام دهیم؟','Welcome to NexiUP. What would you like to do?'));
  /** @type {MenuButtons} */
  const buttons=[
    [{label:t(u,'🛒 خرید اشتراک','🛒 Buy subscription'),action:'shop'},{label:t(u,'📦 اشتراک‌های من','📦 My subscriptions'),action:'subs'}],
    [{label:t(u,'🧪 دریافت کانفیگ تست','🧪 Get test configuration'),action:'test'},{label:t(u,'📖 راهنمای اتصال','📖 Import guides'),action:'guides'}],
    [{label:t(u,'💰 کیف پول','💰 Wallet'),action:'wallet'},{label:t(u,'👥 دعوت دوستان','👥 Referrals'),action:'referral'}],
    [{label:t(u,'📞 پشتیبانی','📞 Support'),action:'support'},{label:t(u,'📜 قوانین','📜 Terms'),action:'rules'}],
    [{label:'فارسی',action:'lang',id:'fa'},{label:'English',action:'lang',id:'en'}]
  ];if(admin)buttons.push({label:t(u,'⚙️ مدیریت','⚙️ Administration'),action:'admin'});
  return send(r,u,(bot.announcement?bot.announcement+'\n\n':'')+text,buttons);
}
function limitsText(u,p) {
  if(p.unknown)return t(u,'اشتراک دستی قدیمی: سهمیه و محدودیت‌ها تأیید نشده‌اند.','Legacy manual subscription: quotas and limits are unverified.');
  const total=p.total_gb===0?t(u,'بدون سقف کل','No total cap'):`${p.total_gb} GiB`;
  const daily=p.daily_gb===0?t(u,'بدون سقف روزانه','No daily cap'):`${p.daily_gb} GiB/day`;
  return t(u,`مدت: ${p.days} روز\nکل: ${total} • روزانه: ${daily}\nاتصال هم‌زمان در هر isolate: ${p.conn_limit||'بدون سقف پلن'}`,`Validity: ${p.days} days\nTotal: ${total} • Daily: ${daily}\nConcurrent connections per isolate: ${p.conn_limit||'no plan cap'}`);
}
async function shop(r,u,location='',cursor='') {
  if(!location)return send(r,u,t(u,'موقعیت فروش را انتخاب کنید. کشور خروجی باید با تست شبکه تأیید شود.','Choose a sales location. Actual exit country requires network verification.'),[[{label:'🇩🇪 آلمان / Germany',action:'location',id:'de'},{label:'🇺🇸 آمریکا / USA',action:'location',id:'us'}],back(u)]);
  if(!['de','us'].includes(location))fail('invalid_location');
  const rows=await catalog(r,'plans',true,cursor,9),plans=rows.slice(0,8).filter(p=>p.locations.includes(location));
  return send(r,u,t(u,'پلن را انتخاب کنید:','Select a plan:'),[...plans.map(p=>({label:`${p.name} — ${p.price}`,action:'plan',id:p.id+'~'+location})),...(rows.length>8?[{label:t(u,'بعدی','Next'),action:'location',id:location+'~'+rows[7].id}]:[]),back(u)]);
}
async function planView(r,u,id,location) {
  const p=await catalogItem(r,'plans',id);if(!p?.enabled||!p.locations.includes(location))fail('plan_unavailable');const bot=await setting(r,'bot');
  return send(r,u,`${p.name}\n${p.description}\n\n${limitsText(u,p)}\n${p.price} ${bot.currency}\n${location.toUpperCase()}`,[{label:t(u,'خرید و پرداخت','Buy and pay'),action:'buy',id:id+'~'+location},back(u)]);
}
async function createOrder(r,u,planId,location,key,renewalId=null) {
  const raw=await catalogItem(r,'plans',planId);if(!raw?.enabled||!raw.locations.includes(location))fail('plan_unavailable');const {version,...p}=raw;
  const bot=await setting(r,'bot');httpsOrigin(bot.main_url);
  if(!await r.first("SELECT id FROM nx_nodes WHERE enabled=1 AND code=? AND purpose='sales' LIMIT 1",location))fail('no_matching_sales_node');
  if(renewalId){const s=await r.first('SELECT user_id,node_id FROM nx_subs WHERE id=?',renewalId);if(s?.user_id!==u.id||!s.node_id)fail('renewal_not_owned_or_legacy');}
  const existing=await r.first("SELECT * FROM nx_orders WHERE user_id=? AND plan_id=? AND location=? AND COALESCE(renewal_id,'')=? AND status IN ('pending_payment','pending')",u.id,planId,location,renewalId||'');
  if(existing)return existing;
  const pending=(await r.first("SELECT COUNT(*) AS n FROM nx_orders WHERE user_id=? AND status IN ('pending_payment','pending','processing')",u.id)).n;if(pending>=bot.max_pending)fail('too_many_pending_orders');
  const first=await r.first("SELECT id FROM nx_orders WHERE user_id=? AND kind='sale' AND status='done' LIMIT 1",u.id);
  const discount=first?0:Math.floor(p.price*bot.first_discount_percent/100);
  await r.batch([
    ['INSERT OR IGNORE INTO nx_orders(id,user_id,plan_id,kind,renewal_id,location,snapshot,total,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',key,u.id,planId,'sale',renewalId,location,JSON.stringify(p),p.price,p.price===0?'pending':'pending_payment',now(),now()+bot.order_hours*3600000],
    [`INSERT OR IGNORE INTO nx_coupon_uses(order_id,coupon_id,user_id,discount,created_at) SELECT ?,'__first_offer',?,?,? WHERE ?>0 AND EXISTS(SELECT 1 FROM nx_orders WHERE id=? AND user_id=?)`,key,u.id,discount,now(),discount,key,u.id],
    [`UPDATE nx_orders SET total=?-COALESCE((SELECT discount FROM nx_coupon_uses WHERE order_id=?),0),status=CASE WHEN ?-COALESCE((SELECT discount FROM nx_coupon_uses WHERE order_id=?),0)=0 THEN 'pending' ELSE 'pending_payment' END WHERE id=? AND user_id=? AND status IN ('pending_payment','pending') AND wallet_paid=0`,p.price,key,p.price,key,key,u.id]
  ]);
  const result=await r.first("SELECT * FROM nx_orders WHERE user_id=? AND plan_id=? AND location=? AND COALESCE(renewal_id,'')=? AND status IN ('pending_payment','pending')",u.id,planId,location,renewalId||'');
  if(result.total===0)await notifyAdmins(r,'review:'+result.id,`Free-price order ${result.id}`, [{label:'بررسی / Review',action:'review',id:result.id}]);return result;
}
async function invoice(r,u,order) {
  if(!order||order.user_id!==u.id)fail('order_not_owned',403);
  const bot=await setting(r,'bot');const p=parse(order.snapshot),due=order.total-order.wallet_paid;
  const text=t(u,`فاکتور ${order.id}\n${p.name||'شارژ کیف پول'}\nمبلغ کل: ${order.total} ${bot.currency}\nکیف پول: ${order.wallet_paid}\nباقی‌مانده: ${due}\nمهلت: ${stamp(order.expires_at)}\nوضعیت: ${order.status}`,`Invoice ${order.id}\n${p.name||'Wallet top-up'}\nTotal: ${order.total} ${bot.currency}\nWallet paid: ${order.wallet_paid}\nRemaining: ${due}\nDeadline: ${stamp(order.expires_at)}\nStatus: ${order.status}`);
  const buttons=[];
  if(order.status==='pending_payment'){
    if(order.kind==='sale'&&!order.wallet_paid)buttons.push([{label:t(u,'پرداخت کیف پول','Pay with wallet'),action:'paywallet',id:order.id},{label:t(u,'پرداخت ترکیبی','Split payment'),action:'paysplit',id:order.id}]);
    buttons.push({label:t(u,'کارت به کارت / روش پرداخت','Card transfer / Payment methods'),action:'paymethods',id:order.id});
    if(order.kind==='sale'&&!order.wallet_paid)buttons.push({label:t(u,'کد تخفیف','Discount code'),action:'coupon',id:order.id});
    buttons.push({label:t(u,'لغو و برگشت کیف پول','Cancel and refund wallet'),action:'cancelorder',id:order.id});
  }
  buttons.push(back(u));return send(r,u,text,buttons);
}
async function ownedSub(r,userId,id) {const s=await r.first('SELECT * FROM nx_subs WHERE id=? AND user_id=?',id,userId);if(!s)fail('subscription_not_owned',403);return s;}
async function listSubs(r,u,cursor='') {
  const rows=await r.all('SELECT * FROM nx_subs WHERE user_id=? AND id>? ORDER BY id LIMIT 9',u.id,cursor);
  const buttons=rows.slice(0,8).map(s=>({label:`${s.expires_at>now()?'🟢':'⚪'} ${s.name} (${s.id})`,action:'subview',id:s.id}));
  if(rows.length>8)buttons.push({label:t(u,'بعدی','Next'),action:'subs',id:rows[7].id});
  return send(r,u,t(u,'اشتراک‌های شما:','Your subscriptions:'),[...buttons,back(u)]);
}
async function subView(r,u,id) {
  const s=await ownedSub(r,u.id,id),lim=parse(s.limits),bot=await setting(r,'bot');
  const text=`${s.name}\n${limitsText(u,lim)}\n${t(u,'انقضا','Expiry')}: ${stamp(s.expires_at)}\n${t(u,'روز باقی‌مانده','Days remaining')}: ${Math.max(0,Math.ceil((s.expires_at-now())/DAY))}\n${mainSubscriptionUrl(bot,s.token)}`;
  return send(r,u,text,[{label:t(u,'📊 مصرف واقعی نود','📊 Node usage'),action:'subusage',id},{label:t(u,'🔁 تمدید','🔁 Renew'),action:'renew',id},{label:'باز نشد؟ کانفیگ‌ها ارسال شوند',action:'fallback',id},{label:t(u,'ارسال مجدد QR و لینک','Resend QR and URL'),action:'deliver',id},back(u)]);
}
async function usageSub(r,u,id) {
  const s=await ownedSub(r,u.id,id);if(!s.node_id)fail('legacy_no_live_usage');const n=await r.first('SELECT * FROM nx_nodes WHERE id=?',s.node_id);
  const remote=normalizeRemoteUser((await nodeRequest(r,n,'GET',s.remote_id)).user),total=remote.usage?.total;
  const daily=remote.usage?.dailyBytes;
  return send(r,u,`${s.name}\n${t(u,'مصرف کل','Total usage')}: ${typeof total==='number'?(total/GIB).toFixed(3)+' GiB':'unknown'}\n${t(u,'مصرف امروز','Today')}: ${typeof daily==='number'?(daily/GIB).toFixed(3)+' GiB':t(u,'در API نود قدیمی به بایت گزارش نمی‌شود','Stock API daily field is not byte-accurate')}\n${t(u,'انقضا','Expiry')}: ${stamp(remote.expiryMs)}\n${t(u,'شمارنده‌ها با تأخیر ذخیره می‌شوند.','Counters are persisted with a delay.')}`,[back(u)]);
}

async function adminMenu(r,u) {
  /** @type {MenuButtons} */
  const buttons=[
    ['nodes','🌐 نودها / Nodes'],['profiles','📡 پروفایل اپراتور / Profiles'],['test','🧪 تنظیمات تست / Test settings'],
    ['plans','🛒 پلن‌ها / Plans'],['payments','💳 پرداخت / Payments'],['guides','📖 راهنما / Guides'],['channels','📢 عضویت / Channels'],['coupons','🎟 تخفیف / Coupons'],['texts','📝 متن‌ها / Texts'],['bot','⚙️ تنظیمات ربات / Bot settings'],['panel','🛡 تنظیمات نود محلی / Local node']
  ].map(([id,label])=>({label,action:'manage',id}));
  buttons.push({label:'🩺 سلامت / Diagnostics',action:'diagnostics'},{label:'📦 سفارش‌ها / Orders',action:'orders'},{label:'🔁 صدور و بازیابی / Operations',action:'ops'},{label:'🧪 سابقه تست / Test grants',action:'grants'},{label:'👥 کاربران / Users',action:'users'},{label:'💸 برداشت‌ها / Withdrawals',action:'withdrawals'},{label:'📣 همگانی / Broadcast',action:'broadcast'},{label:'📊 آمار / Statistics',action:'stats'},{label:'☁️ مصرف Cloudflare / Usage',action:'usage'},{label:'💾 پشتیبان تنظیمات / Backup',action:'backup'},{label:'📋 رویدادها / Audit',action:'audit'},back(u));
  return send(r,u,t(u,'مدیریت NexiUP — تغییرات عملیاتی در D1 ذخیره می‌شوند.','NexiUP administration — operational changes are stored in D1.'),buttons);
}
async function manage(r,u,kind,cursor='') {
  if(['bot','test','panel'].includes(kind))return beginEdit(r,u,kind,'');
  let docs;
  if(kind==='nodes')docs=await r.all('SELECT * FROM nx_nodes WHERE id>? ORDER BY id LIMIT 9',cursor);
  else if(kind==='profiles')docs=await profiles(r,true);
  else docs=await catalog(r,kind,false,cursor,9);
  const buttons=docs.slice(0,8).map(p=>({label:`${p.enabled?'🟢':'⚪'} ${p.label||p.name||p.title||p.id} (${p.id})`,action:'edit',id:kind+'~'+p.id}));
  if(docs.length>8)buttons.push({label:'بعدی / Next',action:'managepage',id:kind+'~'+docs[7].id});
  buttons.push({label:'➕ جدید / New',action:'edit',id:kind+'~new'},{label:'🔙 مدیریت / Admin',action:'admin'});
  return send(r,u,kind+'\n'+t(u,'رکورد را برای مشاهده، ویرایش، فعال/غیرفعال‌سازی انتخاب کنید.','Select a record to view, edit, enable or disable.'),buttons);
}
async function beginEdit(r,u,kind,id) {
  const x=await editableDoc(r,kind,id==='new'?'':id);
  await state(r,u.id,'admin:edit',{kind,id:id==='new'?'':id,version:x.version});
  const text=t(u,'JSON را ویرایش و در یک پیام بفرستید؛ ابتدا پیش‌نمایش و اعتبارسنجی می‌شود. مقدار رازها را اینجا نفرستید؛ فقط نام Secret.','Edit this JSON and send it as one message. Validation and preview precede activation. Never send secret values; use Secret references.')+'\n'+JSON.stringify(x.doc,null,2);
  const buttons=[{label:'🔙 لغو / Cancel',action:'admin'}];
  if(kind==='profiles'&&id!=='new')buttons.unshift({label:'↩️ نسخه قبلی / Roll back',action:'rollback',id});
  if(kind==='nodes'&&id!=='new')buttons.unshift({label:'🩺 تست API / Test node',action:'nodetest',id});
  if(kind==='test')buttons.unshift({label:'بازنشانی cooldown کاربر / Reset cooldown',action:'resetcool'});
  if(kind==='channels'&&id!=='new')buttons.unshift({label:'تست دسترسی ربات / Test bot membership',action:'channeltest',id});
  if(text.length>3900){await enqueue(r,'editor:'+u.id+':'+randomId(4),u.id,'document',{content:JSON.stringify(x.doc,null,2),filename:'nexiup-settings.json',caption:'Edit and send this JSON file back while the editor is open.'});return send(r,u,'فایل JSON در صف است؛ آن را ویرایش و همینجا بارگذاری کنید. / JSON file queued; edit and upload it here.',buttons);}
  return send(r,u,text,buttons);
}
async function reviewOrder(r,u,id) {
  const o=await r.first('SELECT * FROM nx_orders WHERE id=?',id);if(!o)fail('order_not_found');const rec=parse(o.receipt);
  /** @type {MenuButtons} */
  const buttons=o.status==='pending'?[{label:'✅ تأیید / Approve',action:'approve',id},{label:'❌ رد با علت / Reject with reason',action:'reject',id}]:[];
  if(o.status==='processing')buttons.push({label:'صدور و بازیابی / Operations',action:'ops'});
  buttons.push({label:'🔙 سفارش‌ها / Orders',action:'orders'});
  const text=`${id}\nUser: ${o.user_id}\n${parse(o.snapshot).name||'Top-up'}\n${o.location||''}\nTotal: ${o.total}; wallet: ${o.wallet_paid}; transfer due: ${o.total-o.wallet_paid}\nStatus: ${o.status}\n${rec?.note||''}`;
  if(rec?.file_id){const method=rec.type==='photo'?'sendPhoto':'sendDocument',field=rec.type==='photo'?'photo':'document';return telegram(r,method,{chat_id:u.id,[field]:rec.file_id,caption:text.slice(0,1000),reply_markup:await markup(r,u.id,buttons)});}
  return send(r,u,text,buttons);
}
async function ordersMenu(r,u,cursor='') {
  const rows=await r.all("SELECT * FROM nx_orders WHERE id>? ORDER BY id LIMIT 9",cursor);
  const buttons=rows.slice(0,8).map(o=>({label:`${o.id}: ${o.status} (${o.total})`,action:'review',id:o.id}));
  if(rows.length>8)buttons.push({label:'بعدی / Next',action:'orders',id:rows[7].id});buttons.push({label:'🔙 مدیریت / Admin',action:'admin'});
  return send(r,u,'سفارش‌ها / Orders',buttons);
}
async function operationsMenu(r,u,cursor='') {
  const rows=await r.all("SELECT id,state,error FROM nx_ops WHERE id>? AND state<>'done' ORDER BY id LIMIT 9",cursor);
  const buttons=rows.slice(0,8).map(o=>({label:`${o.id}: ${o.state}${o.error?' ('+o.error+')':''}`,action:'opview',id:o.id}));
  if(rows.length>8)buttons.push({label:'بعدی / Next',action:'ops',id:rows[7].id});buttons.push({label:'🔙 مدیریت / Admin',action:'admin'});
  return send(r,u,t(u,'سفارش پرداخت‌شده حذف نمی‌شود. نتیجه مبهم stock Nahan به بررسی نیاز دارد.','Paid orders are retained. Ambiguous stock-Nahan outcomes require reconciliation.'),buttons);
}
async function operationView(r,u,id) {
  const op=await r.first('SELECT * FROM nx_ops WHERE id=?',id);if(!op)fail('operation_not_found');
  return send(r,u,`${id}\nState: ${op.state}; phase: ${op.phase}\nNode: ${op.node_id||'unassigned'}\nError: ${op.error||'—'}\nName: ${op.name}`,[{label:'تلاش / تطبیق دوباره — Retry/reconcile',action:'retryop',id},{label:'تأیید نبودن حساب در نود — Confirm absent',action:'absentop',id},{label:'تأیید انجام reset — Confirm reset done',action:'resetdone',id},{label:'🔙 عملیات / Operations',action:'ops'}]);
}
async function retryOp(r,actor,id,manual='') {
  const op=await r.first('SELECT * FROM nx_ops WHERE id=?',id);if(!op||op.state==='done')return;
  if(manual==='absent'){
    if(op.kind==='renew'||op.phase==='remote_ready')fail('cannot_recreate_existing_subscription');
    const node=await r.first('SELECT * FROM nx_nodes WHERE id=?',op.node_id);if(!node)fail('node_missing');
    try{await nodeRequest(r,node,'GET',op.name);fail('remote_account_exists');}catch(e){if(e.status!==404)throw e;}
    // This path is explicit admin confirmation after independent investigation, never automated.
    await r.run('UPDATE nx_ops SET phase=?,remote_id=NULL,state=?,error=NULL,retry_at=0 WHERE id=?','new','queued',id);
  }else if(manual==='reset'){
    if(op.phase!=='reset_sent'||op.kind!=='renew')fail('not_waiting_reset_confirmation');
    await r.run('UPDATE nx_ops SET phase=?,state=?,retry_at=0 WHERE id=?','reset_done','queued',id);
  }else{
    if(op.kind==='test'&&op.state==='failed'){
      const slot=await r.first('UPDATE nx_test_slots SET op_id=? WHERE user_id=? AND op_id IS NULL AND next_at<=? RETURNING user_id',id,op.user_id,now());if(!slot)fail('test_slot_unavailable');
    }
    await r.run('UPDATE nx_ops SET state=?,retry_at=0 WHERE id=?',op.phase==='create_sent'?'reconcile':'queued',id);
  }
  await audit(r,actor,'operation_retry',id,{confirmation:manual||'none'});
}
async function nodeHealth(r,u,id) {
  const n=await r.first('SELECT * FROM nx_nodes WHERE id=?',id);if(!n)fail('node_not_found');const result=await nodeRequest(r,n);
  let edge=null;
  if(!n.local&&n.adapter==='nexiup'){
    const response=await r.fetch(`${n.base_url}/${n.api_route}/api/stats`,{headers:{Authorization:'Bearer '+r.env[n.api_key_ref]}});if(response.ok)edge=parse(await response.text())?.colo;
  }
  await r.batch([['UPDATE nx_nodes SET last_health_ok=? WHERE id=?',now(),id],auditStmt(u.id,'node_health_checked',id,{ok:true})]);
  return send(r,u,`✅ ${n.label}\nAPI authenticated; users: ${result.total??'unknown'}\nCloudflare edge colo: ${edge||t(u,'نامشخص؛ برای local در پنل وب ببینید','unknown; inspect local web-panel stats')}\n${t(u,'IP/کشور خروجی پراکسی: تأیید نشده. colo کشور خروجی تونل نیست. با یک کلاینت متصل و سرویس بررسی IP مورد اعتماد آزمایش کنید.','Proxy exit IP/country: not verified. Colo is not the tunnel exit country. Verify through a connected client and a trusted IP-check service.')}`,[{label:'مدیریت / Admin',action:'admin'}]);
}
async function usersMenu(r,u,cursor='0') {
  const rows=await r.all('SELECT id,name,balance,banned FROM nx_users WHERE id>? ORDER BY id LIMIT 9',Number(cursor)||0);
  const buttons=rows.slice(0,8).map(x=>({label:`${x.banned?'🚫':'👤'} ${x.name||x.id} (${x.id})`,action:'userview',id:String(x.id)}));
  if(rows.length>8)buttons.push({label:'بعدی / Next',action:'users',id:String(rows[7].id)});
  return send(r,u,'کاربران / Users',[...buttons,{label:'🔎 جستجو / Search',action:'usersearch'},{label:'🔙 مدیریت / Admin',action:'admin'}]);
}
async function userView(r,u,id) {
  const x=await r.first('SELECT * FROM nx_users WHERE id=?',Number(id));if(!x)fail('user_not_found');
  /** @type {MenuButtons} */
  const buttons=[{label:x.banned?'رفع مسدودی / Unban':'مسدود / Ban',action:'ban',id:String(id)+'~'+(x.banned?'0':'1')},{label:'اصلاح کیف پول / Adjust balance',action:'balance',id:String(id)},{label:'پیام مستقیم / Message',action:'directmsg',id:String(id)},{label:'اشتراک‌ها / Subscriptions',action:'usersubs',id:String(id)},{label:'بازنشانی cooldown / Reset cooldown',action:'cooluser',id:String(id)}];
  if(ownerIds(r.env).includes(u.id))buttons.push({label:x.admin?'حذف مدیر / Revoke admin':'افزودن مدیر / Grant admin',action:'setadmin',id:String(id)+'~'+(x.admin?'0':'1')});
  buttons.push({label:'🔙 کاربران / Users',action:'users'});
  return send(r,u,`${x.id}\n${x.name} @${x.username}\nWallet: ${x.balance}\nAdmin: ${x.admin}; banned: ${x.banned}\nCreated: ${stamp(x.created_at)}\nActive: ${stamp(x.last_at)}`,buttons);
}
async function adminSubs(r,u,userId) {
  const rows=await r.all('SELECT id,name,status FROM nx_subs WHERE user_id=? ORDER BY created_at DESC LIMIT 8',Number(userId));
  return send(r,u,'اشتراک‌های کاربر / User subscriptions',[...rows.map(s=>({label:s.name+' '+s.status,action:'admsub',id:s.id})),{label:'مدیریت / Admin',action:'admin'}]);
}
async function adminSubView(r,u,id) {
  const s=await r.first('SELECT * FROM nx_subs WHERE id=?',id);if(!s)fail('subscription_not_found');
  return send(r,u,`${id}\nUser: ${s.user_id}; node: ${s.node_id}\n${s.status}; expiry: ${stamp(s.expires_at)}`,[{label:'توقف/ادامه / Pause/resume',action:'subtoggle',id},{label:'افزودن روز / Extend days',action:'subextend',id},{label:'صفرکردن مصرف / Reset usage',action:'subreset',id},{label:'حذف حساب / Delete account',action:'subdelete',id},{label:'به‌روزرسانی کانفیگ پایه / Refresh transports',action:'subrefresh',id},{label:'مدیریت / Admin',action:'admin'}]);
}
async function adminSubAction(r,actor,id,action,nonce) {
  const s=await r.first('SELECT * FROM nx_subs WHERE id=?',id);if(!s?.node_id)fail('unmapped_subscription');const n=await r.first('SELECT * FROM nx_nodes WHERE id=?',s.node_id);
  const release=await nodeLease(r,n);
  try{
    const receipt='admin-control:'+nonce;
    const claimed=await r.run('INSERT OR IGNORE INTO nx_panel_requests(key,user_id,action,created_at) VALUES(?,?,?,?)',receipt,s.remote_id,'control_pending',now());
    if(!changes(claimed)){const old=await r.first('SELECT action FROM nx_panel_requests WHERE key=?',receipt);if(old?.action==='control_done')return;fail('manual_node_action_uncertain_verify_node',409);}
    if(action==='delete'){
      try{await nodeRequest(r,n,'DELETE',s.remote_id);}catch(e){if(e.status!==404)throw e;}
      await r.run('UPDATE nx_subs SET status=? WHERE id=?','deleted',id);
    }else if(action==='reset')await nodeRequest(r,n,'POST',s.remote_id,null,'reset','admin-effect:'+nonce);
    else{
      const current=normalizeRemoteUser((await nodeRequest(r,n,'GET',s.remote_id)).user);
      if(n.adapter==='nexiup')await nodeRequest(r,n,'PUT',s.remote_id,{isPaused:!current.isPaused});
      else await nodeRequest(r,n,'POST',s.remote_id,null,'toggle');
      await r.run('UPDATE nx_subs SET status=? WHERE id=?',current.isPaused?'active':'paused',id);
    }
    await r.run('UPDATE nx_panel_requests SET action=? WHERE key=?','control_done','admin-control:'+nonce);
    await audit(r,actor,'subscription_'+action,id);
  }finally{await release();}
}
async function walletMenu(r,u) {
  const x=await r.first('SELECT balance FROM nx_users WHERE id=?',u.id),bot=await setting(r,'bot');
  return send(r,u,`${t(u,'موجودی کیف پول','Wallet balance')}: ${x.balance} ${bot.currency}`,[{label:t(u,'افزایش موجودی','Top up'),action:'topup'},{label:t(u,'درخواست برداشت','Request withdrawal'),action:'withdraw'},{label:t(u,'تاریخچه','History'),action:'ledger'},back(u)]);
}
async function walletHistory(r,u,cursor=0) {
  const rows=await r.all('SELECT * FROM nx_ledger WHERE user_id=? AND created_at>? ORDER BY created_at LIMIT 9',u.id,Number(cursor)||0);
  const text=rows.slice(0,8).map(x=>`${stamp(x.created_at)} • ${x.kind}\n${x.amount>0?'+':''}${x.amount}; ${t(u,'مانده','Balance')}: ${x.balance_after}`).join('\n\n')||'—';
  return send(r,u,text,[...(rows.length>8?[{label:t(u,'بعدی','Next'),action:'ledger',id:String(rows[7].created_at)}]:[]),back(u)]);
}
async function applyCoupon(r,userId,orderId,code) {
  const raw=await catalogItem(r,'coupons',code.toUpperCase());if(!raw?.enabled)fail('invalid_coupon');const {version,...c}=raw;validateCatalog('coupons',c);
  const order=await r.first('SELECT * FROM nx_orders WHERE id=? AND user_id=? AND status=?',orderId,userId,'pending_payment');if(!order||order.wallet_paid)fail('coupon_before_payment_only');
  const original=parse(order.snapshot).price;const discount=c.type==='percent'?Math.floor(original*c.value/100):Math.min(original,c.value);
  if(original<c.minimum||(c.expires_at&&c.expires_at<=now()))fail('coupon_not_applicable');
  const out=await r.batch([
    [`INSERT OR IGNORE INTO nx_coupon_uses(order_id,coupon_id,user_id,discount,created_at) SELECT ?,?,?,?,? WHERE (?=0 OR (SELECT COUNT(*) FROM nx_coupon_uses WHERE coupon_id=?)<?) AND (SELECT COUNT(*) FROM nx_coupon_uses WHERE coupon_id=? AND user_id=?)<? AND EXISTS(SELECT 1 FROM nx_orders WHERE id=? AND user_id=? AND status='pending_payment' AND wallet_paid=0)`,orderId,c.id,userId,discount,now(),c.max_uses,c.id,c.max_uses,c.id,userId,c.per_user,orderId,userId],
    [`UPDATE nx_orders SET total=?-(SELECT discount FROM nx_coupon_uses WHERE order_id=?),status=CASE WHEN ?-(SELECT discount FROM nx_coupon_uses WHERE order_id=?)=0 THEN 'pending' ELSE 'pending_payment' END WHERE id=? AND user_id=? AND status='pending_payment' AND wallet_paid=0 AND EXISTS(SELECT 1 FROM nx_coupon_uses WHERE order_id=?)`,original,orderId,original,orderId,orderId,userId,orderId]
  ]);
  if(!changes(out[0]))fail('coupon_already_used_or_exhausted');
  return r.first('SELECT * FROM nx_orders WHERE id=?',orderId);
}
async function requestWithdrawal(r,userId,amount,destination,id) {
  number(amount,1,1e12,true);string(destination,500,10);const s=await setting(r,'bot');if(amount<s.min_withdrawal)fail('below_min_withdrawal');
  await r.batch([
    [`INSERT OR IGNORE INTO nx_withdrawals(id,user_id,amount,destination,status,created_at) SELECT ?,?,?,?,'pending',? FROM nx_users WHERE id=? AND balance>=?`,id,userId,amount,destination,now(),userId,amount],
    [`INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) SELECT ?,user_id,-amount,'withdrawal',id,? FROM nx_withdrawals WHERE id=? AND status='pending'`,'withdraw:'+id,now(),id]
  ]);
  const result=await r.first('SELECT * FROM nx_withdrawals WHERE id=?',id);if(!result)fail('insufficient_balance');
  await notifyAdmins(r,'withdraw:'+id,`💸 ${id}: ${amount}`, [{label:'برداشت‌ها / Withdrawals',action:'withdrawals'}]);return result;
}
async function decideWithdrawal(r,actor,id,approve,reason='') {
  await r.batch([
    ["UPDATE nx_withdrawals SET status=?,reason=? WHERE id=? AND status='pending'",approve?'done':'rejected',reason,id],
    [`INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) SELECT ?,user_id,amount,'withdraw_refund',id,? FROM nx_withdrawals WHERE id=? AND status='rejected'`,'withdraw-refund:'+id,now(),id],
    auditStmt(actor,approve?'withdrawal_paid':'withdrawal_rejected',id)
  ]);
  const w=await r.first('SELECT * FROM nx_withdrawals WHERE id=?',id);
  if(w&&['done','rejected'].includes(w.status))await enqueue(r,'withdraw-decision:'+id,w.user_id,'text',{text:`${w.status==='done'?'✅':'❌'} ${id}\n${w.status==='done'?'تسویه انجام شد / Withdrawal paid':(w.reason||'')+'\nمبلغ به کیف پول برگشت / Wallet refunded'}`});
}
async function supportRequest(r,u,text,id) {
  string(text,2500,1);await rate(r,'support:'+u.id,30000);
  await r.batch([
    ['INSERT OR IGNORE INTO nx_tickets(id,user_id,status,created_at) VALUES(?,?,?,?)',id,u.id,'open',now()],
    ['INSERT OR IGNORE INTO nx_messages(id,ticket_id,sender,text,created_at) VALUES(?,?,?,?,?)',id,id,u.id,text,now()]
  ]);
  await notifyAdmins(r,'ticket:'+id,`📩 ${id}\n${u.name} (${u.id})\n${text}`,[{label:'پاسخ / Reply',action:'ticketreply',id}]);
  return send(r,u,t(u,`تیکت ${id} ثبت شد.`,`Ticket ${id} created.`),[back(u)]);
}
async function getStats(r,period='today') {
  if(!['today','7d','30d','all'].includes(period))fail('invalid_stats_period');
  const start=period==='all'?0:period==='7d'?now()-7*DAY:period==='30d'?now()-30*DAY:now()-(now()%DAY);
  const rows=await r.batch([
    ['SELECT COUNT(*) AS total,SUM(created_at>=?) AS new_in_period,SUM(last_at>=?) AS active_in_period,SUM(banned) AS banned,SUM(balance) AS balances FROM nx_users',start,start],
    ["SELECT COUNT(*) AS done,COALESCE(SUM(total),0) AS revenue FROM nx_orders WHERE kind='sale' AND status='done' AND created_at>=?",start],
    ["SELECT COUNT(*) AS grants FROM nx_test_grants WHERE status='granted'"],
    ['SELECT n.id,n.label,n.max_users,COUNT(s.id) AS active FROM nx_nodes n LEFT JOIN nx_subs s ON s.node_id=n.id AND s.status=? AND s.expires_at>? GROUP BY n.id LIMIT 10','active',now()],
    ["SELECT plan_id,COUNT(*) AS orders,SUM(total) AS revenue FROM nx_orders WHERE kind='sale' AND status='done' AND created_at>=? GROUP BY plan_id ORDER BY orders DESC LIMIT 3",start],
    ['SELECT channel,status,COUNT(*) AS users FROM nx_members GROUP BY channel,status LIMIT 6']
  ]);
  return {period,users:rows[0].results[0],sales:rows[1].results[0],tests:rows[2].results[0],nodes:rows[3].results,top_plans:rows[4].results,channel_membership:rows[5].results};
}
async function cloudflareUsage(r) {
  const {CF_ACCOUNT_ID,CF_API_TOKEN}=r.env;if(!CF_ACCOUNT_ID||!CF_API_TOKEN)return {configured:false,limit:100000};
  if(!/^[a-f0-9]{32}$/i.test(CF_ACCOUNT_ID))fail('invalid_cf_account_id');
  const start=new Date(now()).toISOString().slice(0,10)+'T00:00:00Z',end=new Date(now()).toISOString();
  const query='query($account:String!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$account}){workersInvocationsAdaptive(limit:1,filter:{datetime_geq:$start,datetime_leq:$end}){sum{requests}}}}}';
  const res=await r.fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:'Bearer '+CF_API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{account:CF_ACCOUNT_ID,start,end}})});
  const d=parse(await res.text());if(!res.ok||d?.errors?.length||!d?.data?.viewer?.accounts?.length)fail('cloudflare_analytics_unavailable',502);
  const requests=d.data.viewer.accounts[0].workersInvocationsAdaptive.reduce((n,x)=>n+Number(x.sum.requests||0),0);
  return {configured:true,requests,limit:100000,percent:requests/1000,scope:'account',note:'Adaptive analytics estimate; delayed/sampled, not a billing ledger.'};
}

// ---------------- Durable delivery queue; Telegram can be at-least-once, issuance cannot ----------------
async function queueFallback(r,userId,subId,key) {
  const s=await ownedSub(r,userId,subId);
  if(s.status!=='active'||s.expires_at<=now())fail('subscription_inactive');
  const id='fallback:'+key;
  if(await r.first('SELECT id FROM nx_jobs WHERE id=? AND user_id=?',id,userId))return id;
  await rate(r,'fallback:'+userId,60000);
  const limits=parse(s.limits);
  const variants=limits.legacy_config?null:aggregate(parse(s.bases,[]),await profiles(r));
  // Freeze a complete delivery snapshot: a mid-batch admin edit cannot omit/repeat a variant.
  await enqueue(r,id,userId,'fallback',{sub_id:subId,configs:variants?variants.map(v=>({label:v.label,text:JSON.stringify(xrayConfig(v))})):[{label:'Legacy manual / اشتراک دستی قدیمی',text:limits.legacy_config}]});return id;
}
async function jobSteps(r,job,u) {
  const d=parse(job.data);
  if(job.kind==='text')return [{method:'sendMessage',payload:{chat_id:u.id,text:(d.notice?(await customText(r,u,d.notice,''))+'\n':'')+d.text,reply_markup:await markup(r,u.id,d.buttons||[]),link_preview_options:{is_disabled:true}}}];
  if(job.kind==='document')return [{document:d.content,filename:d.filename,caption:d.caption||''}];
  if(job.kind==='receipt') {
    const o=await r.first('SELECT * FROM nx_orders WHERE id=?',d.order_id);if(!o)return [];
    const rec=parse(o.receipt,{type:'text',note:'Wallet payment'});
    const text=`🧾 ${o.id}\nUser: ${o.user_id}\nTotal: ${o.total}; wallet: ${o.wallet_paid}; manual: ${o.total-o.wallet_paid}\n${parse(o.snapshot).name||'Top-up'}\n${rec.note||''}`;
    const kb=await markup(r,u.id,[{label:'✅ تأیید / Approve',action:'approve',id:o.id},{label:'❌ رد با علت / Reject',action:'reject',id:o.id}]);
    if(rec.file_id){const photo=rec.type==='photo';return [{method:photo?'sendPhoto':'sendDocument',payload:{chat_id:u.id,[photo?'photo':'document']:rec.file_id,caption:text.slice(0,1000),reply_markup:kb}}];}
    return [{method:'sendMessage',payload:{chat_id:u.id,text,reply_markup:kb}}];
  }
  if(job.kind==='subscription') {
    const s=await ownedSub(r,u.id,d.sub_id),bot=await setting(r,'bot');
    if(s.status==='deleted')return [];
    const url=mainSubscriptionUrl(bot,s.token),lim=parse(s.limits);
    const kb=await markup(r,u.id,[{label:'باز نشد؟ کانفیگ‌ها ارسال شوند',action:'fallback',id:s.id},{label:t(u,'راهنمای اتصال','Import guide'),action:'guides'}]);
    const approved=await customText(r,u,'approved',lim.test?t(u,'🧪 تست شما صادر شد.','🧪 Your test is issued.'):t(u,'✅ اشتراک آماده است.','✅ Subscription ready.'));
    return [
      {photo:url,caption:url,reply_markup:kb},
      {method:'sendMessage',payload:{chat_id:u.id,text:`${approved}\n${limitsText(u,lim)}\n${t(u,'انقضا','Expiry')}: ${stamp(s.expires_at)}\n${lim.reset_usage?t(u,'در این تمدید شمارنده مصرف صفر شد.','This renewal resets the usage counter.'):t(u,'شمارنده مصرف در تمدید حفظ می‌شود.','Usage is retained on renewal.')}\n\n${u.lang==='en'?bot.guides_en:bot.guides_fa}`,reply_markup:kb,link_preview_options:{is_disabled:true}}}
    ];
  }
  if(job.kind==='fallback') {
    const s=await ownedSub(r,u.id,d.sub_id);if(s.status!=='active'||s.expires_at<=now())return [];
    const steps=[];
    for(const c of d.configs){
      const hint=t(u,'ورود: JSON کامل را کپی و در کلاینت Xray سازگار وارد کنید.','Import: copy this complete JSON into a compatible Xray client.');
      const full=c.label+'\n'+hint+'\n'+c.text;
      if(full.length<=4096)steps.push({method:'sendMessage',payload:{chat_id:u.id,text:full,entities:[{type:'pre',offset:full.length-c.text.length,length:c.text.length,language:'json'}],link_preview_options:{is_disabled:true}}});
      else {
        const parts=safeConfigParts(c.text);
        steps.push({method:'sendMessage',payload:{chat_id:u.id,text:`${c.label}\n${hint}\n${t(u,`${parts.length} پیام خام بعدی را بدون فاصله یا خط جدید به هم بچسبانید. فایل کامل نیز ضمیمه می‌شود.`,`Join the next ${parts.length} raw messages without separators or newlines. An intact file is also attached.`)}`}});
        for(const text of parts)steps.push({method:'sendMessage',payload:{chat_id:u.id,text}});
        steps.push({document:c.text,filename:'nexiup-config.json',caption:c.label});
      }
    }
    return steps;
  }
  fail('unknown_delivery_job');
}
async function sendStep(r,u,step) {
  if(step.photo){
    const form=new FormData();form.set('chat_id',String(u.id));form.set('photo',new Blob([qrPng(step.photo)],{type:'image/png'}),'nexiup-qr.png');form.set('caption',step.caption);form.set('reply_markup',JSON.stringify(step.reply_markup));
    return telegram(r,'sendPhoto',form,true);
  }
  if(step.document!==undefined){const form=new FormData();form.set('chat_id',String(u.id));form.set('document',new Blob([step.document],{type:'application/json'}),step.filename);form.set('caption',step.caption);return telegram(r,'sendDocument',form,true);}
  return telegram(r,step.method,step.payload);
}
async function processJob(r,id,maxSteps=2) {
  const release=await lock(r,'job:'+id);
  try {
    const job=await r.first('SELECT * FROM nx_jobs WHERE id=?',id);if(!job||job.status!=='queued'||job.due>now())return;
    const u=await r.first('SELECT * FROM nx_users WHERE id=?',job.user_id)||{id:job.user_id,lang:'fa'};
    // Privileged receipt/review delivery must not outlive removal of that admin's access.
    if(job.kind==='receipt'&&!await isAdmin(r,u.id)){await r.run("UPDATE nx_jobs SET status='done' WHERE id=?",id);return;}
    const steps=await jobSteps(r,job,u);
    let cursor=job.cursor;
    for(let sent=0;cursor<steps.length&&sent<maxSteps;cursor++,sent++){
      if(sent)await new Promise(resolve=>setTimeout(resolve,1050)); // per-chat Telegram rate discipline
      try{await sendStep(r,u,steps[cursor]);}
      catch(e){
        if(e.code==='telegram_blocked'){await r.batch([['UPDATE nx_users SET blocked=1 WHERE id=?',u.id],['UPDATE nx_jobs SET status=? WHERE id=?','blocked',id]]);return;}
        await r.run('UPDATE nx_jobs SET due=? WHERE id=?',now()+(e.retry||60)*1000,id);return;
      }
      await r.run('UPDATE nx_jobs SET cursor=? WHERE id=?',cursor+1,id);
    }
    if(cursor>=steps.length)await r.run('UPDATE nx_jobs SET status=? WHERE id=?','done',id);
  }finally{await release();}
}

const ADMIN_ACTIONS=new Set(['admin','manage','managepage','edit','apply','rollback','nodetest','channeltest','resetcool','cooluser','orders','review','approve','reject','ops','opview','retryop','absentop','resetdone','confirmop','users','userview','usersearch','ban','balance','directmsg','usersubs','setadmin','admsub','subtoggle','subextend','subreset','subdelete','subconfirm','subrefresh','grants','withdrawals','wdview','wdapprove','wdreject','broadcast','bcstart','bcstop','stats','usage','diagnostics','audit','backup','exportkind','ticketreply']);
async function handleAction(r,u,action,id,key) {
  if(ADMIN_ACTIONS.has(action)&&!await isAdmin(r,u.id))fail('admin_required',403);
  if(action==='lang'){if(!['fa','en'].includes(id))fail('invalid_language');await r.run('UPDATE nx_users SET lang=? WHERE id=?',id,u.id);u.lang=id;return u.terms_at?home(r,u):showTerms(r,u);}
  if(action==='terms'){await r.run('UPDATE nx_users SET terms_at=? WHERE id=?',now(),u.id);u.terms_at=now();return home(r,u);}
  if(action==='rules')return showTerms(r,u);
  if(!u.terms_at&&!ADMIN_ACTIONS.has(action))return showTerms(r,u);
  if(action==='home'){await clearState(r,u.id);return home(r,u);}
  if(action==='admin'){await clearState(r,u.id);return adminMenu(r,u);}
  if(action==='join'){for(const k of cache(r).keys())if(k.startsWith(`member:${u.id}:`))cache(r).delete(k);return (await membership(r,u))?home(r,u):undefined;}
  if(['shop','location','plan','buy','test','renew'].includes(action)){
    const bot=await setting(r,'bot');if(bot.maintenance&&!await isAdmin(r,u.id))return send(r,u,t(u,'خرید و تست در حالت نگهداری است؛ اشتراک و پشتیبانی در دسترس‌اند.','Sales/tests are under maintenance; subscriptions and support remain available.'),[back(u)]);
    if(!await isAdmin(r,u.id)&&!await membership(r,u))return;
  }
  if(action==='shop')return shop(r,u);
  if(action==='location'){const [location,cursor='']=id.split('~');return shop(r,u,location,cursor);}
  if(action==='plan'){const [p,l]=id.split('~');return planView(r,u,p,l);}
  if(action==='buy'){const [p,l]=id.split('~');return invoice(r,u,await createOrder(r,u,p,l,key));}
  if(action==='paywallet'||action==='paysplit')return invoice(r,u,await walletPay(r,u.id,id,action==='paysplit'));
  if(action==='paymethods'){
    const o=await r.first('SELECT * FROM nx_orders WHERE id=? AND user_id=?',id,u.id);if(!o||o.status!=='pending_payment')fail('order_not_payable');
    const methods=await catalog(r,'payments');return send(r,u,t(u,'روش پرداخت را انتخاب کنید:','Choose a payment method:'),[...methods.map(p=>({label:p.name,action:'payment',id:id+'~'+p.id})),back(u)]);
  }
  if(action==='payment'){
    const [oid,pid]=id.split('~'),o=await r.first('SELECT * FROM nx_orders WHERE id=? AND user_id=?',oid,u.id),pm=await catalogItem(r,'payments',pid);
    if(!o||o.status!=='pending_payment'||!pm?.enabled)fail('order_or_payment_unavailable');
    await state(r,u.id,'receipt',{order_id:oid,method_id:pid});const bot=await setting(r,'bot');
    return send(r,u,`${await customText(r,u,'payment','')}\n${pm.name}\n${pm.details}\n${pm.instructions}\n\n${t(u,'مبلغ','Amount')}: ${o.total-o.wallet_paid} ${bot.currency}\n${t(u,'عکس رسید یا سند یا کد پیگیری را همین‌جا بفرستید.','Send a receipt photo, document or transfer reference here.')}`,[back(u)]);
  }
  if(action==='cancelorder'){await finishOrder(r,id,'cancelled',t(u,'لغو توسط کاربر','Cancelled by customer'),u.id);return home(r,u);}
  if(action==='coupon'){await state(r,u.id,'coupon',{order_id:id});return send(r,u,t(u,'کد تخفیف را بفرستید:','Send the discount code:'),[back(u)]);}
  if(action==='subs')return listSubs(r,u,id==='0'?'':id);
  if(action==='subview')return subView(r,u,id);
  if(action==='subusage'){await rate(r,'usage:'+u.id,15000);return usageSub(r,u,id);}
  if(action==='fallback'){
    const jid=await queueFallback(r,u.id,id,key);await send(r,u,t(u,'کانفیگ‌های کامل، هرکدام در یک پیام، در صف ارسال قرار گرفتند.','Full configurations are queued, one configuration per message.'),[back(u)]);
    if(r.queries<22)await processJob(r,jid,1);return;
  }
  if(action==='deliver'){await ownedSub(r,u.id,id);await rate(r,'redeliver:'+u.id,60000);await enqueue(r,'redeliver:'+key,u.id,'subscription',{sub_id:id});return send(r,u,t(u,'QR و لینک در صف ارسال است.','QR and URL queued.'),[back(u)]);}
  if(action==='test'){
    await rate(r,'test-request:'+u.id,10000);
    const s=await setting(r,'test');const op=await requestTest(r,u.id,key);
    const testNotice=await customText(r,u,'test','');
    await send(r,u,testNotice+'\n'+t(u,`🧪 صدور خودکار در صف است. ${s.traffic_gb} GiB، ${s.days} روز؛ فاصله از صدور موفق: ${s.cooldown_hours} ساعت.`,`🧪 Automatic issuance queued. ${s.traffic_gb} GiB, ${s.days} day(s); cooldown ${s.cooldown_hours} hours from successful issuance.`),[back(u)]);
    // Provision in cron, a separate invocation: avoids QR/migration/node work exceeding 10 ms/50 queries.
    return op;
  }
  if(action==='renew'){
    const s=await ownedSub(r,u.id,id),limits=parse(s.limits);if(limits.test||!limits.plan_id||!s.node_id)fail('test_or_legacy_not_renewable');
    const p=await catalogItem(r,'plans',limits.plan_id);if(!p?.enabled)fail('renewal_plan_unavailable');const node=await r.first('SELECT code FROM nx_nodes WHERE id=?',s.node_id);
    const order=await createOrder(r,u,limits.plan_id,node.code,key,id);
    await send(r,u,t(u,`تمدید از بیشینه «اکنون، انقضای فعلی» محاسبه می‌شود. ${p.reset_usage?'پس از تأیید، مصرف صفر می‌شود.':'مصرف قبلی حفظ می‌شود؛ سهمیه به مقدار پلن تنظیم می‌شود.'}`,`Renewal extends from max(now, current expiry). ${p.reset_usage?'Usage will reset after approval.':'Existing usage is retained; the quota is set to this plan.'}`));
    return invoice(r,u,order);
  }
  if(action==='guides'){
    const bot=await setting(r,'bot'),docs=await catalog(r,'guides');return send(r,u,u.lang==='en'?bot.guides_en:bot.guides_fa,[...docs.map(g=>({label:u.lang==='en'?g.title_en:g.title,action:'guide',id:g.id})),back(u)]);
  }
  if(action==='guide'){const g=await catalogItem(r,'guides',id);if(!g?.enabled)fail('guide_unavailable');return send(r,u,u.lang==='en'?g.text_en:g.text,[back(u)]);}
  if(action==='wallet')return walletMenu(r,u);
  if(action==='ledger')return walletHistory(r,u,id);
  if(action==='topup'){await state(r,u.id,'topup');return send(r,u,t(u,'مبلغ شارژ را به واحد پول ربات به صورت عدد بفرستید.','Send a numeric top-up amount in the bot currency.'),[back(u)]);}
  if(action==='withdraw'){await state(r,u.id,'withdraw_amount');return send(r,u,t(u,'مبلغ برداشت را بفرستید.','Send the withdrawal amount.'),[back(u)]);}
  if(action==='referral'){
    const bot=await setting(r,'bot'),n=(await r.first('SELECT COUNT(*) AS n FROM nx_users WHERE referrer=?',u.id)).n,earn=(await r.first("SELECT COALESCE(SUM(amount),0) AS n FROM nx_ledger WHERE user_id=? AND kind='referral'",u.id)).n;
    if(!bot.bot_username)fail('run_webhook_setup_first');return send(r,u,`${t(u,'نرخ معرفی','Referral rate')}: ${bot.referral_percent}%\n${t(u,'دعوت‌شده / درآمد','Invited / earnings')}: ${n} / ${earn}\nhttps://t.me/${bot.bot_username}?start=ref_${u.id}`,[back(u)]);
  }
  if(action==='support'){await state(r,u.id,'support');const bot=await setting(r,'bot');return send(r,u,await customText(r,u,'support',t(u,'پیام پشتیبانی را اینجا بنویسید.','Write your support message here.'))+(bot.support?'\n'+bot.support:''),[back(u)]);}
  if(action==='manage')return manage(r,u,id);
  if(action==='managepage'){const [k,c]=id.split('~');return manage(r,u,k,c);}
  if(action==='edit'){const [k,i]=id.split('~');return beginEdit(r,u,k,i);}
  if(action==='apply'){
    const s=await r.first('SELECT * FROM nx_states WHERE user_id=? AND step=? AND expires_at>?',u.id,'admin:confirm',now());if(!s)fail('preview_expired');const d=parse(s.data);
    if(d.nonce!==id)fail('stale_preview');await applyEdit(r,u.id,d.kind,d.doc,d.version);await clearState(r,u.id);return send(r,u,t(u,'✅ ذخیره و فعال شد. کش پاسخ‌ها حداکثر ۱۵ ثانیه است.','✅ Saved. Existing subscription responses update within 15 seconds.'),[{label:'مدیریت / Admin',action:'admin'}]);
  }
  if(action==='rollback'){await rollbackProfile(r,u.id,id);return send(r,u,'✅ نسخه قبلی با شماره جدید فعال شد / Previous profile restored as a new revision',[{label:'مدیریت / Admin',action:'admin'}]);}
  if(action==='nodetest')return nodeHealth(r,u,id);
  if(action==='channeltest'){const c=await catalogItem(r,'channels',id);if(!c)fail('channel_missing');const me=await telegram(r,'getMe',{});const m=await telegram(r,'getChatMember',{chat_id:c.chat_id,user_id:me.id});await audit(r,u.id,'channel_test',id,{status:m.status});return send(r,u,`${c.title}: ${m.status}. ${t(u,'ربات باید ادمین باشد.','Bot must be an administrator.')}`,[{label:'مدیریت / Admin',action:'admin'}]);}
  if(action==='resetcool'){await state(r,u.id,'admin:cooldown');return send(r,u,'شناسه عددی کاربر را بفرستید / Send numeric user ID');}
  if(action==='cooluser'){await resetTestCooldown(r,u.id,number(Number(id),1,Number.MAX_SAFE_INTEGER,true));return userView(r,u,id);}
  if(action==='orders')return ordersMenu(r,u,id==='0'?'':id);
  if(action==='review')return reviewOrder(r,u,id);
  if(action==='approve'){const o=await approveOrder(r,u.id,id);return send(r,u,`✅ ${id}: ${o.status}\n${t(u,'صدور و تحویل خودکار از صف انجام می‌شود.','Provisioning and delivery proceed automatically from the queue.')}`,[{label:'عملیات / Operations',action:'ops'}]);}
  if(action==='reject'){await state(r,u.id,'admin:reject',{id});return send(r,u,'علت رد را بفرستید / Send rejection reason');}
  if(action==='ops')return operationsMenu(r,u,id==='0'?'':id);
  if(action==='opview')return operationView(r,u,id);
  if(action==='retryop'){await retryOp(r,u.id,id);return send(r,u,'در صف تلاش / Retry queued',[{label:'عملیات / Operations',action:'ops'}]);}
  if(action==='absentop'||action==='resetdone'){
    await state(r,u.id,'admin:opconfirm',{id,mode:action==='absentop'?'absent':'reset',nonce:key});
    return send(r,u,t(u,'فقط پس از بررسی مستقل نود تأیید کنید. نبودن نتیجه در GET ممکن است ناشی از کش باشد. تکرار اشتباه می‌تواند حساب یا reset تکراری بسازد.','Confirm only after independent node inspection. A missing GET may be stale. Incorrect confirmation can duplicate an account/reset.'),[{label:'تأیید بررسی مستقل / I independently verified',action:'confirmop',id:key},{label:'لغو / Cancel',action:'ops'}]);
  }
  if(action==='confirmop'){const s=await r.first('SELECT * FROM nx_states WHERE user_id=? AND step=? AND expires_at>?',u.id,'admin:opconfirm',now());const d=parse(s?.data);if(d?.nonce!==id)fail('confirmation_expired');await retryOp(r,u.id,d.id,d.mode);await clearState(r,u.id);return operationsMenu(r,u);}
  if(action==='users')return usersMenu(r,u,id);
  if(action==='userview')return userView(r,u,id);
  if(action==='usersearch'){await state(r,u.id,'admin:search');return send(r,u,'شناسه یا @username را بفرستید / Send user ID or @username');}
  if(action==='ban'){const [uid,desired]=id.split('~');number(Number(uid),1,Number.MAX_SAFE_INTEGER,true);number(Number(desired),0,1,true);if(ownerIds(r.env).includes(Number(uid)))fail('cannot_ban_owner');await r.batch([['UPDATE nx_users SET banned=? WHERE id=?',Number(desired),Number(uid)],auditStmt(u.id,'user_ban_changed',uid,{banned:Number(desired)})]);return userView(r,u,uid);}
  if(action==='balance'||action==='directmsg'){await state(r,u.id,'admin:'+action,{id:Number(id),key});return send(r,u,action==='balance'?'مقدار عددی تغییر، مثبت یا منفی / Numeric signed balance adjustment':'متن پیام را بفرستید / Send message text');}
  if(action==='usersubs')return adminSubs(r,u,id);
  if(action==='setadmin'){
    const [uid,desired]=id.split('~');number(Number(uid),1,Number.MAX_SAFE_INTEGER,true);number(Number(desired),0,1,true);
    if(!ownerIds(r.env).includes(u.id)||ownerIds(r.env).includes(Number(uid)))fail('owner_only',403);
    const admins=await adminIds(r);if(admins.length>=5&&!admins.includes(Number(uid))&&desired==='1')fail('max_five_admins');
    await r.batch([['UPDATE nx_users SET admin=? WHERE id=?',Number(desired),Number(uid)],auditStmt(u.id,'admin_access_changed',uid,{admin:Number(desired)})]);return userView(r,u,uid);
  }
  if(action==='admsub')return adminSubView(r,u,id);
  if(action==='subrefresh'){const sub=await r.first('SELECT * FROM nx_subs WHERE id=?',id);if(!sub?.node_id)fail('unmapped_subscription');const n=await r.first('SELECT * FROM nx_nodes WHERE id=?',sub.node_id);const user=normalizeRemoteUser((await nodeRequest(r,n,'GET',sub.remote_id)).user);if(user.id!==sub.remote_id)fail('node_identity_mismatch');const bases=await baseConfigs(r,n,user);await r.batch([['UPDATE nx_subs SET bases=? WHERE id=?',JSON.stringify(bases),id],auditStmt(u.id,'base_configs_refreshed',id)]);return adminSubView(r,u,id);}
  if(action==='subextend'){await state(r,u.id,'admin:extend',{id,key});return send(r,u,'تعداد روز افزوده را بفرستید؛ مصرف حفظ می‌شود. / Send extra days; usage is retained.');}
  if(['subtoggle','subreset','subdelete'].includes(action)){
    await state(r,u.id,'admin:subconfirm',{id,action:action==='subtoggle'?'toggle':action==='subreset'?'reset':'delete',nonce:key});return send(r,u,'تأیید اقدام روی حساب نود؟ / Confirm node-account operation?',[{label:'تأیید / Confirm',action:'subconfirm',id:key},{label:'لغو / Cancel',action:'admin'}]);
  }
  if(action==='subconfirm'){const s=await r.first('SELECT * FROM nx_states WHERE user_id=? AND step=? AND expires_at>?',u.id,'admin:subconfirm',now());const d=parse(s?.data);if(d?.nonce!==id)fail('confirmation_expired');await adminSubAction(r,u.id,d.id,d.action,d.nonce);await clearState(r,u.id);return adminMenu(r,u);}
  if(action==='grants'){
    const rows=await r.all('SELECT * FROM nx_test_grants WHERE op_id>? ORDER BY op_id LIMIT 9',id==='0'?'':id);
    return send(r,u,rows.slice(0,8).map(x=>`${x.op_id}: ${x.user_id} — ${x.status}\n${x.node_id}; ${stamp(x.granted_at)}; ${x.error||''}`).join('\n\n')||'—',[...(rows.length>8?[{label:'بعدی / Next',action:'grants',id:rows[7].op_id}]:[]),{label:'مدیریت / Admin',action:'admin'}]);
  }
  if(action==='withdrawals'){
    const rows=await r.all("SELECT * FROM nx_withdrawals WHERE status='pending' ORDER BY created_at LIMIT 8");return send(r,u,'برداشت‌های معلق / Pending withdrawals',[...rows.map(w=>({label:`${w.id}: ${w.amount}`,action:'wdview',id:w.id})),{label:'مدیریت / Admin',action:'admin'}]);
  }
  if(action==='wdview'){const w=await r.first('SELECT * FROM nx_withdrawals WHERE id=?',id);if(!w)fail('withdrawal_not_found');return send(r,u,`${id}\n${w.user_id}: ${w.amount}\n${w.destination}\n${w.status}`,[{label:'واریز شد / Paid',action:'wdapprove',id},{label:'رد با علت / Reject',action:'wdreject',id},{label:'مدیریت / Admin',action:'admin'}]);}
  if(action==='wdapprove'){await decideWithdrawal(r,u.id,id,true);return adminMenu(r,u);}
  if(action==='wdreject'){await state(r,u.id,'admin:wdreject',{id});return send(r,u,'علت رد را بنویسید / Write rejection reason');}
  if(action==='broadcast'){
    const running=await r.first("SELECT * FROM nx_broadcasts WHERE status='queued' ORDER BY created_at LIMIT 1");
    return send(r,u,(running?`${running.id}: sent=${running.sent}; failed=${running.failed}\n`:'')+'مخاطبان / Audience',[...['all','buyers','non_buyers','active_30d'].map(x=>({label:x,action:'bcstart',id:x})),...(running?[{label:'توقف / Stop',action:'bcstop',id:running.id}]:[]),{label:'مدیریت / Admin',action:'admin'}]);
  }
  if(action==='bcstart'){if(!['all','buyers','non_buyers','active_30d'].includes(id))fail('invalid_broadcast_segment');await state(r,u.id,'admin:broadcast',{segment:id,key});return send(r,u,'متن همگانی ساده را بفرستید (بدون HTML) / Send plain-text broadcast (no HTML)');}
  if(action==='bcstop'){await r.batch([['UPDATE nx_broadcasts SET status=? WHERE id=?','cancelled',id],auditStmt(u.id,'broadcast_cancelled',id)]);return adminMenu(r,u);}
  if(action==='stats')return send(r,u,JSON.stringify(await getStats(r,id==='0'?'today':id),null,2),[...['today','7d','30d','all'].map(p=>({label:p,action:'stats',id:p})),{label:'مدیریت / Admin',action:'admin'}]);
  if(action==='diagnostics'){
    const started=now();await r.first('SELECT 1 AS ok');const d1_read_wall_ms=now()-started;
    const hook=await telegram(r,'getWebhookInfo',{}),bot=await setting(r,'bot');
    const operations=await r.all('SELECT state,COUNT(*) AS count FROM nx_ops GROUP BY state LIMIT 10'),deliveries=await r.all('SELECT status,COUNT(*) AS count FROM nx_jobs GROUP BY status LIMIT 10');
    return send(r,u,JSON.stringify({version:VERSION,role:getRole(r.env),d1_read_wall_ms,webhook:{configured:!!hook.url,matches_main_url:hook.url===bot.main_url+'/webhook',pending:hook.pending_update_count||0,last_error_at:hook.last_error_date?stamp(hook.last_error_date*1000):null},operations,deliveries},null,2),[{label:'مدیریت / Admin',action:'admin'}]);
  }
  if(action==='usage')return send(r,u,JSON.stringify(await cloudflareUsage(r),null,2)+'\n'+t(u,'حد روزانه مشترک کل حساب است؛ نه برای هر نود جداگانه.','The daily limit is account-wide, not a separate allowance for every node.'),[{label:'مدیریت / Admin',action:'admin'}]);
  if(action==='audit'){
    const rows=await r.all('SELECT id,actor,action,target,created_at FROM nx_audit WHERE id>? ORDER BY id LIMIT 16',Number(id)||0);
    return send(r,u,rows.slice(0,15).map(a=>`${a.id} • ${stamp(a.created_at)}\n${a.actor}: ${a.action} ${a.target}`).join('\n')||'—',[...(rows.length>15?[{label:'بعدی / Next',action:'audit',id:String(rows[14].id)}]:[]),{label:'مدیریت / Admin',action:'admin'}]);
  }
  if(action==='backup')return send(r,u,t(u,'پشتیبان تنظیمات صفحه‌بندی شده است؛ برای داده‌های مالی و کاربران خروجی کامل D1 بگیرید.','Configuration backups are paginated. Export all D1 data for customers and accounting.'),['bot','test','panel','profiles','nodes','plans','payments','guides','channels','coupons','texts'].map(k=>({label:k,action:'exportkind',id:k})));
  if(action==='exportkind')return exportConfig(r,u,id,key);
  if(action==='ticketreply'){await state(r,u.id,'admin:ticketreply',{id,key});return send(r,u,'متن پاسخ را بفرستید / Send reply text');}
  fail('unknown_action');
}

async function handleState(r,u,s,message,key) {
  if(s.step.startsWith('admin:')&&!await isAdmin(r,u.id))fail('admin_required',403);
  const text=(message.text||'').trim(),d=parse(s.data,{});
  if(s.step==='receipt'){
    const photo=message.photo?.at(-1),doc=message.document;
    const receipt={type:photo?'photo':doc?'document':'text',file_id:photo?.file_id||doc?.file_id||'',note:(message.caption||text).slice(0,500)};
    const out=await submitReceipt(r,u.id,d.order_id,receipt);await clearState(r,u.id);
    return send(r,u,out.duplicate?t(u,'رسید این سفارش قبلاً ثبت شده یا سفارش بسته است.','Receipt already submitted or order closed.'):t(u,'✅ رسید برای مدیر ارسال می‌شود. پس از تأیید، اشتراک خودکار ساخته می‌شود.','✅ Receipt queued for review. Approval creates the subscription automatically.'),[back(u)]);
  }
  if(s.step==='coupon'){const order=await applyCoupon(r,u.id,d.order_id,text);await clearState(r,u.id);return invoice(r,u,order);}
  if(s.step==='topup'){
    const bot=await setting(r,'bot'),amount=number(Number(text.replaceAll(',','')),bot.min_topup,1e12,true);
    await r.run('INSERT OR IGNORE INTO nx_orders(id,user_id,kind,snapshot,total,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',key,u.id,'topup',JSON.stringify({amount}),amount,'pending_payment',now(),now()+bot.order_hours*3600000);
    await clearState(r,u.id);return invoice(r,u,await r.first('SELECT * FROM nx_orders WHERE id=?',key));
  }
  if(s.step==='withdraw_amount'){
    const bot=await setting(r,'bot'),amount=number(Number(text.replaceAll(',','')),bot.min_withdrawal,1e12,true);
    await state(r,u.id,'withdraw_destination',{amount,id:key});return send(r,u,t(u,'شماره کارت/شبا یا آدرس مقصد و نام صاحب حساب را بفرستید.','Send destination card/IBAN/wallet address and account owner.'),[back(u)]);
  }
  if(s.step==='withdraw_destination'){await requestWithdrawal(r,u.id,d.amount,text,d.id);await clearState(r,u.id);return send(r,u,t(u,'درخواست برداشت ثبت و مبلغ رزرو شد.','Withdrawal requested; funds reserved.'),[back(u)]);}
  if(s.step==='support'){const result=await supportRequest(r,u,text,key);await clearState(r,u.id);return result;}
  if(s.step==='admin:edit'){
    let doc;try{doc=JSON.parse(message.document?await downloadJsonText(r,message.document):text);}catch(e){if(e instanceof Fault)throw e;fail('send_valid_json');}
    try{doc=await validateEdit(r,d.kind,doc);}catch(e){await audit(r,u.id,'edit_validation_failed',d.kind,{code:codeOf(e)});throw e;}
    if(d.id&&doc.id!==undefined&&doc.id!==d.id)fail('record_id_cannot_change');
    const nonce=randomId(6);await state(r,u.id,'admin:confirm',{kind:d.kind,doc,version:d.version,nonce});
    let note='';if(d.kind==='profiles')note='\n'+t(u,`تعداد ECH: ${doc.ech.length}; Base64/Xray: پشتیبانی. قالب‌های دیگر فقط در نبود تنظیمات ویژه.`,`ECH variants: ${doc.ech.length}; Base64/Xray supported. Other formats require no Xray-specific settings.`);
    let preview=JSON.stringify(doc,null,2);if(preview.length>3300)preview=JSON.stringify(doc);if(preview.length>3300){await enqueue(r,'preview:'+nonce,u.id,'document',{content:preview,filename:'nexiup-preview.json',caption:'Validated preview — confirm in the bot to apply.'});preview='پیش‌نمایش کامل در فایل ارسال می‌شود / Full preview sent as a file.';}
    return send(r,u,t(u,'اعتبارسنجی ساختار موفق؛ هنوز فعال نشده است.','Schema validation passed; not yet active.')+note+'\n'+preview,[{label:'✅ ذخیره و اعمال / Save and apply',action:'apply',id:nonce},{label:'لغو / Cancel',action:'admin'}]);
  }
  if(s.step==='admin:cooldown'){await resetTestCooldown(r,u.id,number(Number(text),1,Number.MAX_SAFE_INTEGER,true));await clearState(r,u.id);return send(r,u,'✅ ثبت شد / Saved',[{label:'مدیریت / Admin',action:'admin'}]);}
  if(s.step==='admin:reject'){await finishOrder(r,d.id,'rejected',text,u.id);await clearState(r,u.id);return reviewOrder(r,u,d.id);}
  if(s.step==='admin:search'){
    let found;if(/^\d+$/.test(text))found=await r.first('SELECT id FROM nx_users WHERE id=?',Number(text));else {string(text,40,1);found=await r.first('SELECT id FROM nx_users WHERE username=? COLLATE NOCASE OR name LIKE ? LIMIT 1',text.replace(/^@/,''),'%'+text+'%');}
    if(!found)fail('user_not_found');await clearState(r,u.id);return userView(r,u,found.id);
  }
  if(s.step==='admin:balance'){
    const amount=number(Number(text.replaceAll(',','')),-1e12,1e12,true);if(!amount)fail('nonzero_adjustment_required');
    await r.batch([
      ['INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) VALUES(?,?,?,?,?,?)','adjust:'+d.key,d.id,amount,'admin_adjustment',String(u.id),now()],
      auditStmt(u.id,'wallet_adjusted',d.id,{amount})
    ]);await clearState(r,u.id);return userView(r,u,d.id);
  }
  if(s.step==='admin:directmsg'){
    string(text,3000,1);await enqueue(r,'dm:'+d.key,d.id,'text',{text});await audit(r,u.id,'direct_message',d.id,{length:text.length});await clearState(r,u.id);return adminMenu(r,u);
  }
  if(s.step==='admin:extend'){
    const days=number(Number(text),1,3650,true),sub=await r.first('SELECT * FROM nx_subs WHERE id=?',d.id);if(!sub?.node_id)fail('unmapped_subscription');const n=await r.first('SELECT * FROM nx_nodes WHERE id=?',sub.node_id),limits=parse(sub.limits);
    const plan={...limits,days,reset_usage:false,max_configs:4};
    await r.batch([
      ['INSERT OR IGNORE INTO nx_ops(id,kind,user_id,node_id,name,payload,state,sub_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)','a'+d.key,'renew',sub.user_id,n.id,'extend_'+d.key,JSON.stringify({plan,location:n.code,purpose:n.purpose}),'queued',sub.id,now()],
      auditStmt(u.id,'extension_queued',sub.id,{days})
    ]);await clearState(r,u.id);return adminMenu(r,u);
  }
  if(s.step==='admin:wdreject'){string(text,500,1);await decideWithdrawal(r,u.id,d.id,false,text);await clearState(r,u.id);return adminMenu(r,u);}
  if(s.step==='admin:broadcast'){
    string(text,3500,1);
    await r.batch([
      ['INSERT OR IGNORE INTO nx_broadcasts(id,actor,text,segment,created_at) VALUES(?,?,?,?,?)',d.key,u.id,text,d.segment,now()],
      auditStmt(u.id,'broadcast_started',d.key,{segment:d.segment,length:text.length})
    ]);await clearState(r,u.id);return adminMenu(r,u);
  }
  if(s.step==='admin:ticketreply'){
    string(text,3000,1);const ticket=await r.first('SELECT * FROM nx_tickets WHERE id=?',d.id);if(!ticket)fail('ticket_not_found');
    await r.batch([
      ['INSERT OR IGNORE INTO nx_messages(id,ticket_id,sender,text,created_at) VALUES(?,?,?,?,?)',d.key,d.id,u.id,text,now()],
      ['UPDATE nx_tickets SET status=? WHERE id=?','answered',d.id],
      ['INSERT OR IGNORE INTO nx_jobs(id,user_id,kind,data,due,created_at) VALUES(?,?,?,?,?,?)','reply:'+d.key,ticket.user_id,'text',JSON.stringify({text:`💬 ${d.id}\n${text}`}),now(),now()],
      auditStmt(u.id,'ticket_replied',d.id)
    ]);await clearState(r,u.id);return adminMenu(r,u);
  }
  fail('use_confirmation_button_or_cancel');
}
async function exportConfig(r,u,selector,key) {
  const [kind,cursor='']=selector.split('~');
  let records,next='';
  if(['bot','test','panel'].includes(kind))records=[await setting(r,kind,true)];
  else if(kind==='nodes'){
    const rows=await r.all('SELECT * FROM nx_nodes WHERE id>? ORDER BY id LIMIT 4',cursor);records=[];
    for(const row of rows.slice(0,3))records.push((await editableDoc(r,'nodes',row.id)).doc);if(rows.length>3)next=rows[2].id;
  }else if(kind==='profiles'){const rows=(await profiles(r,true)).filter(p=>p.id>cursor);records=rows.slice(0,3).map(({version,...doc})=>doc);if(rows.length>3)next=rows[2].id;}
  else {const rows=await catalog(r,kind,false,cursor,4);records=rows.slice(0,3).map(({version,...doc})=>doc);if(rows.length>3)next=rows[2].id;}
  const content=JSON.stringify({project:'NexiUP',version:2,kind,records,next},null,2);
  await enqueue(r,'backup:'+key,u.id,'document',{content,filename:`nexiup-${kind}.json`,caption:'Configuration only. Restore caption: #import_nexiup. Keep private.'});
  await audit(r,u.id,'config_backup',kind,{records:records.length});
  return send(r,u,t(u,'فایل پشتیبان در صف ارسال است.','Backup file queued.'),[...(next?[{label:'صفحه بعد / Next page',action:'exportkind',id:kind+'~'+next}]:[]),{label:'مدیریت / Admin',action:'admin'}]);
}
async function downloadJsonText(r,document) {
  if(!document?.file_id||document.file_size>64000)fail('backup_too_large');
  const f=await telegram(r,'getFile',{file_id:document.file_id});
  if(!f.file_path||!/^[A-Za-z0-9_/.-]+$/.test(f.file_path)||f.file_path.includes('..'))fail('invalid_telegram_file_path');
  const res=await r.fetch(`https://api.telegram.org/file/bot${r.env.BOT_TOKEN}/${f.file_path}`);if(!res.ok)fail('backup_download_failed');
  return dec.decode(await boundedBody(res,64000));
}
async function importConfig(r,u,document) {
  if(!await isAdmin(r,u.id))fail('admin_required',403);
  const d=parse(await downloadJsonText(r,document));
  if(!d||d.project!=='NexiUP'||d.version!==2||!Array.isArray(d.records)||d.records.length>3)fail('invalid_v2_backup');
  // Restore is settings-only, strictly validated, upsert-only and audited. No SQL comes from the file.
  const docs=[];for(const doc of d.records)docs.push(await validateEdit(r,d.kind,doc));
  for(const doc of docs){const {version}=await editableDoc(r,d.kind,doc.id||'');await applyEdit(r,u.id,d.kind,doc,version);}
  await audit(r,u.id,'config_restored',d.kind,{records:docs.length});return send(r,u,'✅ بازیابی تنظیمات انجام شد / Configuration restored',[{label:'مدیریت / Admin',action:'admin'}]);
}

async function handleUpdate(r,update) {
  const key='u'+number(update.update_id,0,Number.MAX_SAFE_INTEGER,true).toString(36);
  if(update.chat_member||update.my_chat_member){
    const m=update.chat_member||update.my_chat_member,uid=m.new_chat_member?.user?.id;
    if(!uid)return;
    const channels=await catalog(r,'channels');if(!channels.some(c=>String(c.chat_id)===String(m.chat.id)))return;
    await r.run('INSERT INTO nx_members(user_id,channel,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at',uid,String(m.chat.id),m.new_chat_member.status,now());invalidate(r);return;
  }
  const query=update.callback_query,message=query?.message||update.message,from=query?.from||message?.from;
  if(!from||!message||message.chat?.type!=='private'||message.chat.id!==from.id)return;
  const text=(update.message?.text||'').trim(),[command,start='']=text.split(/\s+/,2);
  const u=await userRow(r,from,command?.startsWith('/start')?start:'');if(u.banned)fail('user_banned',403);
  let action,id;
  if(query){({action,id}=await verifyCallback(r.env,u.id,query.data));await telegram(r,'answerCallbackQuery',{callback_query_id:query.id});}
  await rate(r,'interaction:'+u.id,600);
  if(query)return handleAction(r,u,action,id,key);
  if(command?.startsWith('/')){
    const map={'/start':'home','/services':'shop','/myservices':'subs','/wallet':'wallet','/test':'test','/help':'guides','/support':'support','/admin':'admin','/rules':'rules','/cancel':'home','/status':'stats'};
    const cmd=command.split('@')[0];
    if(cmd==='/language')return send(r,u,'زبان / Language',[[{label:'فارسی',action:'lang',id:'fa'},{label:'English',action:'lang',id:'en'}]]);
    if(cmd==='/pause'||cmd==='/resume'){
      if(!await isAdmin(r,u.id))fail('admin_required',403);const p=await setting(r,'panel');p.paused=cmd==='/pause';await putSetting(r,'panel',p,u.id);return send(r,u,`Node paused: ${p.paused}`);
    }
    if(cmd==='/start'&&u.terms_at){const welcome=await customText(r,u,'welcome',t(u,'سلام {name}، به {brand} خوش آمدید.','Hello {name}, welcome to {brand}.'));await send(r,u,welcome);}
    if(cmd==='/start'&&start.startsWith('srv_')&&u.terms_at)return shop(r,u); // Existing service deep links remain an entry into the live catalog.
    return handleAction(r,u,map[cmd]||'home','0',key);
  }
  if(!u.terms_at)return showTerms(r,u);
  if(update.message?.document&&(update.message.caption||'').trim()==='#import_nexiup')return importConfig(r,u,update.message.document);
  const forwarded=update.message?.reply_to_message?.forward_origin?.sender_user?.id||update.message?.reply_to_message?.forward_from?.id;
  if(forwarded&&text&&await isAdmin(r,u.id)&&await r.first('SELECT id FROM nx_users WHERE id=?',forwarded)){
    string(text,3000,1);await enqueue(r,'quick-reply:'+key,forwarded,'text',{text:'💬 '+text});await audit(r,u.id,'support_quick_reply',forwarded,{length:text.length});return send(r,u,t(u,'پاسخ در صف است.','Reply queued.'),[{label:'مدیریت / Admin',action:'admin'}]);
  }
  const s=await r.first('SELECT * FROM nx_states WHERE user_id=? AND expires_at>?',u.id,now());
  if(s)return handleState(r,u,s,update.message,key);
  const legacyButtons={'🛒 خرید سرویس':'shop','📦 سرویس‌های من':'subs','🧪 دریافت اکانت تست':'test','📖 راهنمای اتصال':'guides','👥 زیرمجموعه‌گیری':'referral','💰 کیف پول':'wallet','📞 پشتیبانی':'support'};
  return handleAction(r,u,legacyButtons[text]||'home','0',key);
}
async function webhook(r,request) {
  if(!strongSecret(r.env.WEBHOOK_SECRET))return json({error:'webhook_secret_required'},503);
  if(!constantTimeEqual(request.headers.get('x-telegram-bot-api-secret-token'),r.env.WEBHOOK_SECRET))return json({error:'unauthorized'},401);
  await ready(r);
  const update=await bodyJson(request,65536);number(update.update_id,0,Number.MAX_SAFE_INTEGER,true);
  const owner=randomId(),at=now();
  const claim=await r.first(`INSERT INTO nx_updates(id,status,owner,until_ms,created_at) VALUES(?,'processing',?,?,?) ON CONFLICT(id) DO UPDATE SET status='processing',owner=excluded.owner,until_ms=excluded.until_ms WHERE nx_updates.status<>'done' AND nx_updates.until_ms<=? RETURNING id`,update.update_id,owner,at+60000,at,at);
  if(!claim){const existing=await r.first('SELECT status FROM nx_updates WHERE id=?',update.update_id);return json({ok:existing?.status==='done'},existing?.status==='done'?200:503);}
  try {
    await handleUpdate(r,update);
    await r.run('UPDATE nx_updates SET status=?,until_ms=0 WHERE id=? AND owner=?','done',update.update_id,owner);
    return json({ok:true});
  }catch(e){
    if(e instanceof Fault && e.status<500 && !['telegram_rate_limit','query_budget'].includes(e.code)){
      const uid=update.callback_query?.from?.id||update.message?.from?.id;
      if(uid&&r.queries<42){
        try{const target=await r.first('SELECT id,lang FROM nx_users WHERE id=?',uid)||{id:uid,lang:'fa'};await send(r,target,`⚠️ ${e.code}${e.retry?' ('+e.retry+'s)':''}\n${t(target,'لطفاً وضعیت را بررسی کنید یا دوباره از منو اقدام کنید.','Check status or retry from the menu.')}`,[{label:t(target,'منو','Menu'),action:'home'}]);}catch{}
      }
      if(r.queries<45)await r.run('UPDATE nx_updates SET status=?,until_ms=0 WHERE id=? AND owner=?','done',update.update_id,owner);
      return json({ok:true});
    }
    // Leave retriable updates recoverable. Business mutations use stable update/order IDs.
    if(r.queries<45)await r.run('UPDATE nx_updates SET status=?,until_ms=? WHERE id=? AND owner=?','retry',e.code==='telegram_rate_limit'?now()+e.retry*1000:0,update.update_id,owner);
    return json({error:codeOf(e)},503,{'Retry-After':String(e.retry||15)});
  }
}

// ---------------- Paginated cron: one schedule; split CPU-heavy work into separate invocations ----------------
async function processBroadcast(r) {
  const b=await r.first("SELECT * FROM nx_broadcasts WHERE status='queued' AND due<=? ORDER BY created_at LIMIT 1",now());if(!b)return;
  const release=await lock(r,'broadcast:'+b.id);
  try {
    const condition=({buyers:"EXISTS(SELECT 1 FROM nx_orders o WHERE o.user_id=u.id AND o.kind='sale' AND o.status='done')",non_buyers:"NOT EXISTS(SELECT 1 FROM nx_orders o WHERE o.user_id=u.id AND o.kind='sale' AND o.status='done')",active_30d:'u.last_at>=?',all:'1'})[b.segment];
    if(!condition)fail('invalid_broadcast_segment');
    const args=[b.cursor,...(b.segment==='active_30d'?[now()-30*DAY]:[])];
    const users=await r.all(`SELECT u.id,u.lang FROM nx_users u WHERE u.id>? AND u.banned=0 AND u.blocked=0 AND ${condition} ORDER BY u.id LIMIT 5`,...args);
    if(!users.length){await r.run('UPDATE nx_broadcasts SET status=? WHERE id=?','done',b.id);await enqueue(r,'broadcast-done:'+b.id,b.actor,'text',{text:`✅ ${b.id}: sent=${b.sent}; failed=${b.failed}`});return;}
    for(const u of users){
      if((await r.first('SELECT status FROM nx_broadcasts WHERE id=?',b.id)).status!=='queued')break;
      let sent=0,failed=0;
      try{await send(r,u,b.text);sent=1;}catch(e){if(e.status===429){await r.run('UPDATE nx_broadcasts SET due=? WHERE id=?',now()+e.retry*1000,b.id);break;}if(e.code!=='telegram_blocked')throw e;failed=1;await r.run('UPDATE nx_users SET blocked=1 WHERE id=?',u.id);}
      await r.run('UPDATE nx_broadcasts SET cursor=?,sent=sent+?,failed=failed+? WHERE id=?',u.id,sent,failed,b.id);
    }
  }finally{await release();}
}
async function housekeeping(r) {
  const expired=await r.all("SELECT id FROM nx_orders WHERE status='pending_payment' AND expires_at<=? ORDER BY expires_at LIMIT 2",now());
  for(const o of expired)await finishOrder(r,o.id,'cancelled','مهلت پرداخت تمام شد / Payment deadline expired','cron');
  if(r.queries>30)return;
  const subs=await r.all("SELECT * FROM nx_subs WHERE status='active' AND expires_at<=? AND (reminded<3) ORDER BY expires_at LIMIT 2",now()+3*DAY);
  for(const s of subs){
    const stage=s.expires_at<=now()?3:s.expires_at<=now()+DAY?2:1;if(stage<=s.reminded)continue;
    await r.batch([
      ['INSERT OR IGNORE INTO nx_jobs(id,user_id,kind,data,due,created_at) VALUES(?,?,?,?,?,?)',`expiry:${s.id}:${s.expires_at}:${stage}`,s.user_id,'text',JSON.stringify({text:`⏳ ${s.name}\nانقضا / Expiry: ${stamp(s.expires_at)}`,buttons:[{label:'تمدید / Renew',action:'renew',id:s.id}]}),now(),now()],
      ['UPDATE nx_subs SET reminded=? WHERE id=? AND expires_at=?',stage,s.id,s.expires_at]
    ]);
  }
  if(r.queries<35)await r.batch([
    ['DELETE FROM nx_updates WHERE id IN(SELECT id FROM nx_updates WHERE created_at<? AND status=? LIMIT 100)',now()-7*DAY,'done'],
    ['DELETE FROM nx_jobs WHERE id IN(SELECT id FROM nx_jobs WHERE created_at<? AND status<>? LIMIT 50)',now()-7*DAY,'queued'],
    ['DELETE FROM nx_states WHERE user_id IN(SELECT user_id FROM nx_states WHERE expires_at<? LIMIT 50)',now()],
    ['DELETE FROM nx_limits WHERE key IN(SELECT key FROM nx_limits WHERE next_at<? LIMIT 100)',now()-DAY],
    ['DELETE FROM nx_flush WHERE id IN(SELECT id FROM nx_flush WHERE created_at<? LIMIT 100)',now()-7*DAY],
    ['DELETE FROM nx_web_sessions WHERE expires_at<=?',now()],
    ['DELETE FROM nx_proxy_imports WHERE expires_at<=?',now()],
    ['DELETE FROM nx_proxy_budgets WHERE day<?',new Date(now()-7*DAY).toISOString().slice(0,10)]
  ]);
}
async function reports(r) {
  if(r.env.CF_API_TOKEN){
    const usage=await cloudflareUsage(r);
    for(const threshold of [70,90])if(usage.configured&&usage.percent>=threshold)await notifyAdmins(r,`cf:${dayKey()}:${threshold}`,`⚠️ Cloudflare account requests ≈ ${usage.requests}/100000 (≥${threshold}%). Sampled analytics; inspect dashboard.`);
  }
  const bot=await setting(r,'bot');if(new Date(now()).getUTCHours()===bot.daily_report_hour){
    const stats=await getStats(r);await notifyAdmins(r,'daily:'+dayKey(),'📊 '+dayKey()+'\n'+JSON.stringify(stats,null,2));
  }
}
async function scheduled(r,event) {
  await ready(r);const role=getRole(r.env);if(role==='node')return; // no cron necessary on node-only deployments
  const minute=Math.floor((event?.scheduledTime||now())/60000),slot=minute%6;
  if(slot===0||slot===2){const op=await r.first("SELECT id FROM nx_ops WHERE state IN ('queued','creating','ready','reconcile') AND retry_at<=? ORDER BY CASE WHEN retry_at=0 THEN created_at ELSE retry_at END,created_at LIMIT 1",now());if(op)await processOp(r,op.id);}
  else if(slot===1||slot===3){const job=await r.first("SELECT id FROM nx_jobs WHERE status='queued' AND due<=? ORDER BY due,created_at LIMIT 1",now());if(job)await processJob(r,job.id,3);}
  else if(slot===4)await housekeeping(r);
  else {if(minute%60===5)await reports(r);else await processBroadcast(r);}
}

// ---------------- Embedded UI: no fonts, scripts, HTML or QR requests to third parties ----------------
const STYLE=`:root{color-scheme:dark;--bg:#10151e;--panel:#192231;--line:#304056;--ink:#e7eff9;--muted:#a1b2ca;--accent:#73ddc6}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 system-ui,sans-serif}main{max-width:1080px;margin:4vh auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}h1{font-size:32px;letter-spacing:-1px;margin:0}h2{font-size:20px}p,small{color:var(--muted)}.card{border:1px solid var(--line);background:var(--panel);border-radius:16px;padding:24px;margin:18px 0}label{display:block;margin:12px 0 5px}input,textarea,select{font:inherit;width:100%;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:11px}textarea,pre,code{font-family:ui-monospace,monospace;direction:ltr;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}textarea{min-height:200px}button,a.button{font:inherit;cursor:pointer;background:var(--accent);color:#0b211d;border:0;border-radius:8px;padding:9px 17px;margin:6px 5px 6px 0;text-decoration:none;display:inline-block}button.secondary{background:#28374b;color:var(--ink)}nav{display:flex;flex-wrap:wrap;gap:7px}.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.row>*{flex:1}.badge{color:var(--accent);font-size:13px;text-transform:uppercase;letter-spacing:1px}pre{background:var(--bg);padding:16px;border-radius:8px;max-height:450px;overflow:auto}.hidden{display:none}img.qr{display:block;max-width:280px;width:100%;background:white;border-radius:10px;margin:20px 0}a{color:var(--accent)}.notice{border-inline-start:3px solid var(--accent);padding:12px 16px;background:#122c2b}footer{font-size:12px;color:var(--muted);margin-top:32px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:10px;text-align:start}@media(max-width:600px){main{padding:15px}h1{font-size:26px}.card{padding:17px}.row{display:block}}`;
function page(title,body,script='',lang='fa') {
  const nonce=randomId(12);
  return new Response(`<!doctype html><html lang="${lang}" dir="${lang==='fa'?'rtl':'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)} · NexiUP</title><style>${STYLE}</style></head><body><main>${body}<footer>NexiUP ${VERSION} · MIT · No external assets. Availability depends on your network and platform quotas.</footer></main>${script?`<script nonce="${nonce}">${script}</script>`:''}</body></html>`,{headers:{...noStore,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`}});
}
function dashboard() {
  return page('Node panel',`
    <header><div><span class="badge">NexiUP / Node control</span><h1>پنل نود · Node panel</h1></div><button id="lang" class="secondary">English / فارسی</button></header>
    <p class="notice"><a href="/admin">پنل کامل جدید + ProxyIP / New control center →</a></p>
    <p class="notice">اطلاعات ورود فقط در حافظه همین صفحه می‌ماند. Master Key را در تلگرام یا URL نفرستید. / Credentials stay in page memory. Never put the master key in Telegram or a URL.</p>
    <section class="card"><div class="row"><div><label for="key">Master Key (Worker Secret)</label><input id="key" type="password" autocomplete="off" placeholder="32+ random characters"></div><div><button id="login">ورود / Sign in</button><button id="logout" class="secondary">خروج / Sign out</button></div></div><p id="status" role="status">API: Bearer authentication • API keys cannot change master settings.</p></section>
    <section id="app" class="hidden">
      <nav><button data-tab="users">کاربران / Users</button><button data-tab="config">تنظیمات / Settings</button><button data-tab="keys">کلیدها / Keys</button><button data-tab="stats">آمار / Stats</button><button data-tab="logs">رویدادها / Logs</button><button data-tab="backup">پشتیبان / Backup</button></nav>
      <section class="card"><h2 id="title">Users</h2><div id="list"></div><button id="next" class="secondary hidden">بعدی / Next</button><pre id="result"></pre></section>
      <section class="card"><h2>ویرایشگر JSON / JSON editor</h2><p id="hint">Select a user or open Settings. Inputs are validated on the server.</p><textarea id="editor" spellcheck="false" aria-label="JSON editor"></textarea><button id="save">ذخیره / Save</button><button id="new" class="secondary">کاربر جدید / New user</button><button id="pause" class="secondary hidden">توقف/ادامه / Pause/resume</button><button id="reset" class="secondary hidden">صفرکردن مصرف / Reset usage</button><button id="delete" class="secondary hidden">حذف / Delete</button></section>
      <section class="card"><h2>Backup / Restore</h2><p>Backup contains account identities. Keep private. Users are paginated; download every page. A full D1 export is required for financial/usage recovery.</p><button id="download">دریافت صفحه / Download page</button><input id="restore" type="file" accept="application/json" aria-label="Restore backup"><button id="import">بازگردانی صفحه / Restore page</button></section>
    </section>`,String.raw`
    const $=id=>document.getElementById(id);let secret='',base=location.pathname.replace(/\/dash\/?$/,'')+'/api/',tab='users',selected='',cursor='',last=null;
    const show=x=>{$('result').textContent=JSON.stringify(x,null,2);last=x;};
    async function api(path,method='GET',body){const res=await fetch(base+path,{method,headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await res.json();if(!res.ok)throw Error(data.error||String(res.status));return data;}
    let uiBusy=false;async function safe(fn){if(uiBusy)return;uiBusy=true;try{$('status').textContent='…';await fn();$('status').textContent='✓';}catch(e){$('status').textContent=e.message;}finally{uiBusy=false;}}
    function editor(doc){$('editor').value=JSON.stringify(doc,null,2);}
    function userDoc(u){const keys=['name','trafficLimit','dailyLimit','expiryMs','notes','connLimit','maxConfigs','proxyIp','cleanIp','userNodes','userPanelUrl','userMode','userPorts','isPaused'];return Object.fromEntries(keys.filter(k=>u[k]!==undefined).map(k=>[k,u[k]]));}
    async function load(){
      $('title').textContent=tab; $('list').replaceChildren();$('next').classList.add('hidden');$('save').disabled=!['users','config','keys'].includes(tab);
      for(const id of ['pause','reset','delete'])$(id).classList.add('hidden');
      if(tab==='users'){
        const d=await api('users'+(cursor?'?cursor='+encodeURIComponent(cursor):''));show(d);
        for(const u of d.users){const b=document.createElement('button');b.className='secondary';b.textContent=u.name+' · '+u.status;b.onclick=()=>{selected=u.id;editor(userDoc(u));show(u);for(const id of ['pause','reset','delete'])$(id).classList.remove('hidden');};$('list').append(b);}
        cursor=d.next||'';if(cursor)$('next').classList.remove('hidden');
      }else if(tab==='config'){const d=await api('config');editor(d.config);show(d);}
      else if(tab==='keys'){const d=await api('keys');show(d);editor({name:'',secret_ref:''});$('hint').textContent='First add a distinct NODE_KEY_* Worker Secret in Cloudflare. Then register its name here. Never paste the value. To revoke use DELETE /api/keys?id=…';}
      else if(tab==='backup'){const d=await api('backup'+(cursor?'?cursor='+encodeURIComponent(cursor):''));show(d);cursor=d.next||'';if(cursor)$('next').classList.remove('hidden');}
      else show(await api(tab));
    }
    $('login').onclick=()=>safe(async()=>{secret=$('key').value;show(await api('config'));$('key').value='';$('app').classList.remove('hidden');await load();});
    $('logout').onclick=()=>{secret='';$('key').value='';$('editor').value='';$('result').textContent='';$('app').classList.add('hidden');};
    for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>safe(async()=>{tab=b.dataset.tab;cursor='';selected='';await load();});
    $('next').onclick=()=>safe(load);
    $('new').onclick=()=>{tab='users';selected='';$('save').disabled=false;editor({name:'',trafficLimit:1,dailyLimit:1,expiryDays:1,connLimit:1,maxConfigs:4,notes:''});};
    $('save').onclick=()=>safe(async()=>{const doc=JSON.parse($('editor').value);if(!confirm('Apply validated changes?'))return;if(tab==='config'){show(await api('config','PUT',doc));base='/'+doc.api_route+'/api/';history.replaceState(null,'','/'+doc.api_route+'/dash');}else if(tab==='keys')show(await api('keys','POST',doc));else show(await api('users'+(selected?'?id='+encodeURIComponent(selected):''),selected?'PUT':'POST',doc));});
    for(const [id,action]of [['pause','toggle'],['reset','reset'],['delete','delete']])$(id).onclick=()=>safe(async()=>{if(!selected||!confirm('Confirm '+action+'?'))return;show(await api('users?id='+encodeURIComponent(selected)+(action==='delete'?'':'&action='+action),action==='delete'?'DELETE':'POST'));});
    $('download').onclick=()=>{if(!last)return;const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(last,null,2)],{type:'application/json'}));a.href=url;a.download='nexiup-panel-page.json';a.click();URL.revokeObjectURL(url);};
    $('import').onclick=()=>safe(async()=>{const f=$('restore').files[0];if(!f||f.size>64000)throw Error('Select a backup page under 64 KB');if(!confirm('Upsert identities/settings? Usage will not be reset.'))return;show(await api('restore','POST',JSON.parse(await f.text())));});
    $('lang').onclick=()=>{const en=document.documentElement.lang!=='en';document.documentElement.lang=en?'en':'fa';document.documentElement.dir=en?'ltr':'rtl';};
  `);
}
function setupPage() {
  return page('Setup',`<header><div><span class="badge">NexiUP ${VERSION} / Setup</span><h1>راه‌اندازی و بررسی دیپلوی / Setup &amp; deployment checks</h1></div><a href="/admin">پنل مدیریت / Admin</a></header>
  <div class="card"><p>برای راه‌اندازی در hub/all از SETUP_KEY و در node از MASTER_KEY استفاده کنید. WEB_ADMIN_KEY نیز فقط برای بررسی خواندنی پذیرفته می‌شود. کد برنامه راز را در URL، localStorage یا sessionStorage نمی‌گذارد. / Use SETUP_KEY for hub/all or MASTER_KEY for node. WEB_ADMIN_KEY is also accepted for read-only checks, not setup writes.</p>
  <label for="key">کلید مدیر / Owner secret</label><input type="password" id="key" autocomplete="off" maxlength="256">
  <button id="diagnostics">بررسی دیپلوی، بدون تغییر داده / Check deployment — read only</button><p>این بررسی پیش از مهاجرت هم کار می‌کند: binding، اتصال D1، نسخهٔ ساختار و حداقل تنظیمات؛ بدون تماس با ربات، نود یا ProxyIP. پاسخ health فقط زنده‌بودن handler را نشان می‌دهد، نه آمادگی سرویس. / Works before migrations. No Telegram/node/proxy requests. Health is liveness, not readiness.</p>
  <label for="origin">Main HTTPS Worker origin (hub/all)</label><input id="origin" placeholder="https://…"><button id="migrate">۱. آماده‌سازی D1 / Initialize D1</button><button id="configure">۲. دامنه اصلی / Save main origin</button><button id="hook">۳. فعال‌سازی ربات / Register webhook</button><p>مدیریت کامل در <a href="/admin">/admin</a>؛ مدیریت تلگرام نیز حفظ شده است. / Full web panel: <a href="/admin">/admin</a>. Enable one hub/all cron: <code>* * * * *</code>.</p><button class="secondary" id="op">صدور بعدی / Process next operation</button><button class="secondary" id="job">تحویل بعدی / Process next delivery</button><pre id="result" role="status" dir="ltr"></pre></div>`,String.raw`
  const $=id=>document.getElementById(id);let busy=false;
  async function call(action,extra={}){const res=await fetch('/setup',{method:'POST',headers:{Authorization:'Bearer '+$('key').value,'Content-Type':'application/json'},body:JSON.stringify({action,...extra})});const d=await res.json();$('result').textContent=JSON.stringify(d,null,2);if(!res.ok&&action!=='diagnostics')throw Error(JSON.stringify(d,null,2));return d;}
  async function safe(fn){if(busy)return;busy=true;try{await fn();}catch(e){$('result').textContent=e.message;}finally{busy=false;}}
  $('diagnostics').onclick=()=>safe(()=>call('diagnostics'));
  $('migrate').onclick=()=>safe(async()=>{for(let i=0;i<12;i++){const d=await call('migrate');if(d.ready)return;}throw Error('Migration is not ready; run read-only deployment checks. / آماده‌سازی کامل نشده؛ بررسی خواندنی دیپلوی را اجرا کنید.');});
  $('configure').onclick=()=>safe(()=>call('configure',{main_url:$('origin').value}));
  $('hook').onclick=()=>safe(()=>call('webhook'));
  $('op').onclick=()=>safe(()=>call('tick',{kind:'op'}));$('job').onclick=()=>safe(()=>call('tick',{kind:'job'}));
  `);
}
async function subscriptionPage(r,url,s,main=true) {
  const user={lang:url.searchParams.get('lang')==='en'?'en':'fa'},lim=main?parse(s.limits):{days:s.expiryMs?Math.max(0,Math.ceil((s.expiryMs-now())/DAY)):0,total_gb:s.trafficLimit,daily_gb:s.dailyLimit,conn_limit:s.connLimit};
  const canonical=main?mainSubscriptionUrl(await setting(r,'bot'),s.token):`${url.origin}${url.pathname}?sub=${encodeURIComponent(s.name)}`;
  const link=fmt=>canonical+(canonical.includes('?')?'&':'?')+'format='+fmt;
  const expiry=main?s.expires_at:s.expiryMs;
  const body=`<header><div><span class="badge">NexiUP / Subscription</span><h1>${html(s.name)}</h1></div><a href="${html(canonical+(canonical.includes('?')?'&':'?')+'lang='+(user.lang==='en'?'fa':'en'))}">English / فارسی</a></header><section class="card"><p>${html(t(user,'انقضا','Expiry'))}: ${html(stamp(expiry))}</p><pre>${html(limitsText(user,lim))}</pre><img class="qr" alt="Subscription QR code" src="${html(link('qr'))}"><p><a href="${html(canonical)}">${html(canonical)}</a></p><p class="notice">${html(t(user,'این QR دقیقاً همین لینک را دارد. برای حفظ Cipher Suites از JSON کامل Xray استفاده کنید. سازگاری اپراتور/کلاینت تضمین نیست.','The QR encodes this exact URL. Use full Xray JSON to preserve cipher suites. Operator/client compatibility is not guaranteed.'))}</p><nav>${[['xray','Xray JSON'],['base64','Base64'],['raw','VLESS / Trojan'],['clash','Clash'],['sing-box','sing-box']].map(([f,label])=>`<a class="button" href="${html(link(f))}">${label}</a>`).join('')}</nav><p>${html(t(user,'قالب ناسازگار پاسخ ۴۲۲ می‌دهد؛ هیچ تنظیم ضروری بی‌صدا حذف نمی‌شود. نسخه هر اپراتور از همان حساب و همان سهمیه استفاده می‌کند.','An incompatible format returns 422; essential settings are not silently discarded. All operator variants use the same account and quota.'))}</p></section>`;
  return page('Subscription',body,'',user.lang);
}
async function serveSubscription(r,url,request,token) {
  if(!/^[a-f0-9]{32}$/.test(token))fail('not_found',404);
  const s=await r.first('SELECT * FROM nx_subs WHERE token=?',token);if(!s||s.status!=='active')fail('subscription_unavailable',404);
  const bot=await setting(r,'bot'),canonical=mainSubscriptionUrl(bot,token);
  const fmt=url.searchParams.get('format');
  if(fmt==='qr')return new Response(qrPng(canonical),{headers:{...noStore,'Content-Type':'image/png'}});
  if(!fmt&&(request.headers.get('accept')||'').includes('text/html'))return subscriptionPage(r,url,s);
  if(s.expires_at&&s.expires_at<=now())fail('subscription_expired',403);
  const lim=parse(s.limits);
  if(lim.legacy_config)return new Response(lim.legacy_config,{headers:{...noStore,'Content-Type':'text/plain; charset=utf-8','X-NexiUP-Warning':'Legacy manual configuration; operator variants and live limits unverified.'}});
  const variants=aggregate(parse(s.bases,[]),await profiles(r));
  try{
    const result=renderSubscription(variants,fmt||'base64');
    return new Response(result.body,{headers:{...noStore,'Content-Type':result.type,'Profile-Update-Interval':'1','X-NexiUP-Profile-Versions':(await profiles(r)).map(p=>p.id+'='+p.version).join(','),...(result.warnings.length?{'X-NexiUP-Warnings':result.warnings.join(' ')}:{})}});
  }catch(e){if(e.status===422)return json({error:e.code,fallback:canonical+'?format=xray'},422);throw e;}
}
async function serveNodeSubscription(r,url,request,panel) {
  const name=url.searchParams.get('sub');if(!name)return camouflage();
  const user=await panelGet(r,name,url.origin),fmt=url.searchParams.get('format')||url.searchParams.get('flag');
  if(fmt==='qr')return new Response(qrPng(`${url.origin}/${panel.api_route}?sub=${encodeURIComponent(user.name)}`),{headers:{...noStore,'Content-Type':'image/png'}});
  if(!fmt&&(request.headers.get('accept')||'').includes('text/html'))return subscriptionPage(r,url,user,false);
  if(user.status!=='active'||panel.paused)fail('account_inactive',403);
  const bases=panelBases(user,panel,url.origin);
  if(fmt==='base')return json(bases);
  const rendered=renderSubscription(aggregate(bases,await profiles(r)),fmt==='a'?'raw':fmt||'base64');
  return new Response(rendered.body,{headers:{...noStore,'Content-Type':rendered.type,'Subscription-UserInfo':`upload=${user.usage.upload}; download=${user.usage.download}; total=${Math.floor(user.trafficLimit*GIB)}; expire=${Math.floor(user.expiryMs/1000)}`,...(rendered.warnings.length?{'X-NexiUP-Warnings':rendered.warnings.join(' ')}:{})}});
}
function camouflage(){return page('Field notes','<header><div><span class="badge">Field notes</span><h1>A quiet corner of the web.</h1></div></header><section class="card"><h2>Small observations. Useful ideas.</h2><p>This page is a personal notebook. There is nothing to subscribe to here.</p></section>','','en');}

// Explicit, paginated v1 import. No automatic interpretation of old manually provisioned accounts.
async function importLegacy(r,kind,after=0) {
  number(after,0,Number.MAX_SAFE_INTEGER,true);
  if(kind==='users'){
    const rows=await r.all('SELECT * FROM users WHERE id>? ORDER BY id LIMIT 5',after);const items=[];
    for(const u of rows){
      const balance=Math.max(0,number(Number(u.wallet_balance||0),0,1e12,true));
      items.push(['INSERT OR IGNORE INTO nx_users(id,username,name,referrer,banned,created_at,last_at) VALUES(?,?,?,?,?,?,?)',u.id,u.username||'',u.first_name||'',u.referrer_id||null,+!!u.is_banned,Date.parse(u.created_at)||now(),Date.parse(u.last_active_at)||now()]);
      items.push(['INSERT OR IGNORE INTO nx_ledger(key,user_id,amount,kind,reference,created_at) VALUES(?,?,?,?,?,?)','legacy-opening:'+u.id,u.id,balance,'legacy_opening','v1',now()]);
    }
    if(items.length){items.push(auditStmt('setup','legacy_users_imported','',{after,count:rows.length}));await r.batch(items);}
    return {imported:rows.length,next:rows.at(-1)?.id||null};
  }
  if(kind==='services'){
    const rows=await r.all('SELECT * FROM user_services WHERE id>? ORDER BY id LIMIT 5',after),items=[];
    for(const s of rows){
      if(!await r.first('SELECT id FROM nx_users WHERE id=?',s.user_id))fail('import_legacy_users_first');
      const expires=Date.parse(s.expires_at)||now(),created=Date.parse(s.starts_at)||now();
      const limits={legacy_config:s.config_text,unknown:true,days:Math.max(0,Math.ceil((expires-created)/DAY)),test:false,total_gb:0,daily_gb:0,conn_limit:0,reset_usage:false};
      items.push(['INSERT OR IGNORE INTO nx_subs(id,token,user_id,name,limits,bases,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)','legacy'+s.id.toString(36),randomId(16),s.user_id,s.service_name||'Legacy manual service',JSON.stringify(limits),'[]','active',expires,created]);
    }
    if(items.length){items.push(auditStmt('setup','legacy_services_imported','',{after,count:rows.length}));await r.batch(items);}
    return {imported:rows.length,next:rows.at(-1)?.id||null};
  }
  fail('legacy_import_kind_users_or_services');
}
// Owner-only, read-only deployment preflight. It works before migrations and
// deliberately makes no Telegram, node, proxy, DNS or external network request.
async function deploymentDiagnostics(r) {
  const role=getRole(r.env),requestId=randomId(),started=now();let expired=false;
  const checks={owner_key:strongSecret(r.env.WEB_ADMIN_KEY!==undefined?r.env.WEB_ADMIN_KEY:role==='node'?r.env.MASTER_KEY:r.env.SETUP_KEY)};
  if(role!=='hub')checks['master_key']=strongSecret(r.env.MASTER_KEY);
  if(role!=='node'){
    checks['bot_token_present']=typeof r.env.BOT_TOKEN==='string'&&r.env.BOT_TOKEN.length>0;
    checks['owner_ids']=ownerIds(r.env).length>0;
    checks['callback_secret']=strongSecret(r.env.CALLBACK_SECRET);
    checks['webhook_secret']=typeof r.env.WEBHOOK_SECRET==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(r.env.WEBHOOK_SECRET);
  }
  const report={project:'NexiUP',version:VERSION,request_id:requestId,role,read_only:true,ready:false,external_connectivity_tested:false,
    configuration:{complete:Object.values(checks).every(Boolean),checks},database:{binding:'DB',status:'not_checked'},
    schema:{status:'not_checked',version:0,expected:MIGRATIONS.length,missing_tables:[]},statements:0,elapsed_ms:0};
  try{
    // Whole preflight plus individual SELECTs are bounded. A late read cannot
    // commit data; there is intentionally no blanket deadline on mutations.
    await readDeadline((async()=>{
      await r.first('SELECT 1 AS connected');if(expired)return;report.database.status='ok';
      const tables=['schema_version',...MIGRATIONS.flat().map(sql=>sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/)?.[1]).filter(Boolean)];
      const existing=new Set((await r.all(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${tables.map(()=>'?').join(',')})`,...tables)).map(row=>row.name));if(expired)return;
      report.schema.missing_tables=tables.filter(name=>!existing.has(name));
      if(existing.has('schema_version')){
        const row=await r.first('SELECT MAX(version) AS version FROM schema_version');if(expired)return;
        if(row?.version!=null&&(!Number.isSafeInteger(row.version)||row.version<0)){report.schema.status='invalid_version';return;}
        report.schema.version=row?.version||0;
      }
      if(report.schema.version>MIGRATIONS.length){report.schema.status='newer_than_worker';return;}
      if(report.schema.version<MIGRATIONS.length){report.schema.status='migration_required';return;}
      if(report.schema.missing_tables.length){report.schema.status='incomplete';return;}
      const seed=await r.first("SELECT (SELECT COUNT(*) FROM nx_settings WHERE key IN ('bot','test','panel','proxy')) AS seeded,(SELECT COUNT(*) FROM nx_profiles) AS profiles");if(expired)return;
      report.schema.status=seed?.seeded===4&&seed.profiles>0?'ready':'seed_required';
      report.ready=report.schema.status==='ready'&&report.configuration.complete;
    })());
  }catch(error){
    const code=knownFaults.has(error)?codeOf(error):'d1_unavailable';
    report.database.status=code;report.ready=false;
    logRuntimeError(error,r.env,{request_id:requestId,surface:'diagnostics',code});
  }finally{expired=true;}
  report.statements=r.queries;report.elapsed_ms=now()-started;
  return json(report,report.ready?200:503,{'X-NexiUP-Request-ID':requestId});
}

async function setup(r,request) {
  if(request.method==='GET')return setupPage();if(request.method!=='POST')fail('method_not_allowed',405);
  webOrigin(request);
  const role=getRole(r.env),secret=role==='node'?r.env.MASTER_KEY:r.env.SETUP_KEY;
  const diagnosticSecret=r.env.WEB_ADMIN_KEY!==undefined?r.env.WEB_ADMIN_KEY:secret,header=request.headers.get('authorization');
  const setupOwner=strongSecret(secret)&&constantTimeEqual(header,'Bearer '+secret);
  const webOwner=strongSecret(diagnosticSecret)&&constantTimeEqual(header,'Bearer '+diagnosticSecret);
  if(!setupOwner&&!webOwner){if(!strongSecret(secret)&&!strongSecret(diagnosticSecret))fail('setup_secret_required_min_32',503);fail('unauthorized',401);}
  const b=await bodyJson(request);if(!isObject(b))fail('invalid_json');
  if(b.action==='diagnostics')return await deploymentDiagnostics(r);
  // A dedicated web key grants read-only diagnostics here, not setup mutations.
  if(!setupOwner)fail('unauthorized',401);
  if(b.action==='migrate')return json(await migrate(r));
  await ready(r);
  if(b.action==='configure'){
    if(role==='node')fail('hub_only');const bot=await setting(r,'bot');bot.main_url=httpsOrigin(b.main_url);await putSetting(r,'bot',bot,'setup');return json({success:true,main_url:bot.main_url});
  }
  if(b.action==='webhook'){
    if(role==='node')fail('hub_only');
    if(!r.env.BOT_TOKEN||!ownerIds(r.env).length||!strongSecret(r.env.CALLBACK_SECRET)||!strongSecret(r.env.WEBHOOK_SECRET)||!/^[A-Za-z0-9_-]{32,256}$/.test(r.env.WEBHOOK_SECRET))fail('set_bot_admin_and_secrets_first');
    const bot=await setting(r,'bot'),origin=httpsOrigin(bot.main_url);
    await telegram(r,'setWebhook',{url:origin+'/webhook',secret_token:r.env.WEBHOOK_SECRET,max_connections:4,allowed_updates:['message','callback_query','chat_member','my_chat_member'],drop_pending_updates:false});
    const commands=[['start','شروع / Start'],['services','خرید / Buy'],['myservices','اشتراک‌ها / Subscriptions'],['wallet','کیف پول / Wallet'],['test','تست خودکار / Automatic test'],['help','راهنما / Help'],['language','زبان / Language'],['rules','قوانین / Terms'],['admin','مدیریت / Admin']].map(([command,description])=>({command,description}));
    await telegram(r,'setMyCommands',{commands});
    const me=await telegram(r,'getMe',{});bot.bot_username=string(me.username,32,5);await putSetting(r,'bot',bot,'setup');
    return json({success:true,bot_username:bot.bot_username,webhook:origin+'/webhook'});
  }
  if(b.action==='tick'){
    if(role==='node')fail('hub_only');
    if(b.kind==='op'){const op=await r.first("SELECT id FROM nx_ops WHERE state IN ('queued','creating','ready','reconcile') AND retry_at<=? ORDER BY CASE WHEN retry_at=0 THEN created_at ELSE retry_at END,created_at LIMIT 1",now());if(op)await processOp(r,op.id);return json({processed:op?.id||null});}
    if(b.kind==='job'){const job=await r.first("SELECT id FROM nx_jobs WHERE status='queued' AND due<=? ORDER BY due,created_at LIMIT 1",now());if(job)await processJob(r,job.id,2);return json({processed:job?.id||null});}
    fail('invalid_tick_kind');
  }
  if(b.action==='legacy'){
    if(b.confirm!=='old_worker_stopped_and_d1_backed_up')fail('legacy_cutover_confirmation_required');
    return json(await importLegacy(r,b.kind,b.after||0));
  }
  fail('unknown_setup_action');
}
export default {
  async fetch(request,env,execution) {
    let r;
    try{
      env=env??{};r=runtime(env,execution);const url=new URL(request.url);
      // Never serve a credential-entry form over plaintext HTTP. API writes still fail closed.
      if(url.protocol==='http:'&&['GET','HEAD'].includes(request.method)&&(url.pathname==='/admin'||url.pathname==='/admin/'||url.pathname==='/setup'||url.pathname.endsWith('/dash'))){url.protocol='https:';url.port='';return new Response(null,{status:308,headers:{...noStore,Location:url.toString()}});}
      if(url.pathname==='/health'){
        let role='invalid';try{role=getRole(env);}catch{}
        return json({project:'NexiUP',version:VERSION,role,status:'alive',database_checked:false});
      }
      if(url.pathname==='/'&&request.method==='GET'&&!request.headers.get('upgrade'))return camouflage();
      if((url.pathname==='/admin'||url.pathname==='/admin/')&&request.method==='GET'&&!url.searchParams.has('sub'))return adminPage();
      if(url.pathname.startsWith('/admin/web-api/'))return await webApi(r,request,url);
      if(url.pathname==='/setup')return await setup(r,request);
      const role=getRole(env);
      if(url.pathname==='/webhook'){
        if(role==='node'||request.method!=='POST')fail('not_found',404);
        return await webhook(r,request);
      }
      if(request.method==='GET'&&url.pathname.startsWith('/sub/')&&role!=='node'){
        await ready(r);return await serveSubscription(r,url,request,url.pathname.slice(5));
      }
      if(role!=='hub'){
        if(!strongSecret(env.MASTER_KEY))fail('master_key_required_min_32',503);
        await ready(r);const panel=await setting(r,'panel');
        if(request.headers.get('upgrade')?.toLowerCase()==='websocket'){
          if(url.pathname!==`/${panel.api_route}/ws`)fail('not_found',404);
          return await tunnel(r,request,panel);
        }
        if(url.pathname===`/${panel.api_route}/dash`&&request.method==='GET')return dashboard();
        if(url.pathname.startsWith(`/${panel.api_route}/api/`))return await panelApi(r,request,url,panel);
        if(url.pathname===`/${panel.api_route}`&&request.method==='GET')return await serveNodeSubscription(r,url,request,panel);
      }
      return camouflage();
    }catch(error){return requestFailure(error,request,env,r);}
  },
  async scheduled(event,env,execution) {
    let r;
    const work=(async()=>{try{r=runtime(env??{},execution);await scheduled(r,event);}catch(error){requestFailure(error,null,env,r);}})();
    try{if(execution&&typeof execution.waitUntil==='function')execution.waitUntil(work);else await work;}
    catch(error){requestFailure(error,null,env,r);await work;}
  }
};

// ---------------- Self-contained, bilingual web UI; no remote assets, framework or telemetry ----------------
function adminPage() {
  const nonce=randomId(16);
  return new Response(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex,nofollow"><title>NexiUP · مرکز کنترل</title><style nonce="${nonce}">${ADMIN_STYLE}</style></head><body>
    <section id="login-screen" class="login-screen">
      <div class="login-art"><div class="wordmark"><span class="brand-mark">N</span><span dir="ltr">Nexi<span class="accent">UP</span></span></div><div class="login-story"><span class="eyebrow">YOUR NETWORK. YOUR CONTROL.</span><h1 data-i18n="loginTitle">یک نمای روشن<br>از تمام شبکه‌تان.</h1><p data-i18n="loginIntro">مدیریت نودها، اشتراک‌ها و مسیرهای اتصال، در یک پنل مستقل و امن.</p><div class="orbit" aria-hidden="true"><div class="orbit-ring r1"></div><div class="orbit-ring r2"></div><div class="orbit-core">N</div><span class="orbit-node n1">HUB</span><span class="orbit-node n2">NODE</span><span class="orbit-node n3">TLS</span></div></div><span class="login-foot">CLOUDFLARE WORKERS + D1 · SELF-HOSTED</span></div>
      <div class="login-form-wrap"><button class="language-button" data-action="language">English / فارسی</button><div class="login-form-inner"><span class="tiny-label">NEXIUP CONTROL CENTER</span><h2 data-i18n="welcome">به مرکز کنترل خوش آمدید</h2><p class="muted" data-i18n="loginHint">با کلید مدیریت Worker وارد شوید. این کلید در مرورگر ذخیره نمی‌شود.</p><form id="login-form"><label for="admin-key" data-i18n="adminKey">کلید مدیریت</label><input id="admin-key" type="password" autocomplete="off" spellcheck="false" dir="ltr" minlength="32" maxlength="256" required placeholder="WEB_ADMIN_KEY"><button type="submit" class="button primary wide" id="login-button" data-i18n="signIn">ورود امن به پنل</button></form><p id="login-status" role="status" aria-live="polite"></p><div class="login-help"><span class="shield">◇</span><p data-i18n="keyHelp">WEB_ADMIN_KEY؛ اگر تعریف نشده: SETUP_KEY برای hub/all و MASTER_KEY برای node. کلید باید حداقل ۳۲ کاراکتر تصادفی باشد.</p></div><a href="/setup" class="text-link" data-i18n="setupLink">راهنمای آماده‌سازی و مهاجرت دیتابیس ↗</a></div><p class="privacy-note" data-i18n="privacyNote">کوکی HttpOnly · نشست ۳۰ دقیقه‌ای · بدون سرویس تحلیلی بیرونی</p></div>
    </section>
    <div id="app-shell" class="app-shell" hidden>
      <button id="nav-backdrop" class="nav-backdrop" aria-label="Close menu" data-action="menu"></button>
      <aside class="sidebar" id="sidebar"><a class="wordmark" href="#overview"><span class="brand-mark">N</span><span dir="ltr">Nexi<span class="accent">UP</span></span><span class="version-tag">${VERSION}</span></a><div class="workspace"><span class="workspace-icon">W</span><div><strong data-i18n="workspace">فضای مدیریت شما</strong><span id="workspace-role">Workers + D1</span></div><span class="workspace-dot"></span></div><nav id="navigation" aria-label="Navigation"></nav><div class="sidebar-bottom"><div class="private-note"><span>◈</span><div><strong data-i18n="independent">مستقل، در اختیار شما</strong><small data-i18n="noExternalAssets">بدون فایل یا رابط کاربری بیرونی</small></div></div><button class="account" data-action="logout"><span class="avatar">N</span><span><strong data-i18n="owner">مدیر سیستم</strong><small data-i18n="signOut">خروج از نشست امن</small></span><span class="logout-arrow">↗</span></button></div></aside>
      <div class="main-shell"><header class="topbar"><div class="breadcrumbs"><button class="icon-button mobile-menu" data-action="menu" aria-label="Menu" aria-expanded="false" aria-controls="sidebar">☰</button><span data-i18n="controlCenter">مرکز کنترل</span><span class="slash">/</span><strong id="breadcrumb"></strong></div><div class="top-actions"><span class="secure-status"><span></span><span data-i18n="secureSession">نشست امن</span></span><button class="language-button" data-action="language" id="language-toggle">EN</button><span class="avatar small">N</span></div></header>
      <div id="preview-banner" class="preview-banner" hidden data-i18n="previewNotice">پیش‌نمایش محلی با داده‌های ساختگی؛ تست شبکه و تماس با سرویس‌های واقعی در این پیش‌نمایش غیرفعال است.</div>
      <main class="content"><div class="page-heading"><div><div class="tiny-label" id="section-label">WORKSPACE OVERVIEW</div><h1 id="page-title"></h1><p id="page-subtitle" class="muted"></p></div><div id="page-actions" class="actions"></div></div><div id="page-content" aria-live="polite"></div><footer class="page-footer"><span>NexiUP <span id="app-version">${VERSION}</span> · MIT / Font OFL</span><span data-i18n="footerNote">داده‌ها در D1 شما · نتیجهٔ تست، تضمین اتصال نیست</span></footer></main></div>
    </div>
    <dialog id="modal" aria-labelledby="modal-title"><div class="modal-head"><div><span class="tiny-label">NEXIUP / CONTROL</span><h2 id="modal-title"></h2></div><button class="icon-button" data-action="close-modal" aria-label="Close">×</button></div><div id="modal-body"></div><div id="modal-footer" class="modal-footer"></div></dialog>
    <div id="toasts" class="toasts" role="status" aria-live="polite"></div><script nonce="${nonce}">${ADMIN_SCRIPT}</script></body></html>`,{headers:{...noStore,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data: blob:; connect-src 'self'; font-src data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,'X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'}});
}
const ADMIN_STYLE = String.raw`
/*!
 * Embedded unmodified Arabic variable font from @fontsource-variable/vazirmatn 5.3.0.
 * Font bytes: SIL OFL-1.1, not MIT. No runtime font request.
 * Copyright 2015 The Vazirmatn Project Authors (https://github.com/rastikerdar/vazirmatn)
 *
 * This Font Software is licensed under the SIL Open Font License, Version 1.1.
 * This license is copied below, and is also available with a FAQ at:
 * http://scripts.sil.org/OFL
 *
 *
 * -----------------------------------------------------------
 * SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
 * -----------------------------------------------------------
 *
 * PREAMBLE
 * The goals of the Open Font License (OFL) are to stimulate worldwide
 * development of collaborative font projects, to support the font creation
 * efforts of academic and linguistic communities, and to provide a free and
 * open framework in which fonts may be shared and improved in partnership
 * with others.
 *
 * The OFL allows the licensed fonts to be used, studied, modified and
 * redistributed freely as long as they are not sold by themselves. The
 * fonts, including any derivative works, can be bundled, embedded,
 * redistributed and/or sold with any software provided that any reserved
 * names are not used by derivative works. The fonts and derivatives,
 * however, cannot be released under any other type of license. The
 * requirement for fonts to remain under this license does not apply
 * to any document created using the fonts or their derivatives.
 *
 * DEFINITIONS
 * "Font Software" refers to the set of files released by the Copyright
 * Holder(s) under this license and clearly marked as such. This may
 * include source files, build scripts and documentation.
 *
 * "Reserved Font Name" refers to any names specified as such after the
 * copyright statement(s).
 *
 * "Original Version" refers to the collection of Font Software components as
 * distributed by the Copyright Holder(s).
 *
 * "Modified Version" refers to any derivative made by adding to, deleting,
 * or substituting -- in part or in whole -- any of the components of the
 * Original Version, by changing formats or by porting the Font Software to a
 * new environment.
 *
 * "Author" refers to any designer, engineer, programmer, technical
 * writer or other person who contributed to the Font Software.
 *
 * PERMISSION & CONDITIONS
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of the Font Software, to use, study, copy, merge, embed, modify,
 * redistribute, and sell modified and unmodified copies of the Font
 * Software, subject to the following conditions:
 *
 * 1) Neither the Font Software nor any of its individual components,
 * in Original or Modified Versions, may be sold by itself.
 *
 * 2) Original or Modified Versions of the Font Software may be bundled,
 * redistributed and/or sold with any software, provided that each copy
 * contains the above copyright notice and this license. These can be
 * included either as stand-alone text files, human-readable headers or
 * in the appropriate machine-readable metadata fields within text or
 * binary files as long as those fields can be easily viewed by the user.
 *
 * 3) No Modified Version of the Font Software may use the Reserved Font
 * Name(s) unless explicit written permission is granted by the corresponding
 * Copyright Holder. This restriction only applies to the primary font name as
 * presented to the users.
 *
 * 4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
 * Software shall not be used to promote, endorse or advertise any
 * Modified Version, except to acknowledge the contribution(s) of the
 * Copyright Holder(s) and the Author(s) or with their explicit written
 * permission.
 *
 * 5) The Font Software, modified or unmodified, in part or in whole,
 * must be distributed entirely under this license, and must not be
 * distributed under any other license. The requirement for fonts to
 * remain under this license does not apply to any document created
 * using the Font Software.
 *
 * TERMINATION
 * This license becomes null and void if any of the above conditions are
 * not met.
 *
 * DISCLAIMER
 * THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
 * OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
 * COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
 * DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
 * OTHER DEALINGS IN THE FONT SOFTWARE.
 */
  @font-face{font-family:Vazirmatn;font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,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) format('woff2');unicode-range:U+0600-06FF,U+0750-077F,U+0870-08FF,U+200C-200F,U+FB50-FDFF,U+FE70-FEFF}
  :root{--bg:#f6f7fb;--card:#fff;--ink:#22283e;--muted:#8a90a3;--line:#ebedf4;--purple:#7062e7;--purple-dark:#5d50d4;--lavender:#eeebfc;--green:#24957f;--red:#c95768;--sidebar:#181d33;--radius:16px}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Vazirmatn,Tahoma,Arial,sans-serif;font-size:13px;line-height:1.8}html[lang=en] body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}button,input,select,textarea{font:inherit}button,a,input,select,textarea,summary{outline-offset:4px}button{cursor:pointer}button:disabled{opacity:.48;cursor:not-allowed}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #b3aaf5}a{color:inherit;text-decoration:none}[hidden]{display:none!important}h1,h2,h3,p{margin:0}h1{font-size:26px;line-height:1.6;letter-spacing:-.6px}h2{font-size:17px;line-height:1.7}h3{font-size:14px}.muted{color:var(--muted)}.small-text{font-size:11px}.mono,code{font-family:ui-monospace,SFMono-Regular,Consolas,Vazirmatn,monospace;direction:ltr;unicode-bidi:plaintext;font-size:12px}.tiny-label{font-family:system-ui,sans-serif;font-size:10px;font-weight:700;letter-spacing:1.7px;color:#9ba0b5;direction:ltr;text-align:start}.eyebrow{font-family:system-ui,sans-serif;font-size:10px;letter-spacing:2px;color:#a49beb}.wordmark{display:flex;align-items:center;gap:10px;font-family:system-ui,sans-serif;font-size:27px;font-weight:750;letter-spacing:-1px;color:#fff;direction:ltr}.brand-mark{display:grid;place-items:center;width:34px;height:36px;border-radius:10px;background:var(--purple);font-size:24px;font-weight:900;transform:skewY(-5deg);box-shadow:0 5px 15px #14152955}.accent{color:#a99df7}.version-tag{font-size:9px;letter-spacing:0;font-weight:500;margin-inline-start:auto;border:1px solid #3a3f56;border-radius:5px;padding:1px 6px;color:#a7acc4}.app-shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}.sidebar{background:var(--sidebar);color:#9ba2bd;height:100vh;position:sticky;top:0;padding:30px 20px 16px;display:flex;flex-direction:column;overflow:auto}.workspace{display:flex;align-items:center;gap:10px;padding:15px 10px;margin:30px 0 22px;background:#21263e;border:1px solid #2d3249;border-radius:11px}.workspace-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#343750;color:#e0dcff;font:600 13px system-ui}.workspace strong{color:#e4e6ef;display:block;font-size:10px}.workspace div>span{display:block;font:10px system-ui;color:#8a91ae;margin-top:5px}.workspace-dot{width:6px;height:6px;background:#68b7a6;border-radius:100%;margin-inline-start:auto}.nav-label{font-size:9px;letter-spacing:1px;color:#666e8b;margin:16px 13px 8px}.nav-item{display:flex;align-items:center;gap:12px;width:100%;text-align:start;color:#9da5c0;border:0;background:none;border-radius:9px;padding:11px 13px;margin:3px 0;font-size:12px;transition:background .15s,color .15s}.nav-item svg{width:18px;height:18px;opacity:.85}.nav-item:hover{background:#252a42;color:#fff}.nav-item.active{background:var(--purple);color:#fff;box-shadow:0 5px 18px #06082025}.nav-item.active svg{opacity:1}.nav-item .nav-pill{margin-inline-start:auto;padding:0 6px;border-radius:4px;font:9px/18px system-ui;background:#ffffff20}.sidebar-bottom{margin-top:auto;padding-top:22px}.private-note{display:flex;gap:10px;margin:14px 8px 22px;color:#787f9b}.private-note>span{font-size:23px;color:#b1a4ef}.private-note strong{display:block;font-size:10px;color:#b0b6cd}.private-note small{font-size:9px;display:block}.account{width:100%;border:0;border-top:1px solid #30354c;background:none;display:flex;align-items:center;gap:10px;color:#d8dded;padding:19px 0 0;text-align:start}.avatar{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:#e8e3fb;color:#8073cc;font:650 14px system-ui;flex-shrink:0}.avatar.small{width:31px;height:31px;border-radius:50%;font-size:12px}.account strong{display:block;font-size:11px}.account small{display:block;color:#777f9b;font-size:9px}.logout-arrow{margin-inline-start:auto;color:#7e88a6}.main-shell{min-width:0}.topbar{height:75px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;background:#ffffffb3;padding:0 34px;gap:16px}.breadcrumbs{display:flex;align-items:center;gap:13px;font-size:10px;color:#9298ad}.breadcrumbs strong{color:#505970;font-weight:500}.slash{color:#c5c9d7}.top-actions{display:flex;align-items:center;gap:18px}.secure-status{font-size:10px;color:#8b93a7;display:flex;align-items:center;gap:7px}.secure-status>span:first-child{height:5px;width:5px;background:#51aa94;border-radius:50%}.language-button{border:1px solid var(--line);background:#fff;color:#737c95;padding:5px 10px;border-radius:7px;font:11px system-ui}.content{max-width:1510px;margin:0 auto;padding:28px 34px 18px}.page-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:26px}.page-heading .tiny-label{margin-bottom:7px}.page-heading h1{margin-bottom:5px}.page-heading p{font-size:11px}.actions,.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid #e1e4ef;border-radius:9px;background:#fff;color:#626b85;padding:8px 14px;font-size:11px;min-height:38px;white-space:nowrap;transition:background .15s}.button svg{height:15px;width:15px}.button:hover{background:#f7f6fd}.button.primary{background:var(--purple);border-color:var(--purple);color:white;box-shadow:0 4px 8px #7263db15}.button.primary:hover{background:var(--purple-dark)}.button.danger{color:var(--red);border-color:#f1d8dc;background:#fff7f8}.button.subtle{background:#f6f5ff;border-color:#e9e5fb;color:#8b7ccc}.button.small{min-height:29px;padding:4px 9px;font-size:10px;border-radius:7px}.button.wide{width:100%}.icon-button{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:8px;width:32px;height:32px;background:#fff;color:#9097ae;font-size:20px;flex-shrink:0}.icon-button svg{width:15px;height:15px}.icon-button:hover{border-color:#c7bfec;color:var(--purple)}.mobile-menu,.nav-backdrop{display:none}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 3px 10px #252d4e02}.card-head{display:flex;align-items:center;justify-content:space-between;padding:20px 22px 16px;gap:10px}.card-head h2{font-size:13px}.card-head p{font-size:10px;color:var(--muted);margin-top:3px}.card-body{padding:0 22px 20px}.card-head .text-link{font-size:10px}.text-link{color:var(--purple);border:0;background:none;padding:0;font-size:11px;cursor:pointer}.hero{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:156px;padding:26px 30px;margin-bottom:22px;background:#21283e;border:1px solid #2b3349;border-radius:16px;color:#fff;overflow:hidden;position:relative}.hero h2{font-size:19px;margin:5px 0 8px;position:relative;z-index:1}.hero p{font-size:11px;color:#a9b0cb;max-width:470px;position:relative;z-index:1}.hero .hero-actions{display:flex;gap:9px;margin-top:18px;position:relative;z-index:1}.hero .button{min-height:32px;font-size:10px}.hero .button:not(.primary){background:#ffffff08;border-color:#464d66;color:#c9cde0}.hero .tiny-label{color:#9f95db}.hero-art{width:195px;height:132px;flex-shrink:0;opacity:.85;direction:ltr}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:22px}.metric{padding:19px 20px}.metric-top{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:#878ea4}.metric-icon{width:35px;height:35px;border-radius:11px;background:#f0edfd;color:#9a89de;display:grid;place-items:center}.metric-icon svg{width:18px;height:18px}.metric:nth-child(2) .metric-icon{background:#eaf6f2;color:#76baa6}.metric:nth-child(3) .metric-icon{background:#fff3e5;color:#d7ac76}.metric:nth-child(4) .metric-icon{background:#edf1fd;color:#8ba1d0}.metric-value{display:block;font-size:27px;font-weight:700;letter-spacing:-.7px;line-height:1.7;margin:6px 0 1px}.metric-value small{font-size:10px;font-weight:400;letter-spacing:0;margin-inline-start:5px;color:#9299ad}.metric-foot{font-size:9px;color:#9ca3b5}.metric-foot .good{color:#54a28f}.overview-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(230px,1fr);gap:20px;margin-bottom:20px}.chart-wrap{position:relative;padding:4px 20px 0}.chart-wrap svg{width:100%;height:174px;display:block}.chart-summary{display:flex;gap:30px;padding:0 22px 10px;align-items:baseline}.chart-summary strong{font-size:20px}.chart-summary span{font-size:10px;color:var(--muted)}.chart-days{display:flex;justify-content:space-between;color:#a5aabe;font-size:8px;padding:0 12px 12px;direction:ltr}.timeline{padding:0 22px 9px}.timeline-item{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #f3f4f8}.timeline-item:last-child{border:0}.timeline-dot{height:7px;width:7px;background:#a79be0;border:3px solid #f0edfa;box-sizing:content-box;border-radius:50%;margin-top:4px;flex-shrink:0}.timeline-item strong{font-size:10px;font-weight:500;display:block}.timeline-item small{font-size:9px;color:#a5abbd;display:block;margin-top:3px}.timeline-item code{font-size:8px;color:#a5abbd}.table-wrap{overflow-x:auto;width:100%}table{width:100%;border-collapse:collapse;text-align:start;font-size:11px;white-space:nowrap}thead{background:#fbfbfe;color:#929aae;font-size:9px}th{font-weight:500;text-align:start;padding:11px 18px;border-top:1px solid #eff0f6;border-bottom:1px solid #eff0f6}td{padding:15px 18px;border-bottom:1px solid #f0f1f7;vertical-align:middle}tr:last-child td{border-bottom:0}tbody tr:hover{background:#fcfcff}td .subline{display:block;font-size:9px;color:#9aa1b7;max-width:260px;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.cell-name{display:flex;gap:10px;align-items:center}.flag{font-size:21px;line-height:1;display:inline-block;min-width:24px}.badge{display:inline-flex;align-items:center;gap:5px;border-radius:6px;font-size:9px;line-height:1.6;padding:3px 8px;background:#f0f1f7;color:#969db0;white-space:nowrap}.badge.good{background:#eaf6f1;color:#4c9e86}.badge.warn{background:#fff5e7;color:#c59a58}.badge.bad{background:#fceef0;color:#cd8793}.badge.info{background:#f1edfc;color:#9c89d1}.status-dot{width:4px;height:4px;border-radius:50%;background:currentColor}.capacity{min-width:90px}.capacity progress{height:4px;width:85px;vertical-align:middle;margin-inline-end:7px}.capacity small{color:#9ba3b7;font:9px Vazirmatn,system-ui}.page-footer{display:flex;justify-content:space-between;gap:10px;font-size:9px;color:#aeb4c4;border-top:1px solid #e9ebf3;margin-top:28px;padding-top:14px}.page-footer span:first-child{font-family:system-ui}.toolbar{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.filters{display:flex;gap:9px;flex-wrap:wrap;align-items:center}.filters input{min-width:170px}.filters select{max-width:210px}.filters input,.filters select{margin:0;height:36px;font-size:10px;padding:7px 10px}.search{position:relative;display:flex;align-items:center;gap:5px}.search input{padding-inline-start:12px}.search button{margin:0;height:35px}input,select,textarea{border:1px solid #e0e4ef;border-radius:8px;background:#fff;color:#515a74;padding:10px 12px;width:100%;min-width:0;margin:5px 0 10px;font-size:12px}textarea{resize:vertical;min-height:100px;line-height:1.65}input::placeholder,textarea::placeholder{color:#b7bdce;font-size:11px}input[type=checkbox]{width:15px;height:15px;margin:0;accent-color:var(--purple);flex-shrink:0}select{cursor:pointer}input[readonly]{background:#f9f9fc;color:#9c91c9}.filters select,.filters input{width:auto}.tabs{display:flex;gap:7px;border-bottom:1px solid var(--line);padding:0 3px 13px;margin-bottom:20px;flex-wrap:wrap}.tab{border:1px solid transparent;border-radius:7px;background:none;padding:7px 14px;color:#949bb0;font-size:11px}.tab.active{background:var(--lavender);color:var(--purple)}.empty{padding:54px 22px;text-align:center;color:#a1a7bb}.empty-icon{display:grid;place-items:center;width:52px;height:52px;border-radius:16px;background:#f3f1fd;color:#b1a5df;margin:0 auto 15px}.empty-icon svg{width:24px;height:24px}.empty h3{color:#6d758e;margin:0 0 6px;font-size:13px}.empty p{font-size:10px;max-width:450px;margin:auto;white-space:normal}.empty .button{margin-top:20px}.loading{padding:80px 10px;text-align:center;color:#979eb4;font-size:11px}.spinner{display:inline-block;vertical-align:middle;width:17px;height:17px;border:2px solid #e8e4f7;border-top-color:var(--purple);border-radius:50%;animation:spin .8s linear infinite;margin-inline-end:9px}@keyframes spin{to{transform:rotate(360deg)}}.notice{border-radius:10px;padding:13px 16px;margin-bottom:18px;background:#f0eefb;border:1px solid #e6e1f6;color:#9587ba;font-size:10px;line-height:1.9;display:flex;align-items:center;justify-content:space-between;gap:15px}.notice strong{display:block;color:#7f71a7;font-size:11px;margin-bottom:3px}.notice.warning{background:#fff8ec;border-color:#f1e8d3;color:#b59a6c}.notice.warning strong{color:#ac8e52}.notice.neutral{background:#f8f9fd;border-color:#eceef6;color:#969fb8}.notice .button{flex-shrink:0}.proxy-summary{display:flex;align-items:center;gap:25px;margin:0 0 20px;padding:17px 24px;background:#fff;border:1px solid var(--line);border-radius:13px;flex-wrap:wrap}.proxy-stat{display:flex;align-items:center;gap:10px;padding-inline-end:25px;border-inline-end:1px solid var(--line)}.proxy-stat:last-child{border:0;padding:0}.proxy-stat strong{font-size:22px;font-weight:700}.proxy-stat span{font-size:10px;color:#9aa2b8}.proxy-table td{padding-top:16px;padding-bottom:16px}.proxy-table .ip{font-size:12px;color:#69738e;font-weight:500}.proxy-table th:first-child,.proxy-table td:first-child{padding-inline-end:0;width:40px}.table-info{font-size:9px;color:#a8adc0}.table-footer{padding:13px 20px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:10px;color:#a1a8bd}.pager{display:flex;gap:7px}.pager .button{min-width:30px}.test-controls{display:flex;align-items:center;gap:10px;padding:13px 20px;background:#fafafe;border-top:1px solid var(--line);flex-wrap:wrap}.test-controls label{font-size:9px;color:#979fb5}.test-controls select{margin:0;width:auto;max-width:210px;font-size:10px;padding:6px 10px;height:34px}.test-controls .grow{margin-inline-start:auto}.test-progress{padding:13px 20px;border-top:1px solid var(--line);display:flex;gap:14px;align-items:center;color:#9b8bcf;font-size:10px}.test-progress progress{width:140px;height:5px}.selection-bar{position:sticky;bottom:14px;z-index:3;margin-top:18px;display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #dfd8f6;background:#f5f2ffef;backdrop-filter:blur(12px);padding:15px 20px;border-radius:12px;box-shadow:0 5px 15px #3e296509}.selection-title{font-size:11px;color:#8b78b8}.selection-sub{font-size:9px;color:#b0a3cd;margin-top:3px;max-width:500px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.selection-bar select{margin:0;width:auto;font-size:10px;max-width:250px;background:#ffffffb5;padding:7px 10px}.help-line{font-size:9px;color:#a7aec0;margin-top:12px;line-height:1.9}.profiles-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:17px}.profile-card{padding:23px;display:flex;flex-direction:column;gap:14px}.profile-card h2{font-size:14px}.profile-top{display:flex;align-items:center;justify-content:space-between}.profile-logo{width:42px;height:42px;display:grid;place-items:center;border-radius:13px;font:700 13px system-ui;color:#a999d7;background:#f1edfc}.profile-meta{display:grid;grid-template-columns:1fr 1fr;gap:9px;padding:14px 0;border-top:1px solid #f0eef8;border-bottom:1px solid #f0eef8}.profile-meta dt{font-size:9px;color:#a2a8b9}.profile-meta dd{font-size:11px;margin:2px 0 0;overflow-wrap:anywhere}.profile-card .actions{margin-top:auto}.settings-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.setting-card{padding:24px}.setting-card h2{margin:12px 0 8px}.setting-card p{font-size:10px;color:#9ba2b6;margin-bottom:20px}.setting-card .metric-icon{height:39px;width:39px}.editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 20px}.field{min-width:0}.field.full{grid-column:1/-1}.field label{display:block;font-size:11px;color:#727b96;margin:5px 0}.field label .field-code{font:9px system-ui;color:#b3b9c9;margin-inline-start:6px}.field .help-line{margin-top:-5px;margin-bottom:12px}.field.check{display:flex;align-items:center;gap:10px;min-height:45px}.field.check label{display:flex;align-items:center;gap:10px;cursor:pointer}.field.json textarea{font-family:ui-monospace,Consolas,monospace;direction:ltr;text-align:left;font-size:11px;min-height:110px}.editor-actions{display:flex;gap:10px;margin-top:17px}.validation-box{background:#eff8f4;border:1px solid #d3eade;border-radius:9px;padding:11px 15px;color:#70a68a;font-size:10px;margin-top:10px}.json-view{white-space:pre-wrap;overflow-wrap:anywhere;direction:ltr;text-align:left;background:#fafafe;border:1px solid var(--line);border-radius:10px;padding:16px;font:11px/1.8 ui-monospace,Consolas,monospace;max-height:310px;overflow:auto;margin:13px 0}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:17px}.detail-grid div{background:#fafafe;border:1px solid #f0f1f8;border-radius:8px;padding:12px}.detail-grid dt{font-size:9px;color:#aaaec1}.detail-grid dd{font-size:12px;color:#737d96;margin:4px 0 0;overflow-wrap:anywhere}.receipt-image{width:100%;max-height:480px;object-fit:contain;border:1px solid var(--line);border-radius:10px;margin-top:15px}.receipt-caption{white-space:pre-wrap;overflow-wrap:anywhere;color:#9c91b8;font-size:10px;margin:12px 0}.pill-list{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.pill-list code{background:#f6f3fd;border:1px solid #eae5f6;color:#9687bd;border-radius:6px;padding:4px 8px;font-size:10px}dialog{border:1px solid var(--line);border-radius:18px;width:min(740px,calc(100vw - 28px));padding:0;color:var(--ink);box-shadow:0 30px 90px #141c3a25;max-height:92vh}dialog::backdrop{background:#181d335c;backdrop-filter:blur(3px)}.modal-head{display:flex;justify-content:space-between;align-items:center;gap:15px;padding:23px 26px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:#fff;z-index:2}.modal-head h2{font-size:18px;margin-top:5px}#modal-body{padding:23px 26px}.modal-footer{padding:16px 26px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:9px;position:sticky;bottom:0;background:#fff;flex-wrap:wrap}.modal-footer:empty{display:none}.toasts{position:fixed;bottom:23px;inset-inline-end:25px;z-index:100;display:flex;flex-direction:column;gap:8px;max-width:min(460px,calc(100vw - 35px))}.toast{display:flex;align-items:center;gap:12px;border-radius:10px;border:1px solid #dfd9f4;background:#fcfaff;box-shadow:0 8px 30px #303c5620;padding:15px 20px;font-size:11px;color:#9586b8;animation:toast-in .2s ease;white-space:pre-wrap;overflow-wrap:anywhere}.toast-dismiss{border:0;background:none;color:inherit;flex-shrink:0;min-width:28px;min-height:28px;font:20px system-ui;padding:0}.toast.error{border-color:#f1d7de;background:#fff7f9;color:#bd788c}.toast.good{border-color:#d6eae0;background:#f6fcf9;color:#70a38b}@keyframes toast-in{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}progress{border:none;border-radius:9px;background:#eeeaf8;overflow:hidden;accent-color:var(--purple)}progress::-webkit-progress-bar{background:#eeebf6;border-radius:9px}progress::-webkit-progress-value{background:#a395d8;border-radius:9px}.login-screen{min-height:100vh;display:grid;grid-template-columns:1fr 1fr;direction:ltr}.login-art{background:#1b2137;color:#fff;padding:42px 60px;display:flex;flex-direction:column;overflow:hidden;position:relative}.login-story{margin:auto 0;direction:rtl;max-width:430px;padding:45px 0 30px}.login-story h1{font-size:40px;line-height:1.8;margin:17px 0 13px;letter-spacing:-.8px}.login-story p{color:#a5adc9;font-size:12px;line-height:2.1;max-width:350px}.login-foot{font:9px system-ui;letter-spacing:1.6px;color:#697493;position:relative;z-index:1}.orbit{height:220px;position:relative;width:340px;margin:12px auto -15px;direction:ltr}.orbit-ring{width:240px;height:150px;border:1px solid #51506f66;border-radius:50%;position:absolute;left:50px;top:40px;transform:rotate(-23deg)}.orbit-ring.r2{transform:rotate(35deg);width:220px;left:60px}.orbit-core{position:absolute;left:139px;top:87px;display:grid;place-items:center;width:66px;height:66px;border:1px solid #8f81c9;background:#7164a947;border-radius:20px;font:700 40px system-ui;color:#c2b8f2;box-shadow:0 0 70px #7b68d033;transform:rotate(-10deg)}.orbit-node{position:absolute;display:grid;place-items:center;width:55px;height:32px;border-radius:8px;background:#2e334d;border:1px solid #4d4c68;color:#a19dc8;font:8px system-ui;letter-spacing:1px}.orbit-node.n1{left:20px;top:115px}.orbit-node.n2{left:253px;top:55px}.orbit-node.n3{left:225px;top:170px}.login-form-wrap{padding:40px 50px;display:flex;flex-direction:column;direction:rtl}.login-form-wrap>.language-button{align-self:flex-end}.login-form-inner{max-width:355px;width:100%;margin:auto;padding:60px 0}.login-form-inner h2{font-size:24px;margin:12px 0}.login-form-inner>.muted{font-size:11px;line-height:2}.login-form-inner form{margin-top:27px}.login-form-inner label{font-size:11px;color:#8a91a7}.login-form-inner input{height:47px;background:white;margin:9px 0 17px;letter-spacing:1px}.login-form-inner .button{height:45px;font-size:12px}.login-help{display:flex;gap:12px;border-top:1px solid var(--line);padding-top:23px;margin:22px 0 25px;color:#a4acbf;font-size:10px}.shield{font-size:29px;color:#b3a5db;line-height:1.3}.privacy-note{font-size:9px;color:#b6bbca;text-align:center}#login-status{font-size:10px;color:#b78891;margin-top:10px;min-height:18px}.preview-banner{background:#fff7df;color:#b2995f;border-bottom:1px solid #f0e4be;text-align:center;padding:7px 15px;font-size:10px}html[lang=en] .login-story,html[lang=en] .login-form-wrap{direction:ltr}html[lang=en] .login-story h1{font-size:37px;line-height:1.4}
  @media(min-width:1500px){.content{padding-top:34px}.metrics{gap:21px}.metric{padding:24px}.hero{min-height:180px}.hero h2{font-size:23px}.hero-art{width:230px}}
  @media(max-width:1190px){.app-shell{grid-template-columns:208px minmax(0,1fr)}.sidebar{padding:25px 14px 16px}.topbar{padding:0 25px}.content{padding:25px}.metric{padding:16px}.metrics{gap:12px}.metric-value{font-size:23px}.hero{padding:24px}.hero-art{width:140px}.overview-grid{grid-template-columns:minmax(0,1.4fr) minmax(225px,1fr)}.profiles-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.proxy-summary{gap:15px;padding:15px 20px}.selection-bar{flex-wrap:wrap}.login-art{padding:38px}.login-story h1{font-size:33px}.login-form-wrap{padding:35px}.hero p{max-width:380px}}
  @media(max-width:950px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-grid{grid-template-columns:1fr}.hero-art{position:absolute;inset-inline-end:-20px;opacity:.25;width:200px}.hero{min-height:170px}.hero>div:first-child{position:relative;z-index:1}.settings-cards{grid-template-columns:1fr}.page-heading{align-items:flex-start}.page-heading h1{font-size:23px}.page-heading p{max-width:350px}.secure-status{display:none}.login-art{padding:32px}.login-story h1{font-size:28px}.login-story p{font-size:11px}.orbit{transform:scale(.8);transform-origin:left}.login-form-wrap{padding:28px}.login-form-inner h2{font-size:21px}}
  @media(max-width:740px){.app-shell{display:block}.sidebar{position:fixed;visibility:hidden;inset-inline-start:0;z-index:30;width:240px;transform:translateX(110%);transition:transform .2s;box-shadow:-8px 0 30px #161e3a26}html[dir=ltr] .sidebar{transform:translateX(-110%)}.nav-open .sidebar{transform:none!important;visibility:visible}.nav-backdrop{position:fixed;inset:0;width:100%;height:100%;z-index:29;background:#151d3b55;border:0}.nav-open .nav-backdrop{display:block}.mobile-menu{display:inline-flex;width:28px;height:28px;font-size:14px}.topbar{height:61px;padding:0 18px}.breadcrumbs{gap:9px;font-size:9px}.top-actions{gap:10px}.top-actions>.avatar{display:none}.content{padding:22px 17px 15px}.page-heading{gap:10px;margin-bottom:20px}.page-heading h1{font-size:22px}.page-heading .tiny-label{font-size:8px;letter-spacing:1.2px}.page-heading p{font-size:10px;max-width:290px}.page-heading>.actions{justify-content:flex-end}.page-heading>.actions .button{font-size:0;padding:8px 10px;gap:0;width:35px;min-height:35px}.page-heading>.actions .button svg{width:16px;height:16px}.hero{padding:22px;min-height:180px;margin-bottom:16px}.hero h2{font-size:17px}.hero p{font-size:10px;max-width:290px}.hero-art{width:150px;inset-inline-end:-45px}.metrics{gap:12px;margin-bottom:17px}.metric{padding:15px}.metric-value{font-size:24px;margin-top:9px}.metric-top{font-size:10px;gap:5px}.metric-icon{width:30px;height:30px;border-radius:9px}.metric-icon svg{height:15px;width:15px}.metric-foot{font-size:8px}.overview-grid{gap:16px;margin-bottom:16px}.card-head{padding:17px 17px 14px}.card-head h2{font-size:12px}.card-body{padding:0 17px 17px}.chart-summary{padding:0 17px 10px}.chart-wrap{padding:4px 14px 0}.page-footer{font-size:8px;flex-wrap:wrap;line-height:2;gap:5px}.profiles-grid{grid-template-columns:1fr}.toolbar{padding:13px 14px;gap:10px}.filters{width:100%;gap:7px}.filters select{max-width:calc(50% - 4px);flex:1;min-width:100px}.filters .search{width:100%;order:-1}.filters .search input{width:100%;flex:1;min-width:100px}.proxy-summary{gap:10px;justify-content:space-between;padding:13px 15px}.proxy-stat{padding-inline-end:12px;gap:7px}.proxy-stat strong{font-size:18px}.proxy-stat span{font-size:8px;max-width:55px}.notice{font-size:9px;padding:12px 14px;flex-wrap:wrap;gap:10px}.notice strong{font-size:10px}.notice .button{min-height:30px;font-size:9px}.test-controls{padding:13px 14px;gap:7px}.test-controls select{max-width:190px;font-size:9px}.test-controls .grow{margin:0}.test-controls .button{min-height:32px;font-size:10px}.selection-bar{padding:13px 14px;gap:12px;position:relative;bottom:0}.selection-bar .actions{width:100%;gap:6px}.selection-bar select{flex:1;max-width:100%;min-width:140px}.selection-bar .button{font-size:10px;min-height:32px}.selection-sub{max-width:280px;font-size:8px}.table-footer{padding:12px 14px}.table-info{max-width:170px;white-space:normal}.editor-grid{grid-template-columns:1fr}.editor-grid .full{grid-column:auto}.modal-head{padding:19px 19px 16px}.modal-head h2{font-size:16px}#modal-body{padding:20px}.modal-footer{padding:14px 19px}.detail-grid{grid-template-columns:1fr 1fr;gap:9px}.detail-grid dd{font-size:10px}.login-screen{display:block}.login-art{padding:24px 25px;height:235px}.login-art>.wordmark{font-size:23px}.login-art .brand-mark{width:29px;height:31px;font-size:21px}.login-story{padding:25px 0 0;margin:0;max-width:100%;position:relative}.login-story .eyebrow{font-size:8px;letter-spacing:1.2px}.login-story h1{font-size:24px;margin:10px 0 7px;line-height:1.7}.login-story h1 br{display:none}.login-story p{font-size:10px;max-width:265px}.login-story .orbit{position:absolute;right:auto;left:-140px;top:-44px;opacity:.2;transform:scale(.7)}.login-foot{display:none}.login-form-wrap{padding:23px 27px;min-height:calc(100vh - 235px)}.login-form-inner{padding:28px 0;margin:auto}.login-form-wrap>.language-button{font-size:10px}.login-form-inner h2{font-size:22px}.login-help{margin:18px 0 22px;padding-top:20px}.privacy-note{margin:10px 0 0;font-size:8px}.toasts{inset-inline-end:16px;bottom:16px}html[lang=en] .login-story h1{font-size:24px}.preview-banner{font-size:9px}}
  @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

const ADMIN_SCRIPT = String.raw`
  (() => {
    'use strict';
    const S={lang:'fa',session:null,view:'overview',kind:'plans',settingsTab:'bot',filter:{q:'',country:'',state:'',cursor:'',history:[]},items:[],proxy:null,selected:new Set(),mode:'relay',probeNode:'',target:'self',batch:null,editor:null,seq:0,preview:false,importJob:null,importStopped:false,modalAction:null};
    const $=id=>document.getElementById(id);
    const E=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const L={
      d1_binding_missing:['binding دیتابیس با نام DB در این دیپلوی در دسترس نیست. /setup را بررسی کنید.','D1 binding DB is absent in this deployment. Open /setup for checks.'],d1_binding_invalid:['binding با نام DB از نوع D1 معتبر نیست.','The DB binding is not a valid D1 binding.'],d1_binding_unavailable:['خواندن binding دیتابیس ناموفق بود. بررسی دیپلوی را اجرا کنید.','The D1 binding could not be acquired. Run deployment checks.'],d1_unavailable:['دسترسی به D1 ناموفق بود؛ این خطا لزوماً با مهاجرت حل نمی‌شود.','D1 access failed; this is not necessarily a migration issue.'],d1_read_timeout:['مهلت خواندن D1 تمام شد. بررسی خواندنی /setup را اجرا کنید.','D1 read deadline exceeded. Run the read-only /setup checks.'],schema_newer_than_worker:['نسخهٔ دیتابیس جدیدتر از Worker است؛ دیتابیس را پاک نکنید.','Database schema is newer than this Worker. Do not delete the database.'],
      loginTitle:['یک نمای روشن از تمام شبکه‌تان.','A clear view of your entire network.'],loginIntro:['مدیریت نودها، اشتراک‌ها و مسیرهای اتصال، در یک پنل مستقل و امن.','Nodes, subscriptions and connection routes. One private, self-hosted control center.'],welcome:['به مرکز کنترل خوش آمدید','Welcome to your control center'],loginHint:['با کلید مدیریت Worker وارد شوید. این کلید در مرورگر ذخیره نمی‌شود.','Sign in with your Worker admin key. The key is never saved in your browser.'],adminKey:['کلید مدیریت','Admin key'],signIn:['ورود امن به پنل','Sign in securely'],keyHelp:['WEB_ADMIN_KEY؛ اگر تعریف نشده: SETUP_KEY برای hub/all و MASTER_KEY برای node. حداقل ۳۲ کاراکتر تصادفی.','Use WEB_ADMIN_KEY. If unset: SETUP_KEY for hub/all, MASTER_KEY for node. At least 32 random characters.'],setupLink:['آماده‌سازی و مهاجرت دیتابیس ↗','Database setup and migrations ↗'],privacyNote:['کوکی HttpOnly · نشست ۳۰ دقیقه‌ای · بدون سرویس تحلیلی بیرونی','HttpOnly cookie · 30-minute session · No third-party analytics'],workspace:['فضای مدیریت شما','Your workspace'],independent:['مستقل، در اختیار شما','Independent. Yours.'],noExternalAssets:['بدون فایل یا رابط بیرونی','No external UI or assets'],owner:['مدیر سیستم','Workspace owner'],signOut:['خروج از نشست امن','Sign out securely'],controlCenter:['مرکز کنترل','Control center'],secureSession:['نشست امن','Secure session'],footerNote:['داده‌ها در D1 شما · نتیجهٔ تست، تضمین اتصال نیست','Your data in your D1 · A test is not a connectivity guarantee'],previewNotice:['پیش‌نمایش محلی با داده‌های ساختگی؛ تست شبکه و تماس با سرویس‌های واقعی در این پیش‌نمایش غیرفعال است.','Local preview with synthetic data. Live network tests and real external services are disabled in this preview.'],
      not_configured:['آماده نشده','Not configured'],master_key_required_min_32:['برای سرویس‌دهی نود، MASTER_KEY معتبر را در Worker Secrets تعریف کنید.','Set a valid MASTER_KEY in Worker Secrets before serving the node.'],autoPreview:['ورود این نسخه نمایشی خودکار است.','Sign-in is automatic in this disposable preview.'],operationsTitle:['صف و بازیابی صدور','Provisioning queue and recovery'],legacyTools:['پشتیبان و ابزار قدیمی نود','Node backup and legacy tools'],legacyHint:['ابزار قبلی حفظ شده است؛ برای پشتیبان و بازیابی نود، ورود جداگانه با MASTER_KEY لازم است.','The existing tools are preserved. Node backup/restore requires a separate MASTER_KEY sign-in.'],overview:['نمای کلی','Overview'],proxies:['کاوش ProxyIP','ProxyIP explorer'],nodes:['نودها','Nodes'],profiles:['پروفایل اپراتورها','Operator profiles'],orders:['سفارش‌ها','Orders'],subscriptions:['اشتراک‌ها','Subscriptions'],customers:['مشتری‌ها','Customers'],nodeUsers:['حساب‌های نود','Node accounts'],catalog:['کاتالوگ فروش','Sales catalog'],settings:['تنظیمات','Settings'],audit:['گزارش فعالیت','Activity log'],network:['شبکه و اتصال','NETWORK & CONNECTIVITY'],business:['فروش و مشترکین','SALES & SUBSCRIBERS'],management:['مدیریت','MANAGEMENT'],live:['زنده','LIVE'],overviewSub:['وضعیت کسب‌وکار و زیرساخت خود را در یک نگاه ببینید.','Your business and infrastructure, in one place.'],proxiesSub:['کاندیدهای کشورهای مختلف را پیدا کنید، زنده بسنجید و آگاهانه اعمال کنید.','Explore countries, run live diagnostics and apply a fallback deliberately.'],nodesSub:['نودهای فروش و تست؛ بدون تغییر دامنهٔ اشتراک مشتری.','Sales and test nodes, without changing your customer subscription domain.'],profilesSub:['تنظیمات مستقل اپراتورها، با اعتبارسنجی و بازگشت نسخه.','Isolated operator settings, with validation and revision rollback.'],ordersSub:['رسیدها را بررسی کنید؛ تأیید، صدور حساب را در صف قرار می‌دهد.','Review receipts. Approval queues automatic account provisioning.'],subscriptionsSub:['اشتراک‌های ماندگار، وضعیت و کنترل حساب روی نود.','Durable entitlements and account controls on the assigned node.'],customersSub:['کاربران تلگرام، کیف پول و وضعیت دسترسی.','Telegram customers, wallet balances and account access.'],nodeUsersSub:['هویت‌ها و سهمیه‌های واقعیِ همین نود.','Actual account identities and quotas on this node.'],catalogSub:['پلن‌ها، پرداخت‌ها و محتوای ربات؛ ویرایش بدون انتشار دوباره.','Plans, payments and bot content. Edit without redeploying.'],settingsSub:['تنظیمات اعتبارسنجی‌شده و ماندگار در دیتابیس شما.','Validated configuration, persisted in your database.'],auditSub:['رویدادهای مدیریتی، بدون نمایش کلیدهای محرمانه.','Administrative events, without exposing secret keys.'],
      refresh:['تازه‌سازی','Refresh'],add:['افزودن','Add new'],edit:['ویرایش','Edit'],save:['ذخیره و اعمال','Save and apply'],validate:['اعتبارسنجی','Validate'],cancel:['انصراف','Cancel'],close:['بستن','Close'],confirm:['تأیید','Confirm'],search:['جست‌وجو','Search'],searchHint:['نام، شناسه یا شماره کاربر…','Name, ID or user number…'],all:['همه','All'],next:['بعدی','Next'],previous:['قبلی','Previous'],loading:['در حال دریافت اطلاعات…','Loading your data…'],emptyTitle:['هنوز داده‌ای در این بخش نیست','Nothing here yet'],emptyText:['اولین مورد را اضافه کنید یا فیلتر جست‌وجو را تغییر دهید.','Add your first item, or adjust your search filters.'],error:['خطا','Error'],saved:['تغییرات ذخیره شد.','Changes saved.'],completed:['انجام شد.','Done.'],notTested:['تست نشده','Not tested'],noLimit:['بدون سقف تنظیم‌شده','No configured cap'],never:['ثبت نشده','Not recorded'],ago:['آخرین بررسی','Last checked'],details:['جزئیات','Details'],actions:['عملیات','Actions'],name:['نام','Name'],status:['وضعیت','Status'],id:['شناسه','ID'],date:['تاریخ','Date'],country:['کشور','Country'],amount:['مبلغ','Amount'],customer:['مشتری','Customer'],plan:['پلن','Plan'],node:['نود','Node'],expiry:['انقضا','Expiry'],traffic:['مصرف','Usage'],balance:['موجودی کیف پول','Wallet balance'],enabled:['فعال','Enabled'],disabled:['غیرفعال','Disabled'],active:['فعال','Active'],paused:['متوقف','Paused'],expired:['منقضی','Expired'],limited:['سهمیه تمام','Quota reached'],deleted:['حذف‌شده','Deleted'],pending:['در انتظار بررسی','Awaiting review'],pending_payment:['در انتظار پرداخت','Awaiting payment'],processing:['در حال صدور','Provisioning'],done:['تکمیل‌شده','Completed'],rejected:['ردشده','Rejected'],cancelled:['لغوشده','Cancelled'],queued:['در صف','Queued'],creating:['در حال ساخت','Creating'],ready:['آمادهٔ بازیابی','Ready to recover'],failed:['ناموفق','Failed'],reconcile:['نیاز به بررسی','Needs reconciliation'],banned:['مسدود','Banned'],sale:['فروش','Sale'],test:['تست','Test'],renew:['تمدید','Renewal'],topup:['شارژ کیف پول','Wallet top-up'],
      heroTitle:['همهٔ نودها، یک مرکز کنترل','Every node. One control center.'],heroText:['از سفارش تا اتصال، مدیریت را یکپارچه نگه دارید. پروفایل‌ها و مسیرهای جایگزین را بدون تغییر لینک کاربران تنظیم کنید.','From purchase to connection, keep operations in one place. Update profiles and fallback routes without replacing customer links.'],addNode:['افزودن نود','Add a node'],explore:['کاوش مسیرهای اتصال','Explore connection routes'],totalCustomers:['کل مشتری‌ها','Total customers'],weeklyRevenue:['فروش ۷ روز اخیر','7-day sales revenue'],pendingOrders:['رسیدهای در انتظار','Pending receipts'],registeredNodes:['نودهای ثبت‌شده','Registered nodes'],newCustomers:['کاربر جدید در ۷ روز','new customers in 7 days'],awaitReview:['آمادهٔ بررسی مدیر','Ready for review'],infrastructure:['فروش و تست، جداگانه','Sales and tests, isolated'],nodeAccounts:['حساب‌های این نود','Accounts on this node'],proxyCount:['کاندیدهای ProxyIP','ProxyIP candidates'],availableCountries:['کشورهای اعلام‌شده','Claimed countries'],verifiedProxies:['آخرین تست TLS موفق','Latest TLS tests passed'],revenueChart:['روند فروش','Sales activity'],sevenDays:['۷ روز اخیر','Last 7 days'],recentActivity:['آخرین فعالیت‌ها','Recent activity'],viewAll:['مشاهدهٔ همه','View all'],noSales:['هنوز فروش تکمیل‌شده‌ای ثبت نشده.','No completed sales recorded yet.'],capacity:['ظرفیت ثبت‌شده','Registered capacity'],health:['دسترسی API','API reachability'],healthCheck:['بررسی اتصال','Check API'],apiReachable:['API پاسخگو','API reachable'],apiNotChecked:['بررسی نشده','Not checked'],role:['نقش','Role'],local:['محلی','Local'],remote:['راه دور','Remote'],purpose:['کاربری','Purpose'],sales:['فروش','Sales'],startSetup:['تنظیم دامنهٔ اصلی','Set main domain'],setupWarning:['دامنهٔ اصلی تنظیم نشده؛ پیش از فروش، بخش تنظیمات ربات را کامل کنید.','Main domain is not configured. Complete Bot settings before taking orders.'],
      sourceOff:['منبع عمومی هنوز خاموش است','Public source is off'],sourceOffText:['دریافت فهرست فقط با انتخاب شما انجام می‌شود. داده‌ها را از منبع تنظیم‌شده بگیرید یا فایل خودتان را وارد کنید.','The list is fetched only at your request. Opt in to the configured source, or import your own file.'],sourceOn:['فهرست عمومی، نه تضمین کیفیت','A public list, not a guarantee'],sourceOnText:['کشور ستون اول، ادعای منبع است. فقط TLS/trace موفق، خروجیِ مشاهده‌شدهٔ همان تست را نشان می‌دهد.','The first country column is a source claim. Only a successful TLS/trace test provides observed exit evidence for that probe.'],fetchList:['دریافت فهرست','Fetch catalog'],importList:['ورود JSON / CSV','Import JSON / CSV'],sourceSettings:['تنظیمات منبع','Source settings'],allCountries:['همهٔ کشورها','All countries'],allStates:['همهٔ نتایج','All results'],proxySearch:['IP، دامنه یا ارائه‌دهنده…','IP, domain or provider…'],endpoint:['آدرس و پورت','Endpoint'],claimedCountry:['کشورِ منبع','Source country'],observedExit:['خروجیِ مشاهده‌شده','Observed exit'],testResult:['نتیجهٔ آخرین تست','Latest test result'],latency:['زمان پاسخ','Latency'],noExit:['هنوز تأیید نشده','Not verified'],testNow:['تست زنده','Test live'],tcp_ok:['TCP پاسخگو','TCP reachable'],relay_ok:['TLS / trace تأیید شد','TLS / trace verified'],relay_failed:['TCP باز؛ مسیر تأیید نشد','TCP open; route unverified'],tcp_failed:['اتصال ناموفق','TCP failed'],reported_ok:['سرویس بیرونی: موفق','Checker reports success'],reported_failed:['سرویس بیرونی: ناموفق','Checker reports failure'],untested:['تست نشده','Untested'],testing:['در حال تست…','Testing…'],stale:['قدیمی','Stale'],testPage:['تست این صفحه','Test this page'],stop:['توقف','Stop'],probeMode:['روش','Method'],probeOrigin:['از','From'],thisWorker:['همین Worker','This Worker'],relayMode:['TLS + trace واقعی','TLS + actual trace'],tcpMode:['فقط اتصال TCP','TCP connection only'],externalMode:['گزارش سرویس بیرونی','External checker report'],remainingTests:['تست باقی‌ماندهٔ امروز','tests left today'],candidateCount:['کاندید موجود','candidates'],countryCount:['کشور در فهرست','countries in catalog'],verifiedCount:['نتیجهٔ TLS موفق','successful TLS results'],selected:['انتخاب‌شده','selected'],selectHelp:['حداکثر ۴ مسیر جایگزین انتخاب کنید.','Select up to 4 fallback routes.'],applySelected:['اعمال انتخاب‌ها','Apply selection'],rollback:['بازگشت نسخه','Roll back'],clearSelection:['پاک‌کردن انتخاب','Clear selection'],selfTarget:['همین نود · fallback عمومی','This node · global fallback'],newAccounts:['حساب‌های جدید','new accounts'],proxyCaution:['فقط IPهای مجاز را تست کنید. TCP به‌تنهایی سلامت پروکسی نیست. نتیجه از Worker سنجیده می‌شود، نه از اینترنت ایران. توقف، شروع تست‌های بعدی را لغو می‌کند؛ درخواست جاری ممکن است کامل شود.','Test only addresses you are allowed to use. TCP alone does not prove a working relay. Measurements are from the Worker, not Iranian networks. Stop prevents new tests; an in-flight request may still finish.'],fallbackNotice:['ProxyIP جایگزین است؛ اتصال مستقیم همچنان اولویت دارد و همهٔ ترافیک را به کشور انتخاب‌شده نمی‌برد. تغییر عمومی، override اختصاصی کاربران را عوض نمی‌کند.','ProxyIP is a fallback. Direct connections still take priority; it does not force all traffic through the selected country. Global changes do not replace per-user overrides.'],futureNotice:['این انتخاب فقط به حساب‌هایی که هاب از این پس روی نود می‌سازد اعمال می‌شود. حساب‌های موجود و تنظیمات master نود تغییر نمی‌کنند.','This selection is added only to accounts the hub creates on this node from now on. Existing accounts and node master settings are unchanged.'],applyWarning:['اعمال امن به تست TLS/trace موفقِ همین مقصد در ۳۰ دقیقهٔ اخیر نیاز دارد.','Safe apply requires a successful TLS/trace probe from the target within the last 30 minutes.'],allowUnverified:['با مسئولیت خودم، IPهای مجاز را بدون تأیید تازهٔ این مقصد اعمال می‌کنم.','I accept the risk of applying authorized addresses without fresh verification from this target.'],clearFallback:['خالی کردن فهرست جایگزین','Clear fallback list'],rollbackText:['تنها فهرست قبلی این مقصد بازگردانده می‌شود؛ تغییر خودکار حساب‌های موجود انجام نمی‌شود.','Restore the preceding list for this target. Existing per-account overrides are not automatically changed.'],sourceConsent:['دریافت با رضایت شما','Fetch with your consent'],sourceConsentText:['این گزینه دریافت دستی از URL زیر را فعال می‌کند. ارائه‌دهنده درخواست شبکه و در حالت سنجش، IP انتخابی را دریافت می‌کند؛ برنامه هیچ UUID، کلید یا لینک اشتراکی نمی‌فرستد. فرادادهٔ شبکه تابع رفتار Cloudflare است. فهرست‌شدن IP، مجوز استفاده یا تضمین سلامت نیست.','This enables manual fetches from the URL below. The provider receives the network request and, for a checker, the candidate IP. The app sends no UUID, key or subscription URL. Platform metadata follows Cloudflare behavior. Listing does not prove permission or reliability.'],enableFetch:['فعال‌سازی و دریافت','Enable and fetch'],importHint:['JSON با آرایهٔ data یا آرایهٔ مستقیم؛ یا هر خط CSV ساده: country,endpoint,label. فیلد label اختیاری است. حداکثر ۱ MiB و ۲۰۰۰ رکورد؛ هر درخواست ۲۰ رکورد.','A JSON array (or data array), or simple CSV lines: country,endpoint,label. Label is optional. Maximum 1 MiB / 2,000 records; 20 rows per request.'],chooseFile:['انتخاب فایل','Choose file'],pasteList:['محتوای JSON یا CSV را وارد کنید','Paste JSON or CSV data'],startImport:['شروع ورود','Start import'],importProgress:['در حال ذخیرهٔ مرحله‌ای فهرست…','Saving the catalog in bounded pages…'],imported:['ذخیره‌شده','saved'],skipped:['ردشده','rejected'],importComplete:['ورود فهرست تمام شد. هیچ IP خودکار اعمال نشده است.','Import finished. No IP was automatically applied.'],importPartial:['فقط بخشی از منبع وارد شد؛ شمار رکوردهای ردشده یا محدودیت را بررسی کنید.','The import was partial. Check rejected rows and the catalog limit.'],resume:['ادامه','Resume'],unknownCountry:['نامشخص','Unknown'],measuredFrom:['محل اجرای تست','Probe location'],removeEntry:['حذف از فهرست','Remove from catalog'],removeEntryHelp:['فقط رکورد کشف حذف می‌شود؛ تنظیمات زندهٔ نود دست‌نخورده می‌ماند.','Only discovery metadata is removed. Active node settings are left unchanged.'],
      bot:['ربات و کسب‌وکار','Bot and business'],panel:['تنظیمات همین نود','This node settings'],testSettings:['تست رایگان','Test accounts'],proxy:['منبع و بودجهٔ ProxyIP','ProxyIP source and budget'],keys:['کلیدهای API نود','Node API keys'],plans:['پلن‌ها','Plans'],payments:['روش‌های پرداخت','Payment methods'],guides:['راهنماها','Guides'],channels:['کانال‌های اجباری','Required channels'],coupons:['کدهای تخفیف','Coupons'],texts:['متن‌های ربات','Bot texts'],botHint:['دامنهٔ اصلی، پشتیبانی، پرداخت و شرایط استفاده.','Main domain, support, payment rules and Terms.'],panelHint:['پروتکل، مسیر API، IP تمیز، ProxyIP و توقف کلی نود.','Protocol, API route, clean IPs, ProxyIPs and node kill switch.'],testHint:['نود مستقل، سهمیه، مدت و فاصلهٔ صدور تست.','Designated node, quotas, validity and test cooldown.'],proxyHint:['منبع عمومی و سرویس سنجش به‌صورت پیش‌فرض خاموش‌اند.','Public catalog and external checker are disabled by default.'],keysHint:['فقط نام مرجع Secret ثبت می‌شود؛ خود کلید را در Cloudflare تعریف کنید.','Register the Secret name only. Set the actual value in Cloudflare.'],secretReference:['نام مرجع Secret','Secret reference'],registerKey:['ثبت مرجع کلید','Register key reference'],revoke:['لغو دسترسی','Revoke'],revokeText:['این کلید API بلافاصله از فهرست مجاز حذف می‌شود. مقدار Secret در Cloudflare حذف نمی‌شود.','Remove this key from the allowed registry. The Cloudflare Secret itself is not deleted.'],version:['نسخه','Revision'],fingerprint:['اثر انگشت TLS','TLS fingerprint'],echCount:['گونه‌های ECH','ECH variants'],mask:['Final Mask','Final Mask'],activeProfile:['فعال در اشتراک‌ها','Enabled in subscriptions'],isolatedProfile:['تغییر این پروفایل، پروفایل دیگر را عوض نمی‌کند. دو resolver از ECH، دو گونهٔ مستقل می‌سازند.','Profiles stay isolated. Two ECH resolvers produce two separate variants.'],profileRollbackText:['آخرین نسخهٔ قبلی با شمارهٔ جدید فعال می‌شود. لینک‌های فعلی تغییر نمی‌کنند.','Activate the preceding revision as a new version. Existing subscription links are preserved.'],form:['فرم','Form'],json:['JSON پیشرفته','Advanced JSON'],validSuccess:['اعتبارسنجی موفق بود. برای ثبت ماندگار، «ذخیره و اعمال» را بزنید.','Validation passed. Choose Save and apply to persist the change.'],validateFirst:['ابتدا دادهٔ فعلی را اعتبارسنجی کنید.','Validate the current values first.'],editorHelp:['همهٔ تغییرات در سمت سرور دوباره اعتبارسنجی می‌شوند. مقادیر واقعی زیرساخت خودتان را وارد کنید.','The server validates every change again. Supply your own real infrastructure values.'],immutableId:['شناسهٔ مورد موجود را تغییر ندهید؛ یک مورد جدید بسازید.','Do not change an existing ID. Create a new item instead.'],technicalSettings:['از ۰ برای حذف سقف استفاده نکنید مگر آگاهانه؛ محدودیت‌های Cloudflare همچنان برقرارند.','Use zero to remove a quota only deliberately. Cloudflare limits still apply.'],
      approve:['تأیید رسید','Approve receipt'],reject:['رد رسید','Reject receipt'],approveText:['رسید را بررسی کرده‌اید؟ این کار اعتبار کیف پول یا صف صدور را به‌صورت ماندگار تغییر می‌دهد.','Have you reviewed the receipt? This changes wallet credit or queues provisioning durably.'],reason:['دلیل','Reason'],receipt:['مشاهدهٔ رسید','View receipt'],receiptNote:['متن همراه رسید','Receipt note'],toggle:['توقف / ادامه','Pause / resume'],resetUsage:['صفرکردن مصرف','Reset usage'],delete:['حذف','Delete'],dangerConfirm:['این عملیات روی حساب واقعی اجرا می‌شود. ادامه می‌دهید؟','This changes the real account. Continue?'],walletAdjust:['اصلاح کیف پول','Adjust wallet'],walletHint:['مبلغ مثبت برای افزایش و منفی برای کسر. درخواست تکراری همین فرم دوباره اعمال نمی‌شود.','Positive adds credit, negative deducts. Retrying this same form does not apply the adjustment twice.'],ban:['مسدود کردن','Ban user'],unban:['رفع مسدودی','Unban user'],resetCooldown:['بازنشانی فاصلهٔ تست','Reset test cooldown'],retry:['تلاش مجدد امن','Safe retry'],operationHint:['نتیجهٔ مبهم در نود را پیش از اقدام دستی بررسی کنید. بازنشانی کورکورانه ممکن است حساب تکراری بسازد.','Verify ambiguous node outcomes before manual recovery. Blind retries can create duplicate accounts.'],normalRetry:['تلاش معمول','Normal retry'],confirmedAbsent:['در نود بررسی کردم؛ حساب وجود ندارد','I checked the node; account is absent'],confirmedReset:['تأیید می‌کنم مصرف قبلاً صفر شده','I confirm usage was already reset'],accountIdentity:['شناسه و لینک، محرمانه‌اند. نام تصادفی حساب را کوتاه یا قابل حدس نکنید.','The identity and subscription link are secrets. Keep account names long and random.'],download:['دریافت فایل','Download file'],rowCount:['ردیف در این صفحه','rows on this page'],
      version_conflict:['نسخه قدیمی شده؛ مورد را دوباره باز کنید.','Stale revision. Reopen the item before saving.'],unauthorized:['نشست معتبر نیست؛ دوباره وارد شوید.','Your session is not valid. Sign in again.'],auth_throttled:['تلاش ورود زیاد بوده؛ یک دقیقه صبر کنید.','Too many sign-in attempts. Wait one minute.'],csrf_failed:['درخواست امنیتی معتبر نیست؛ صفحه را دوباره باز کنید.','Security token failed. Reload and sign in again.'],web_admin_secret_required_min_32:['ابتدا WEB_ADMIN_KEY یا کلید جایگزین معتبر را در Worker Secrets تعریف کنید.','Set WEB_ADMIN_KEY or its valid fallback in Worker Secrets first.'],external_catalog_opt_in_required:['دریافت از منبع بیرونی را ابتدا فعال کنید.','Enable external catalog fetching first.'],external_checker_opt_in_required:['سرویس سنجش بیرونی هنوز فعال نیست.','The external checker has not been enabled.'],fresh_target_relay_test_or_explicit_override_required:['تست TLS تازه از مقصد انتخاب‌شده لازم است؛ یا ریسک اعمال تأییدنشده را صریح بپذیرید.','Run a fresh TLS probe from the selected target, or explicitly accept an unverified override.'],proxy_daily_test_budget:['بودجهٔ روزانهٔ تست تمام شده است (بازنشانی UTC).','Daily probe budget reached (resets at UTC midnight).'],rate_limited:['برای درخواست بعدی کمی صبر کنید.','Wait before the next request.'],insufficient_balance:['موجودی کافی نیست.','Insufficient balance.'],preview_network_disabled:['شبکهٔ واقعی در این پیش‌نمایش غیرفعال است؛ بعد از استقرار روی Worker تست کنید.','Real networking is disabled in this preview. Test after deploying to your Worker.'],no_proxy_rollback:['نسخهٔ قبلی برای این مقصد وجود ندارد.','There is no preceding list for this target.'],proxy_changed_since_apply:['ProxyIP پس از اعمال، دستی تغییر کرده؛ بازگشت خودکار متوقف شد.','ProxyIPs changed manually after apply. Automatic rollback was blocked.'],remote_probe_requires_nexiup_2_1:['تست از نود راه دور به NexiUP 2.1 یا جدیدتر نیاز دارد.','Remote probes require NexiUP 2.1 or later on that node.'],catalog_source_unavailable:['منبع پاسخ معتبر نداد؛ فهرست قبلی حفظ شد.','Source unavailable. Your preceding catalog is preserved.']
    };
    const F={id:'شناسه',name:'نام',label:'عنوان',label_en:'عنوان انگلیسی',description:'توضیحات',enabled:'فعال',base_url:'دامنهٔ واقعی نود (HTTPS)',api_route:'مسیر API',api_key_ref:'نام Secret کلید API نود',max_users:'حداکثر کاربران نود',code:'کد موقعیت',purpose:'کاربری نود',adapter:'نوع API',local:'نود محلی در همین Worker',days:'مدت (روز)',daily_gb:'سقف روزانه (GiB)',total_gb:'سقف کل (GiB)',conn_limit:'اتصال هم‌زمان',price:'قیمت',locations:'موقعیت‌های مجاز',reset_usage:'صفرکردن مصرف هنگام تمدید',max_configs:'حداکثر کانفیگ پایه',fingerprint:'اثر انگشت TLS',ech:'Resolverهای مستقل ECH',finalmask:'تنظیمات Final Mask',cipher_suites:'Cipher Suites',main_url:'دامنهٔ اصلی اشتراک (HTTPS)',support:'راه ارتباط با پشتیبانی',currency:'واحد پول',maintenance:'حالت نگهداری',announcement:'اطلاعیه',order_hours:'مهلت پرداخت (ساعت)',referral_percent:'درصد معرف',first_discount_percent:'تخفیف اولین خرید (%)',topup_bonus_percent:'پاداش شارژ (%)',min_topup:'حداقل شارژ',min_withdrawal:'حداقل برداشت',max_pending:'حداکثر سفارش باز هر کاربر',daily_report_hour:'ساعت گزارش (UTC)',terms_fa:'شرایط فارسی',terms_en:'شرایط انگلیسی',guides_fa:'راهنمای فارسی',guides_en:'راهنمای انگلیسی',bot_username:'نام کاربری ربات',traffic_gb:'سهمیهٔ تست (GiB)',cooldown_hours:'فاصلهٔ صدور (ساعت)',node_id:'شناسهٔ نود تست',allow_sales_node:'اجازهٔ صریح تست روی نود فروش',protocol:'پروتکل',clean_ips:'IPهای تمیز',proxy_ips:'ProxyIPهای جایگزین',user_nodes:'دامنه‌های نود',ports:'پورت‌های TLS',paused:'توقف عمومی نود',dns_url:'Resolver HTTPS برای DNS',usage_flush_seconds:'فاصلهٔ ثبت مصرف (ثانیه)',max_tunnel_seconds:'عمر تونل (ثانیه)',auto_update:'بروزرسانی خودکار (غیرفعال)',remote_deploy:'اجرای کد راه دور (غیرفعال)',repository:'مخزن مرجع',source_url:'URL فهرست عمومی',external_enabled:'اجازهٔ دریافت دستی از منبع بیرونی',checker_url:'URL سرویس سنجش بیرونی',checker_enabled:'اجازهٔ ارسال IP انتخابی به سرویس سنجش',timeout_ms:'مهلت کل تست (میلی‌ثانیه)',daily_test_limit:'بودجهٔ تست در هر روز UTC',details:'جزئیات پرداخت',instructions:'دستور پرداخت',title:'عنوان',title_en:'عنوان انگلیسی',text:'متن',text_en:'متن انگلیسی',chat_id:'شناسهٔ کانال',invite_url:'لینک دعوت',type:'نوع',value:'مقدار',max_uses:'کل دفعات مجاز',per_user:'دفعات هر کاربر',minimum:'حداقل مبلغ خرید',expires_at:'زمان انقضا (Unix ms)',fa:'متن فارسی',en:'متن انگلیسی',trafficLimit:'سقف کل (GiB)',dailyLimit:'سقف روزانه (GiB)',expiryDays:'مدت (روز)',expiryMs:'انقضا (Unix ms؛ صفر بدون انقضا)',notes:'یادداشت',connLimit:'اتصالات هم‌زمان',maxConfigs:'حداکثر کانفیگ پایه',proxyIp:'ProxyIP اختصاصی (جدا با کاما)',cleanIp:'IP تمیز اختصاصی',userNodes:'دامنه‌های اختصاصی',userPanelUrl:'دامنهٔ پنل کاربر',userMode:'نوع پروتکل کاربر',userPorts:'پورت‌ها (جدا با کاما)',isPaused:'توقف حساب'};
    const t=k=>(L[k]||[k,k])[S.lang==='fa'?0:1];
    const label=k=>S.lang==='fa'?(F[k]||t(k)):((L[k]||[])[1]||k.replace(/_/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2'));
    const num=n=>Number(n||0).toLocaleString(S.lang==='fa'?'fa-IR':'en-US',{maximumFractionDigits:2});
    const date=n=>n?new Date(Number(n)).toLocaleString(S.lang==='fa'?'fa-IR':'en-GB',{dateStyle:'short',timeStyle:'short'}):t('never');
    const flag=cc=>/^[A-Z]{2}$/.test(cc||'')&&cc!=='ZZ'?String.fromCodePoint(...[...cc].map(c=>127397+c.charCodeAt(0))):'◈';
    const country=cc=>{if(!cc||cc==='ZZ')return t('unknownCountry');try{return new Intl.DisplayNames([S.lang],{type:'region'}).of(cc)||cc;}catch{return cc;}};
    const byte=n=>Number(n)>=1073741824?num(Number(n)/1073741824)+' GiB':num(Number(n||0)/1048576)+' MiB';
    const PATHS={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18 M12 3c-5 5-5 13 0 18',server:'M4 3h16v7H4z M4 14h16v7H4z M7 6h1 M7 17h1 M12 6h5 M12 17h5',sliders:'M5 3v6 M5 13v8 M12 3v10 M12 17v4 M19 3v3 M19 10v11 M2 9h6v4H2z M9 13h6v4H9z M16 6h6v4h-6z',receipt:'M5 3h14v18l-3-2-4 2-4-2-3 2z M8 8h8 M8 12h6',link:'M9 15l6-6 M8 7l2-2a5 5 0 0 1 7 7l-2 2 M16 17l-2 2a5 5 0 0 1-7-7l2-2',users:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-3a6 6 0 0 1 12 0v3 M18 4a4 4 0 0 1 0 7 M20 21v-3a6 6 0 0 0-2-4',key:'M11 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0 M11 8h11 M17 8v4 M21 8v3',box:'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 5 9-5 M12 12v9 M7 5l10 5',settings:'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l4 2',refresh:'M20 7V3l-3 3a8 8 0 1 0 3 9 M20 7h-5',plus:'M12 5v14 M5 12h14',arrow:'M5 12h14 M13 6l6 6-6 6',play:'M7 4l14 8-14 8z',upload:'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',download:'M12 3v13 M7 11l5 5 5-5 M4 17v4h16v-4',pulse:'M2 12h5l3-8 4 16 3-8h5',eye:'M2 12c5-9 15-9 20 0-5 9-15 9-20 0 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',trash:'M3 6h18 M9 3h6 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',check:'M4 12l5 5L20 6',stop:'M5 5h14v14H5z',wallet:'M3 5h17v15H3z M3 5l14-3v3 M15 10h6v6h-6z'};
    const icon=k=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(PATHS[k]||PATHS.grid)+'"/></svg>';
    const btn=(action,text,i='',cls='',attrs='')=>'<button type="button" class="button '+cls+'" data-action="'+action+'" '+attrs+' aria-label="'+E(text)+'">'+(i?icon(i):'')+E(text)+'</button>';
    const pill=(text,cls='')=>'<span class="badge '+cls+'"><span class="status-dot"></span>'+E(text)+'</span>';
    const status=state=>pill(t(state),['active','done','relay_ok','tcp_ok','enabled'].includes(state)?'good':['pending','processing','creating','queued','reconcile','relay_failed'].includes(state)?'warn':['failed','rejected','banned','tcp_failed','reported_failed'].includes(state)?'bad':state==='reported_ok'?'info':'');
    const navs=[['overview','overview','grid','network'],['proxies','proxies','globe'],['nodes','nodes','server'],['profiles','profiles','sliders'],['node-users','nodeUsers','key'],['orders','orders','receipt','business'],['subscriptions','subscriptions','link'],['customers','customers','users'],['catalog','catalog','box'],['settings','settings','settings','management'],['audit','audit','clock']];
    function available(v){return !((S.session?.role==='node'&&['nodes','orders','subscriptions','customers','catalog'].includes(v))||(S.session?.role==='hub'&&v==='node-users'));}
    function translate(){document.documentElement.lang=S.lang;document.documentElement.dir=S.lang==='fa'?'rtl':'ltr';document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.dataset.i18n));$('language-toggle').textContent=S.lang==='fa'?'EN':'فا';document.title='NexiUP · '+t('controlCenter');}
    function navigation(){let out='';for(const [v,key,i,group]of navs){if(!available(v))continue;if(group)out+='<div class="nav-label">'+t(group)+'</div>';out+='<button class="nav-item '+(S.view===v?'active':'')+'" data-action="navigate" data-view="'+v+'" '+(S.view===v?'aria-current="page"':'')+'>'+icon(i)+'<span>'+t(key)+'</span>'+(v==='proxies'?'<span class="nav-pill">IP</span>':'')+'</button>';}$('navigation').innerHTML=out;$('workspace-role').textContent=(S.session?.role||'').toUpperCase()+' / WORKERS + D1';}
    function toast(text,kind=''){const parent=$('toasts');while(parent.children.length>=3)parent.firstElementChild.remove();const node=document.createElement('div');node.className='toast '+kind;const message=document.createElement('span');message.textContent=text;const close=document.createElement('button');close.type='button';close.className='toast-dismiss';close.textContent='×';close.setAttribute('aria-label',t('close'));close.addEventListener('click',()=>node.remove());node.append(message,close);parent.appendChild(node);setTimeout(()=>node.remove(),7000);}
    function uiError(error){return t(error.code||error.message||'error')+(error.reference?' · ID: '+error.reference:'')+(error.version?' · v'+error.version:'');}
    function apiError(data,response){const error=new Error(data.error||'request_failed');error.code=data.error;error.retry=Number(response.headers.get('retry-after')||0);error.reference=/^[a-f0-9]{24}$/.test(data.request_id)?data.request_id:'';error.version=/^\d+\.\d+\.\d+$/.test(data.version)?data.version:'';return error;}
    function showError(error){if(error?.name==='AbortError')return;toast(uiError(error)+(error.retry?' · '+num(error.retry)+'s':''),'error');}
    async function api(path,options={}){
      const headers={Accept:'application/json'};if(options.body!==undefined)headers['Content-Type']='application/json';
      if(S.session?.csrf)headers['X-NexiUP-CSRF']=S.session.csrf;if(options.nonce)headers['Idempotency-Key']=options.nonce;
      const response=await fetch('/admin/web-api/'+path,{method:options.method||'GET',headers,credentials:'same-origin',cache:'no-store',signal:options.signal,...(options.body!==undefined?{body:JSON.stringify(options.body)}:{})});
      const data=await response.json().catch(()=>({error:'invalid_response'}));
      if(!response.ok){if(response.status===401&&S.session)showLogin();throw apiError(data,response);}return data;
    }
    function showLogin(){S.session=null;S.seq++;stopBatch();S.items=[];S.proxy=null;S.selected.clear();S.editor=null;S.modalAction=null;S.importStopped=true;closeModal();$('page-content').innerHTML='';$('modal-body').innerHTML='';$('app-shell').hidden=true;$('login-screen').hidden=false;$('admin-key').value='';document.body.classList.remove('nav-open');}
    function openApp(data){S.session=data;S.preview=!!data.preview;$('app-version').textContent=data.version;$('preview-banner').hidden=!S.preview;$('app-shell').hidden=false;$('login-screen').hidden=true;translate();if(data.auto_login)$('preview-banner').textContent+=' '+t('autoPreview');go((location.hash||'#overview').slice(1));}
    function resetFilter(){S.filter={q:'',country:'',state:'',cursor:'',history:[]};}
    function go(view){if(!S.session)return;stopBatch();if(!navs.some(v=>v[0]===view)||!available(view))view='overview';if(S.view!==view)resetFilter();S.view=view;history.replaceState(null,'','#'+view);document.body.classList.remove('nav-open');document.querySelector('.mobile-menu').setAttribute('aria-expanded','false');load().catch(showError);}
    function header(){navigation();const found=navs.find(n=>n[0]===S.view),key=found?.[1]||'overview';$('breadcrumb').textContent=t(key);$('page-title').textContent=t(key);$('page-subtitle').textContent=t(key+'Sub');$('section-label').textContent=S.view==='proxies'?'NETWORK / PROXYIP EXPLORER':S.view==='overview'?'WORKSPACE OVERVIEW':'WORKSPACE / '+S.view.replace('-',' ').toUpperCase();let actions=btn('refresh',t('refresh'),'refresh');if(['nodes','profiles','catalog','node-users'].includes(S.view))actions=btn('new',t('add'),'plus','primary')+actions;if(S.view==='proxies')actions=btn('sync',t('fetchList'),'download','primary')+btn('import',t('importList'),'upload')+actions;$('page-actions').innerHTML=actions;}
    function query(extra={}){return new URLSearchParams({q:S.filter.q,cursor:S.filter.cursor,status:S.filter.state,...extra}).toString();}
    async function load(){if(!S.session)return;const seq=++S.seq;header();$('page-content').innerHTML='<div class="loading"><span class="spinner"></span>'+t('loading')+'</div>';let content='';
      try{
        if(S.view==='overview'){const d=await api('overview');if(seq!==S.seq)return;content=overview(d);}
        else if(S.view==='proxies'){const d=await api('proxy/list?'+query({country:S.filter.country,state:S.filter.state}));if(seq!==S.seq)return;S.proxy=d;S.items=d.items;S.next=d.next;content=proxyView(d);}
        else if(S.view==='settings'){if(seq!==S.seq)return;content=settingsView();}
        else if(S.view==='audit'){const d=await api('audit?'+new URLSearchParams(S.filter.cursor?{before:S.filter.cursor}:{}));if(seq!==S.seq)return;S.items=d.items;S.next=d.next;content=auditsView(d.items);}
        else if(S.view==='profiles'){const d=await api('catalog?kind=profiles');if(seq!==S.seq)return;S.items=d.items;content=profilesView(d.items);}
        else{const path=['catalog','nodes'].includes(S.view)?'catalog?'+query({kind:S.view==='nodes'?'nodes':S.kind}):S.view+'?'+query();const d=await api(path);if(seq!==S.seq)return;S.items=d.items;S.next=d.next;content=listView(d.items);}
        if(seq!==S.seq||!S.session)return;$('page-content').innerHTML=content;
      }catch(error){if(seq===S.seq&&S.session)$('page-content').innerHTML='<section class="card">'+empty(uiError(error),'refresh')+'</section>';throw error;}
    }
    function empty(text=t('emptyText'),action=''){return '<div class="empty"><div class="empty-icon">'+icon(S.view==='proxies'?'globe':'box')+'</div><h3>'+t('emptyTitle')+'</h3><p>'+E(text)+'</p>'+(action?btn(action,action==='refresh'?t('refresh'):t('add'),'plus','subtle'):'')+'</div>';}
    function table(heads,rows,cls=''){return '<div class="table-wrap"><table class="'+cls+'"><thead><tr>'+heads.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';}
    function pager(){return '<div class="table-footer"><span class="table-info">'+num(S.items.length)+' '+t('rowCount')+'</span><div class="pager">'+btn('prev',t('previous'),'','small',S.filter.history.length?'':'disabled')+btn('next',t('next'),'','small',S.next?'':'disabled')+'</div></div>';}
    function filters(states=[]){return '<div class="filters"><form id="search-form" class="search"><input name="q" id="search-q" value="'+E(S.filter.q)+'" placeholder="'+t('searchHint')+'" aria-label="'+t('search')+'"><button class="icon-button" type="submit" aria-label="'+t('search')+'">'+icon('arrow')+'</button></form>'+(states.length?'<select id="state-filter" aria-label="'+t('status')+'"><option value="">'+t('allStates')+'</option>'+states.map(s=>'<option value="'+s+'" '+(S.filter.state===s?'selected':'')+'>'+t(s)+'</option>').join('')+'</select>':'')+'</div>';}
    function metric(title,value,footer,i,unit=''){return '<div class="card metric"><div class="metric-top"><span>'+E(title)+'</span><span class="metric-icon">'+icon(i)+'</span></div><strong class="metric-value">'+num(value)+(unit?'<small>'+E(unit)+'</small>':'')+'</strong><div class="metric-foot">'+E(footer)+'</div></div>';}
    function overview(d){S.currency=d.currency||'';let metrics='';
      if(d.summary){metrics=metric(t('totalCustomers'),d.summary.users.total,num(d.summary.users.new_in_period)+' '+t('newCustomers'),'users')+metric(t('weeklyRevenue'),d.summary.sales.revenue,t('sevenDays'),'wallet',d.currency)+metric(t('pendingOrders'),d.pending,t('awaitReview'),'receipt')+metric(t('registeredNodes'),d.summary.nodes.length,t('infrastructure'),'server');}
      else metrics=metric(t('nodeAccounts'),d.local_users,'NexiUP node','users')+metric(t('proxyCount'),d.proxies.total,t('selectHelp'),'globe')+metric(t('availableCountries'),d.proxies.countries,t('claimedCountry'),'server')+metric(t('verifiedProxies'),d.proxies.verified,t('ago'),'pulse');
      const art='<svg class="hero-art" viewBox="0 0 210 145" fill="none" aria-hidden="true"><ellipse cx="104" cy="70" rx="76" ry="41" transform="rotate(-24 104 70)" stroke="#5c567b"/><ellipse cx="104" cy="70" rx="76" ry="41" transform="rotate(35 104 70)" stroke="#4d526c"/><path d="M40 90l65-21 64-37 M105 69l55 57" stroke="#766995" stroke-dasharray="3 5"/><rect x="81" y="45" width="49" height="49" rx="13" fill="#45405f" stroke="#8470b6"/><path d="M94 80V57l24 23V57" stroke="#bcabe8" stroke-width="4"/><rect x="17" y="82" width="42" height="25" rx="7" fill="#2e354c" stroke="#54506c"/><rect x="148" y="17" width="42" height="25" rx="7" fill="#2e354c" stroke="#54506c"/><rect x="143" y="115" width="35" height="23" rx="7" fill="#2e354c" stroke="#54506c"/><circle cx="38" cy="94" r="4" fill="#94b3ad"/><circle cx="169" cy="29" r="4" fill="#afa2d8"/><circle cx="160" cy="127" r="4" fill="#afa2d8"/></svg>';
      let out='<section class="hero"><div><span class="tiny-label">BUILT FOR YOUR NETWORK</span><h2>'+t('heroTitle')+'</h2><p>'+t('heroText')+'</p><div class="hero-actions">'+btn('navigate',t('explore'),'globe','primary','data-view="proxies"')+(d.role!=='node'?btn('new-node',t('addNode'),'plus'):'')+'</div></div>'+art+'</section><div class="metrics">'+metrics+'</div>';
      if(d.role!=='hub'&&!d.node_ready)out+='<div class="notice warning">'+t('master_key_required_min_32')+'</div>';
      if(d.summary&&!d.main_url)out+='<div class="notice warning"><div><strong>'+t('setupWarning')+'</strong></div>'+btn('edit-setting',t('startSetup'),'settings','','data-kind="bot"')+'</div>';
      const activity='<section class="card"><div class="card-head"><div><h2>'+t('recentActivity')+'</h2><p>'+t('auditSub')+'</p></div>'+btn('navigate',t('viewAll'),'','small','data-view="audit"')+'</div><div class="timeline">'+(d.recent.length?d.recent.map(a=>'<div class="timeline-item"><span class="timeline-dot"></span><div><strong>'+E(a.action.replace(/_/g,' '))+'</strong><small>'+E(date(a.created_at))+' · <code>'+E(a.actor)+'</code></small></div></div>').join(''):empty())+'</div></section>';
      out+='<div class="overview-grid">'+(d.summary?salesChart(d):'<section class="card"><div class="card-head"><h2>'+t('nodeUsers')+'</h2>'+status(d.node_paused?'paused':d.node_ready?'active':'not_configured')+'</div><div class="card-body"><p class="muted">'+t('nodeUsersSub')+'</p><div class="editor-actions">'+btn('navigate',t('nodeUsers'),'users','primary','data-view="node-users"')+btn('edit-setting',t('panel'),'settings','','data-kind="panel"')+'</div><p class="help-line">'+t('fallbackNotice')+'</p></div></section>')+activity+'</div>';
      if(d.summary)out+='<section class="card"><div class="card-head"><div><h2>'+t('nodes')+'</h2><p>'+t('nodesSub')+'</p></div>'+btn('navigate',t('viewAll'),'','small','data-view="nodes"')+'</div>'+(d.summary.nodes.length?table([t('name'),t('capacity'),t('actions')],d.summary.nodes.map(n=>'<tr><td><div class="cell-name"><span class="metric-icon">'+icon('server')+'</span><strong>'+E(n.label)+'</strong></div></td><td><div class="capacity"><progress value="'+Number(n.active)+'" max="'+Number(n.max_users)+'"></progress><small>'+num(n.active)+' / '+num(n.max_users)+'</small></div></td><td>'+btn('health',t('healthCheck'),'pulse','small','data-id="'+E(n.id)+'"')+'</td></tr>').join('')):empty(t('emptyText'),'new-node'))+'</section>';
      return out;
    }
    function salesChart(d){const days=[];for(let i=6;i>=0;i--){const dt=new Date(d.server_time-i*86400000),key=dt.toISOString().slice(0,10),found=d.days.find(v=>v.day===key);days.push({date:dt,value:found?.revenue||0});}const max=Math.max(1,...days.map(v=>v.value)),points=days.map((v,i)=>(24+i*76)+','+(143-v.value/max*110)).join(' '),revenue=days.reduce((n,v)=>n+v.value,0);
      return '<section class="card"><div class="card-head"><div><h2>'+t('revenueChart')+'</h2><p>'+t('weeklyRevenue')+'</p></div>'+pill(t('sevenDays'),'info')+'</div><div class="chart-summary"><strong>'+num(revenue)+' <span>'+E(d.currency)+'</span></strong><span>'+num(d.summary.sales.done)+' '+t('orders')+'</span></div><div class="chart-wrap"><svg viewBox="0 0 510 170" preserveAspectRatio="none" role="img" aria-label="'+t('revenueChart')+'"><defs><linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#a293d7" stop-opacity=".23"/><stop offset="1" stop-color="#a293d7" stop-opacity=".01"/></linearGradient></defs><path d="M24 35H485 M24 72H485 M24 109H485 M24 146H485" stroke="#f0eef7" stroke-dasharray="4 5"/><polygon points="24,146 '+points+' 480,146" fill="url(#sales-fill)"/><polyline points="'+points+'" fill="none" stroke="#a595d6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'+days.map((v,i)=>'<circle cx="'+(24+i*76)+'" cy="'+(143-v.value/max*110)+'" r="3" fill="#fff" stroke="#a595d6" stroke-width="2"/>').join('')+'</svg><div class="chart-days">'+days.map(v=>'<span>'+E(v.date.toLocaleDateString(S.lang==='fa'?'fa-IR':'en-GB',{day:'numeric',month:'short'}))+'</span>').join('')+'</div></div>'+(!revenue?'<p class="card-body muted small-text">'+t('noSales')+'</p>':'')+'</section>';
    }
    function profilesView(items){return '<div class="notice neutral">'+t('isolatedProfile')+'</div><div class="profiles-grid">'+items.map(p=>'<section class="card profile-card"><div class="profile-top"><div class="profile-logo">'+E(p.id.slice(0,2).toUpperCase())+'</div>'+status(p.enabled?'enabled':'disabled')+'</div><div><h2>'+E(S.lang==='fa'?p.label:p.label_en||p.label)+'</h2><span class="mono muted small-text">'+E(p.id)+'</span></div><dl class="profile-meta"><div><dt>'+t('fingerprint')+'</dt><dd class="mono">'+E(p.fingerprint)+'</dd></div><div><dt>'+t('version')+'</dt><dd>'+num(p.version)+'</dd></div><div><dt>'+t('echCount')+'</dt><dd>'+num(p.ech.length)+'</dd></div><div><dt>'+t('mask')+'</dt><dd>'+t(p.finalmask?'enabled':'disabled')+'</dd></div></dl><div class="actions">'+btn('edit',t('edit'),'sliders','primary small','data-id="'+E(p.id)+'"')+btn('profile-rollback',t('rollback'),'refresh','small','data-id="'+E(p.id)+'"'+(p.version>1?'':' disabled'))+'</div></section>').join('')+'</div>';}
    function settingsView(){const kinds=S.session.role==='node'?['panel','proxy','keys']:S.session.role==='hub'?['bot','test','proxy']:['bot','test','panel','proxy','keys'];return '<div class="settings-cards">'+kinds.map(k=>'<section class="card setting-card"><span class="metric-icon">'+icon(k==='keys'?'key':k==='proxy'?'globe':'settings')+'</span><h2>'+t(k==='test'?'testSettings':k)+'</h2><p>'+t(k+'Hint')+'</p>'+btn(k==='keys'?'keys':'edit-setting',t(k==='keys'?'keys':'edit'),'arrow','subtle','data-kind="'+k+'"')+(k==='panel'?'<div class="editor-actions">'+btn('legacy-tools',t('legacyTools'),'download','small')+'</div>':'')+'</section>').join('')+'</div>';}
    function auditsView(items){return '<section class="card">'+(items.length?table([t('date'),t('owner'),t('actions'),t('id')],items.map(a=>'<tr><td class="small-text">'+E(date(a.created_at))+'</td><td class="mono">'+E(a.actor)+'</td><td class="mono">'+E(a.action)+'</td><td class="mono">'+E(a.target)+'</td></tr>').join('')):empty())+pager()+'</section>';}
    function listView(items){let tabs='',heads=[],rows='',states=[];if(S.view==='catalog')tabs='<div class="tabs">'+['plans','payments','coupons','guides','channels','texts'].map(k=>'<button class="tab '+(k===S.kind?'active':'')+'" data-action="catalog-tab" data-kind="'+k+'">'+t(k)+'</button>').join('')+'</div>';
      if(S.view==='nodes'){heads=[t('name'),t('country'),t('purpose'),t('capacity'),t('health'),t('actions')];rows=items.map(n=>'<tr><td><div class="cell-name"><span class="metric-icon">'+icon('server')+'</span><div><strong>'+E(n.label)+'</strong><span class="subline mono">'+E(n.id)+' · '+E(n.adapter)+'</span></div></div></td><td><span class="flag">'+flag(n.code.toUpperCase())+'</span> '+E(country(n.code.toUpperCase()))+'</td><td>'+pill(t(n.purpose),n.purpose==='test'?'info':'')+'<span class="subline">'+t(n.local?'local':'remote')+' · '+t(n.enabled?'enabled':'disabled')+'</span></td><td><div class="capacity"><progress value="'+Number(n.active)+'" max="'+Number(n.max_users)+'"></progress><small>'+num(n.active)+' / '+num(n.max_users)+'</small></div></td><td>'+pill(t(n.last_health_ok?'apiReachable':'apiNotChecked'),n.last_health_ok?'good':'')+'<span class="subline">'+E(n.last_health_ok?date(n.last_health_ok):'')+'</span></td><td><div class="actions">'+btn('edit',t('edit'),'sliders','small','data-id="'+E(n.id)+'"')+btn('health',t('healthCheck'),'pulse','small','data-id="'+E(n.id)+'"')+'</div></td></tr>').join('');}
      else if(S.view==='orders'){states=['pending','pending_payment','processing','done','rejected','cancelled'];heads=[t('id'),t('customer'),t('plan'),t('amount'),t('status'),t('actions')];rows=items.map(o=>'<tr><td><span class="mono">'+E(o.id)+'</span><span class="subline">'+E(date(o.created_at))+'</span></td><td>'+E(o.customer||o.user_id)+'<span class="subline mono">'+E(o.user_id)+'</span></td><td>'+E(o.plan_id||t(o.kind))+'</td><td>'+num(o.total)+'</td><td>'+status(o.status)+'</td><td>'+btn('detail',t('details'),'eye','small','data-id="'+E(o.id)+'"')+'</td></tr>').join('');}
      else if(S.view==='subscriptions'){states=['active','paused','expired','deleted'];heads=[t('name'),t('customer'),t('node'),t('expiry'),t('status'),t('actions')];rows=items.map(o=>'<tr><td class="mono">'+E(o.name)+'</td><td>'+num(o.user_id)+'</td><td class="mono">'+E(o.node_id||'—')+'</td><td>'+E(date(o.expires_at))+'</td><td>'+status(o.status)+'</td><td>'+btn('detail',t('details'),'eye','small','data-id="'+E(o.id)+'"')+'</td></tr>').join('');}
      else if(S.view==='customers'){heads=[t('customer'),t('id'),t('balance'),t('status'),t('actions')];rows=items.map(u=>'<tr><td><div class="cell-name"><span class="avatar small">'+E((u.name||'U').slice(0,1))+'</span><div>'+E(u.name||'—')+'<span class="subline mono">'+(u.username?'@'+E(u.username):'—')+'</span></div></div></td><td class="mono">'+E(u.id)+'</td><td>'+num(u.balance)+'</td><td>'+status(u.banned?'banned':'active')+'</td><td>'+btn('detail',t('details'),'eye','small','data-id="'+E(u.id)+'"')+'</td></tr>').join('');}
      else if(S.view==='node-users'){heads=[t('name'),t('traffic'),t('expiry'),t('status'),t('actions')];rows=items.map(u=>'<tr><td class="mono">'+E(u.name)+'</td><td>'+byte(u.usage.total)+'<span class="subline">'+(u.usage.limit?byte(u.usage.limit):t('noLimit'))+'</span></td><td>'+E(date(u.expiryMs))+'</td><td>'+status(u.status)+'</td><td>'+btn('node-edit',t('edit'),'sliders','small','data-id="'+E(u.id)+'"')+'</td></tr>').join('');}
      else if(S.view==='catalog'){heads=[t('name'),t('id'),t('details'),t('status'),t('actions')];rows=items.map(o=>'<tr><td>'+E(o.name||o.title||o.id)+'</td><td class="mono">'+E(o.id)+'</td><td>'+(S.kind==='plans'?num(o.total_gb)+' GiB · '+num(o.days)+' '+(S.lang==='fa'?'روز':'days')+'<span class="subline">'+num(o.price)+'</span>':E(String(o.type||o.chat_id||o.description||'').slice(0,60)))+'</td><td>'+status(o.enabled?'enabled':'disabled')+'</td><td>'+btn('edit',t('edit'),'sliders','small','data-id="'+E(o.id)+'"')+'</td></tr>').join('');}
      return tabs+'<section class="card"><div class="toolbar">'+filters(states)+(S.view==='orders'?btn('operations',t('operationsTitle'),'clock','small'):'')+'</div>'+(items.length?table(heads,rows):empty(t('emptyText'),['nodes','catalog','node-users'].includes(S.view)?'new':''))+pager()+'</section>';
    }
    function proxyTargets(d){let options=S.session.role!=='hub'?[{id:'self',label:t('selfTarget')}]:[];options=options.concat(d.nodes.filter(n=>!n.local).map(n=>({id:'node:'+n.id,label:n.label+' · '+t('newAccounts')})));if(!options.some(o=>o.id===S.target))S.target=options[0]?.id||'';return options;}
    function proxyView(d){const countryCount=d.countries.filter(c=>c.country!=='ZZ').length,verified=d.countries.reduce((n,c)=>n+Number(c.verified||0),0),targets=proxyTargets(d);if(!d.nodes.some(n=>n.id===S.probeNode&&n.enabled))S.probeNode='';
      return '<div class="notice '+(d.settings.external_enabled?'neutral':'')+'"><div><strong>'+t(d.settings.external_enabled?'sourceOn':'sourceOff')+'</strong>'+t(d.settings.external_enabled?'sourceOnText':'sourceOffText')+'</div>'+btn('edit-setting',t('sourceSettings'),'settings','small','data-kind="proxy"')+'</div><div class="proxy-summary"><div class="proxy-stat"><strong>'+num(d.countries.reduce((n,c)=>n+c.count,0))+'</strong><span>'+t('candidateCount')+'</span></div><div class="proxy-stat"><strong>'+num(countryCount)+'</strong><span>'+t('countryCount')+'</span></div><div class="proxy-stat"><strong>'+num(verified)+'</strong><span>'+t('verifiedCount')+'</span></div><div class="proxy-stat"><strong id="probe-budget">'+num(d.remaining)+'</strong><span>'+t('remainingTests')+'</span></div></div><section class="card"><div class="toolbar"><div class="filters"><form id="search-form" class="search"><input name="q" id="search-q" value="'+E(S.filter.q)+'" placeholder="'+t('proxySearch')+'" aria-label="'+t('search')+'"><button class="icon-button" type="submit" aria-label="'+t('search')+'">'+icon('arrow')+'</button></form><select id="proxy-country" aria-label="'+t('claimedCountry')+'"><option value="">'+t('allCountries')+'</option>'+d.countries.map(c=>'<option value="'+E(c.country)+'" '+(c.country===S.filter.country?'selected':'')+'>'+flag(c.country)+' '+E(country(c.country))+' ('+num(c.count)+')</option>').join('')+'</select><select id="state-filter" aria-label="'+t('status')+'"><option value="">'+t('allStates')+'</option>'+['relay_ok','tcp_ok','untested','relay_failed','tcp_failed','reported_ok','reported_failed'].map(s=>'<option value="'+s+'" '+(s===S.filter.state?'selected':'')+'>'+t(s)+'</option>').join('')+'</select></div><span class="table-info">'+num(d.total)+' '+t('candidateCount')+'</span></div><div class="test-controls"><label for="probe-mode">'+t('probeMode')+'</label><select id="probe-mode">'+[['relay','relayMode'],['tcp','tcpMode'],['external','externalMode']].map(([v,key])=>'<option value="'+v+'" '+(S.mode===v?'selected':'')+(v==='external'&&!d.settings.checker_enabled?' disabled':'')+'>'+t(key)+'</option>').join('')+'</select><label for="probe-node">'+t('probeOrigin')+'</label><select id="probe-node" '+(S.mode==='external'?'disabled':'')+'><option value="">'+t('thisWorker')+'</option>'+d.nodes.filter(n=>n.enabled&&!n.local&&n.adapter==='nexiup').map(n=>'<option value="'+E(n.id)+'" '+(S.probeNode===n.id?'selected':'')+'>'+E(n.label)+'</option>').join('')+'</select><span class="grow"></span>'+btn('test-page',t('testPage'),'play','primary',!d.items.length||d.remaining<=0?'disabled':'')+btn('stop-tests',t('stop'),'stop','danger',S.batch?'':'hidden')+'</div><div id="test-progress" class="test-progress" '+(S.batch?'':'hidden')+'><span class="spinner"></span><span id="test-progress-text"></span><progress id="test-progress-bar" value="0" max="20"></progress></div><div id="proxy-table">'+proxyTable()+'</div>'+pager()+'</section><div class="selection-bar"><div><div id="selection-title" class="selection-title"></div><div id="selection-sub" class="selection-sub mono"></div></div><div class="actions"><select id="proxy-target" aria-label="'+t('node')+'">'+targets.map(o=>'<option value="'+E(o.id)+'" '+(o.id===S.target?'selected':'')+'>'+E(o.label)+'</option>').join('')+'</select>'+btn('apply-proxy',t('applySelected'),'check','primary',!targets.length?'disabled':'')+btn('rollback-proxy',t('rollback'),'refresh','',!targets.length?'disabled':'')+btn('clear-selection',t('clearSelection'),'','small')+'</div></div><p class="help-line">'+t('proxyCaution')+'</p><p class="help-line">'+t('fallbackNotice')+'</p>';
    }
    function proxyTable(){return S.items.length?table(['<span aria-label="'+t('selected')+'">◇</span>',t('endpoint'),t('claimedCountry'),t('testResult'),t('latency'),t('observedExit'),t('actions')],S.items.map(p=>{const probe=p.probe||{},old=p.checked_at&&p.checked_at<Date.now()-1800000,ms=probe.total_ms,exit=probe.relay_ok&&probe.exit_country;return '<tr data-proxy-row="'+E(p.id)+'"><td><input type="checkbox" data-select-proxy="'+E(p.id)+'" '+(S.selected.has(p.id)?'checked':'')+' aria-label="'+E(t('selected')+' '+p.id)+'"></td><td><span class="ip mono">'+E(p.id)+'</span><span class="subline">'+E(p.label||p.city||'—')+'</span></td><td><div class="cell-name"><span class="flag">'+flag(p.country)+'</span><div>'+E(country(p.country))+'<span class="subline mono">'+E(p.country)+'</span></div></div></td><td>'+status(p.busy?'testing':p.state)+(old?'<span class="subline">'+t('stale')+' · '+E(date(p.checked_at))+'</span>':'<span class="subline">'+E(p.checked_at?date(p.checked_at):t('notTested'))+'</span>')+(probe.error?'<span class="subline mono">'+E(probe.error)+'</span>':'')+'</td><td><span class="mono">'+(p.checked_at?num(ms)+' ms':'—')+'</span><span class="subline mono">'+(probe.tcp_ok?'TCP '+num(probe.tcp_ms)+' ms':probe.reported_ms!==null&&probe.reported_ms!==undefined?'report '+num(probe.reported_ms)+' ms':'—')+'</span><span class="subline">'+(probe.from_colo?t('measuredFrom')+' '+E(probe.from_colo):'')+'</span></td><td>'+(exit?'<span>'+flag(probe.exit_country)+' '+E(country(probe.exit_country))+'</span><span class="subline mono">'+E(probe.exit_ip)+'</span>':'<span class="muted small-text">'+t('noExit')+'</span>')+'</td><td><div class="actions">'+btn('probe',t('testNow'),'pulse','small','data-id="'+E(p.id)+'"'+(p.busy||S.batch?' disabled':''))+'<button class="icon-button" data-action="remove-proxy" data-id="'+E(p.id)+'" aria-label="'+t('removeEntry')+'">'+icon('trash')+'</button></div></td></tr>';}).join(''),'proxy-table'):empty(t('sourceOffText'),'sync');}
    function updateSelection(){if(!$('selection-title'))return;$('selection-title').textContent=S.selected.size?num(S.selected.size)+' '+t('selected'):t('selectHelp');$('selection-sub').textContent=[...S.selected].join(' · ');}
    function updateProxyTable(){if(S.view==='proxies'&&$('proxy-table')){$('proxy-table').innerHTML=proxyTable();updateSelection();}}
    function showModal(title,body,footer=''){$('modal-title').textContent=title;$('modal-body').innerHTML=body;$('modal-footer').innerHTML=footer;if(!$('modal').open)$('modal').showModal();}
    function closeModal(){if($('modal').open)$('modal').close();S.modalAction=null;}
    function confirmAction(title,text,fn){S.modalAction=fn;showModal(title,'<p class="muted">'+E(text)+'</p>',btn('close-modal',t('cancel'))+btn('confirm-action',t('confirm'),'check','primary'));}
    async function newEditor(kind,id=''){const data=await api('editor?'+new URLSearchParams({kind,id}));openEditor(kind,data.doc,data.version,id);}
    function field(key,value,locked){const json=Array.isArray(value)||(value!==null&&typeof value==='object')||key==='finalmask',type=typeof value,fieldLabel=E(label(key))+' <span class="field-code" dir="ltr">'+E(key)+'</span>';
      if(type==='boolean')return '<div class="field check"><label><input data-field="'+E(key)+'" data-type="boolean" type="checkbox" '+(value?'checked':'')+(['auto_update','remote_deploy'].includes(key)?' disabled':'')+'>'+fieldLabel+'</label></div>';
      const choices={protocol:['vless','trojan','both'],purpose:['sales','test'],adapter:['nexiup','nahan'],fingerprint:['chrome','unsafe','firefox','safari','ios','android','edge','random','randomized'],type:['percent','fixed'],userMode:['','alpha','beta','both']};
      if(choices[key])return '<div class="field"><label>'+fieldLabel+'</label><select data-field="'+E(key)+'" data-type="string" dir="ltr">'+choices[key].map(v=>'<option value="'+v+'" '+(v===value?'selected':'')+'>'+E(v||'default')+'</option>').join('')+'</select></div>';
      const long=json||/^(terms_|guides_|cipher_suites|details|instructions|description|announcement|notes|text|fa$|en$)/.test(key),val=json?JSON.stringify(value,null,2):String(value??'');
      return '<div class="field '+(long?'full ':'')+(json?'json':'')+'"><label for="field-'+E(key)+'">'+fieldLabel+'</label>'+(long?'<textarea id="field-'+E(key)+'" data-field="'+E(key)+'" data-type="'+(json?'json':type)+'" spellcheck="false" '+(json||/cipher/.test(key)?'dir="ltr"':'')+'>'+E(val)+'</textarea>':'<input id="field-'+E(key)+'" data-field="'+E(key)+'" data-type="'+type+'" type="'+(type==='number'?'number':'text')+'" '+(type==='number'?'step="any"':'')+' value="'+E(val)+'" '+(locked||key==='repository'?'readonly':'')+' '+(/url|route|key|proxy|Ip|Port|id|name/.test(key)?'dir="ltr"':'')+' autocomplete="off">')+'</div>';
    }
    function openEditor(kind,doc,version,id=''){S.editor={kind,doc,version,id,nonce:crypto.randomUUID(),mode:'form',valid:null};S.modalAction=null;renderEditor();}
    function renderEditor(){const e=S.editor;const body='<p class="help-line">'+t(e.kind==='node-user'?'accountIdentity':'editorHelp')+'</p>'+(e.kind==='proxy'?'<div class="notice warning">'+t('sourceConsentText')+'</div>':'')+'<div class="tabs"><button class="tab '+(e.mode==='form'?'active':'')+'" data-action="editor-mode" data-mode="form">'+t('form')+'</button><button class="tab '+(e.mode==='json'?'active':'')+'" data-action="editor-mode" data-mode="json">'+t('json')+'</button></div>'+(e.mode==='form'?'<form id="editor-form"><div class="editor-grid">'+Object.entries(e.doc).map(([k,v])=>field(k,v,k==='id'&&!!e.id)).join('')+'</div></form>':'<textarea id="raw-editor" class="json-view" spellcheck="false" rows="18">'+E(JSON.stringify(e.doc,null,2))+'</textarea>')+'<div id="validation-box" class="validation-box" hidden>'+t('validSuccess')+'</div>';
      const title=(e.id||e.version>0?t('edit'):t('add'))+' · '+t(e.kind==='node-user'?'nodeUsers':e.kind==='test'?'testSettings':e.kind);let foot=btn('close-modal',t('cancel'))+btn('validate-editor',t('validate'),'check')+btn('save-editor',t('save'),'arrow','primary','id="save-editor" disabled');
      if(e.kind==='node-user'&&e.id)foot=btn('node-action',t('delete'),'trash','danger small','data-id="'+E(e.id)+'" data-op="delete"')+btn('node-action',t('resetUsage'),'refresh','small','data-id="'+E(e.id)+'" data-op="reset"')+foot;
      showModal(title,body,foot);
    }
    function editorDoc(){const e=S.editor;if(e.mode==='json'){const v=JSON.parse($('raw-editor').value);if(e.id&&e.doc.id&&v.id!==e.id)throw new Error('immutableId');return v;}const d={};document.querySelectorAll('#editor-form [data-field]').forEach(el=>{const key=el.dataset.field,type=el.dataset.type;d[key]=type==='boolean'?el.checked:type==='number'?Number(el.value):type==='json'?JSON.parse(el.value):el.value;});return d;}
    async function validateEditor(){const e=S.editor,doc=editorDoc();if(e.kind==='node-user')await api('node-users/validate',{method:'POST',body:doc});else await api('validate',{method:'POST',body:{kind:e.kind,doc}});e.valid=JSON.stringify(doc);$('validation-box').hidden=false;$('save-editor').disabled=false;}
    async function saveEditor(){const e=S.editor,doc=editorDoc();if(e.valid!==JSON.stringify(doc))throw new Error('validateFirst');if(e.kind==='node-user')await api('node-users'+(e.id?'?id='+encodeURIComponent(e.id):''),{method:e.id?'PUT':'POST',body:doc,nonce:e.nonce});else await api('save',{method:'POST',body:{kind:e.kind,doc,version:e.version}});closeModal();toast(t('saved'),'good');await load();updateSelection();}
    async function nodeEditor(id=''){if(id){const d=await api('node-users?id='+encodeURIComponent(id));openEditor('node-user',d.doc,0,id);}else openEditor('node-user',{name:'web_'+crypto.randomUUID().replace(/-/g,''),trafficLimit:1,dailyLimit:1,expiryDays:30,connLimit:2,maxConfigs:4,notes:'',proxyIp:'',cleanIp:'',userNodes:'',userPanelUrl:'',userMode:'',userPorts:'',isPaused:false},0);}
    function summaryFields(obj,fields){return '<dl class="detail-grid">'+fields.map(([k,key])=>'<div><dt>'+t(key||k)+'</dt><dd>'+E(obj[k]??'—')+'</dd></div>').join('')+'</dl>';}
    async function detail(id){const view=S.view,d=await api(view+'?id='+encodeURIComponent(id)),o=d.item;S.detail={view,item:o,nonce:crypto.randomUUID()};let body='',foot=btn('close-modal',t('close'));
      if(view==='orders'){body=summaryFields({...o,created_at:date(o.created_at),total:num(o.total),status:t(o.status)},[['id','id'],['user_id','customer'],['plan_id','plan'],['total','amount'],['status','status'],['created_at','date']]);if(o.receipt?.available)body+='<div class="actions">'+btn('receipt',t('receipt'),'eye','','data-id="'+E(o.id)+'" data-type="'+E(o.receipt.type)+'"')+'</div><p class="receipt-caption">'+E(o.receipt.note||'')+'</p><div id="receipt-body"></div>';if(o.status==='pending')foot+=btn('reject-order',t('reject'),'','danger','data-id="'+E(o.id)+'"')+btn('approve-order',t('approve'),'check','primary','data-id="'+E(o.id)+'"');}
      else if(view==='subscriptions'){body=summaryFields({...o,expires_at:date(o.expires_at),status:t(o.status)},[['name','name'],['user_id','customer'],['node_id','node'],['expires_at','expiry'],['status','status']]);foot+=['toggle','reset','delete'].map(a=>btn('sub-action',t(a==='reset'?'resetUsage':a),a==='delete'?'trash':'refresh',a==='delete'?'danger small':'small','data-id="'+E(o.id)+'" data-op="'+a+'"')).join('');}
      else if(view==='customers'){body=summaryFields({...o,balance:num(o.balance)},[['name','name'],['id','id'],['username','name'],['balance','balance']]);foot+=btn('wallet',t('walletAdjust'),'wallet','subtle','data-id="'+o.id+'"')+btn('ban-user',t(o.banned?'unban':'ban'),'','small','data-id="'+o.id+'" data-banned="'+(o.banned?'false':'true')+'"')+btn('test-reset',t('resetCooldown'),'refresh','small','data-id="'+o.id+'"');}
      showModal(t('details'),body,foot);
    }
    function simpleForm(title,body,fn,submit=t('confirm')){S.modalAction=fn;showModal(title,body,btn('close-modal',t('cancel'))+btn('form-action',submit,'check','primary'));}
    async function keysView(){const d=await api('keys');showModal(t('keys'),'<p class="muted small-text">'+t('keysHint')+'</p>'+(d.items.length?table([t('name'),t('secretReference'),t('actions')],d.items.map(k=>'<tr><td>'+E(k.name)+'</td><td class="mono">'+E(k.secret_ref)+'</td><td>'+btn('revoke-key',t('revoke'),'trash','danger small','data-id="'+E(k.id)+'"')+'</td></tr>').join('')):empty(t('keysHint'))),btn('new-key',t('registerKey'),'plus','primary')+btn('close-modal',t('close')));}
    async function operations(filter=S.opsFilter||'reconcile',cursor=''){const d=await api('operations?'+new URLSearchParams({status:filter,cursor}));S.opsFilter=filter;S.opsNext=d.next;S.operations=d.items;showModal(t('operationsTitle'),'<div class="notice warning">'+t('operationHint')+'</div><select id="ops-filter" aria-label="'+t('status')+'">'+['reconcile','failed','queued','creating','ready','done'].map(v=>'<option value="'+v+'" '+(filter===v?'selected':'')+'>'+t(v)+'</option>').join('')+'</select>'+table([t('id'),t('status'),t('actions')],d.items.map(o=>'<tr><td><span class="mono">'+E(o.id)+'</span><span class="subline mono">'+E(o.error||o.phase)+'</span></td><td>'+status(o.state)+'</td><td>'+btn('retry-op',t('retry'),'refresh','small','data-id="'+E(o.id)+'"'+(o.state==='done'?' disabled':''))+'</td></tr>').join(''))+(d.items.length?'':empty()),btn('operations-first',t('refresh'),'refresh')+btn('operations-next',t('next'),'arrow','',d.next?'':'disabled')+btn('close-modal',t('close')));}
    function stopBatch(){if(S.batch){S.batch.controller.abort();S.batch=null;}}
    async function probeOne(id,options={}){const item=S.items.find(v=>v.id===id);if(item)item.busy=true;updateProxyTable();try{const data=await api('proxy/probe',{method:'POST',body:{id,mode:options.mode||S.mode,node_id:(options.mode||S.mode)==='external'?'':(options.node??S.probeNode)},signal:options.signal});const current=S.items.find(v=>v.id===id);if(current)Object.assign(current,data);if($('probe-budget'))$('probe-budget').textContent=num(data.remaining);return data;}finally{if(item)item.busy=false;updateProxyTable();}}
    async function testPage(){if(S.batch||!S.items.length)return;const job={controller:new AbortController(),ids:S.items.map(i=>i.id),done:0,mode:S.mode,node:S.probeNode};S.batch=job;const stop=document.querySelector('[data-action="stop-tests"]'),start=document.querySelector('[data-action="test-page"]');if(stop)stop.hidden=false;if(start)start.disabled=true;$('test-progress').hidden=false;let index=0;
      const progress=()=>{if(!$('test-progress-text'))return;$('test-progress-text').textContent=num(job.done)+' / '+num(job.ids.length);$('test-progress-bar').max=job.ids.length;$('test-progress-bar').value=job.done;};progress();
      const run=async()=>{while(index<job.ids.length&&!job.controller.signal.aborted){const id=job.ids[index++];try{await probeOne(id,{mode:job.mode,node:job.node,signal:job.controller.signal});}catch(e){if(e.name==='AbortError')break;showError(e);if(['proxy_daily_test_budget','unauthorized','preview_network_disabled'].includes(e.code)){job.controller.abort();break;}}job.done++;progress();if(!job.controller.signal.aborted)await new Promise(resolve=>setTimeout(resolve,300));}};
      await Promise.all([run(),run()]);if(S.batch===job)S.batch=null;if(stop)stop.hidden=true;if(start)start.disabled=false;if($('test-progress'))$('test-progress').hidden=true;updateProxyTable();
    }
    function applyDialog(clear=false){if(!S.target)throw new Error('node_not_found');const p=S.proxy.policies.find(p=>p.target===S.target),ids=clear?[]:[...S.selected];if(!ids.length&&!clear){confirmAction(t('clearFallback'),t('fallbackNotice'),()=>applyDialog(true));return;}const target=S.target,version=p?.version||0;
      simpleForm(t('applySelected'),'<div class="notice warning">'+t(target==='self'?'fallbackNotice':'futureNotice')+'</div><div class="pill-list">'+ids.map(id=>'<code>'+E(id)+'</code>').join('')+'</div><p class="muted small-text">'+t('applyWarning')+'</p><label class="field check"><input id="allow-unverified" type="checkbox">'+t('allowUnverified')+'</label>',async()=>{const override=$('allow-unverified').checked;await api('proxy/apply',{method:'POST',body:{target,ids,version,allow_unverified:override}});closeModal();toast(t('saved'),'good');S.selected.clear();await load();updateSelection();},t('applySelected'));
    }
    async function syncList(){const settings=(await api('editor?kind=proxy')).doc;const start=async()=>{S.importStopped=false;showModal(t('fetchList'),'<p class="loading"><span class="spinner"></span>'+t('loading')+'</p>',btn('close-modal',t('close')));const job=await api('proxy/sync',{method:'POST',body:{}});S.importJob=job;await continueImport();};if(!settings.external_enabled){confirmAction(t('sourceConsent'),t('sourceConsentText')+'\n\n'+settings.source_url,async()=>{const e=await api('editor?kind=proxy');e.doc.external_enabled=true;await api('save',{method:'POST',body:{kind:'proxy',doc:e.doc,version:e.version}});await start();});}else await start();}
    function importDialog(){S.importJob=null;S.importStopped=false;showModal(t('importList'),'<div class="notice neutral">'+t('importHint')+'</div><label for="import-file">'+t('chooseFile')+'</label><input id="import-file" type="file" accept=".json,.csv,.txt,application/json,text/csv,text/plain"><label for="import-data">'+t('pasteList')+'</label><textarea id="import-data" rows="10" dir="ltr" spellcheck="false" placeholder="country,endpoint,label"></textarea>',btn('close-modal',t('cancel'))+btn('start-import',t('startImport'),'upload','primary'));}
    async function continueImport(){S.importStopped=false;while(S.importJob&&S.importJob.state==='pending'&&!S.importStopped){const j=S.importJob;showModal(t('importList'),'<p class="muted">'+t('importProgress')+'</p><div class="test-progress"><span class="spinner"></span><strong>'+num(j.cursor)+' / '+num(j.total)+'</strong><progress value="'+j.cursor+'" max="'+j.total+'"></progress></div><p class="small-text muted">'+num(j.imported)+' '+t('imported')+' · '+num(j.rejected)+' '+t('skipped')+'</p>',btn('stop-import',t('stop'),'stop'));try{S.importJob=await api('proxy/continue',{method:'POST',body:{id:j.id,cursor:j.cursor}});}catch(error){showModal(t('importList'),'<p class="muted">'+E(t(error.code||error.message))+'</p>',btn('resume-import',t('resume'),'play','primary')+btn('close-modal',t('close')));throw error;}}
      const j=S.importJob;if(j?.state==='done'){showModal(t('importList'),'<div class="validation-box">'+t('importComplete')+'</div><p class="help-line">'+num(j.imported)+' '+t('imported')+' · '+num(j.rejected)+' '+t('skipped')+'</p>'+(j.rejected||j.original_total>j.total?'<div class="notice warning">'+t('importPartial')+' · '+num(j.total)+' / '+num(j.original_total)+'</div>':''),btn('close-modal',t('close'),'check','primary'));if(S.view==='proxies'){resetFilter();await load();updateSelection();}}
    }
    const handlers={
      navigate:el=>go(el.dataset.view),refresh:async()=>{stopBatch();await load();updateSelection();},menu:()=>{const opened=document.body.classList.toggle('nav-open');document.querySelector('.mobile-menu').setAttribute('aria-expanded',String(opened));},language:async()=>{S.lang=S.lang==='fa'?'en':'fa';translate();if(S.session){await load();updateSelection();}},logout:async()=>{try{await api('logout',{method:'POST',body:{}});}finally{showLogin();}},'close-modal':()=>{if(S.importJob?.state==='pending')S.importStopped=true;closeModal();},
      new:()=>S.view==='node-users'?nodeEditor():newEditor(S.view==='catalog'?S.kind:S.view),edit:el=>newEditor(S.view==='catalog'?S.kind:S.view,el.dataset.id),'new-node':()=>newEditor('nodes'),'edit-setting':el=>newEditor(el.dataset.kind),'catalog-tab':async el=>{S.kind=el.dataset.kind;resetFilter();await load();},'node-edit':el=>nodeEditor(el.dataset.id),
      next:async()=>{if(!S.next)return;S.filter.history.push(S.filter.cursor);S.filter.cursor=S.next;await load();updateSelection();},prev:async()=>{if(!S.filter.history.length)return;S.filter.cursor=S.filter.history.pop();await load();updateSelection();},detail:el=>detail(el.dataset.id),'validate-editor':()=>validateEditor(),'save-editor':()=>saveEditor(),'editor-mode':el=>{S.editor.doc=editorDoc();S.editor.mode=el.dataset.mode;S.editor.valid=null;renderEditor();},
      'profile-rollback':el=>confirmAction(t('rollback'),t('profileRollbackText'),async()=>{await api('profiles/rollback',{method:'POST',body:{id:el.dataset.id}});toast(t('saved'),'good');await load();}),health:async el=>{const d=await api('nodes/health',{method:'POST',body:{id:el.dataset.id}});toast(t('apiReachable')+' · '+num(d.total)+' / '+num(d.max_users),'good');await load();},
      'confirm-action':async()=>{const fn=S.modalAction;closeModal();if(fn)await fn();},'form-action':async()=>{if(S.modalAction)await S.modalAction();},
      'approve-order':el=>confirmAction(t('approve'),t('approveText'),async()=>{await api('orders/decide',{method:'POST',body:{id:el.dataset.id,action:'approve'}});toast(t('completed'),'good');await load();}),
      'reject-order':el=>simpleForm(t('reject'),'<label for="reason">'+t('reason')+'</label><textarea id="reason" maxlength="500" required></textarea>',async()=>{const reason=$('reason').value.trim();if(!reason)throw new Error('reason_required');await api('orders/decide',{method:'POST',body:{id:el.dataset.id,action:'reject',reason}});closeModal();toast(t('completed'),'good');await load();},t('reject')),
      receipt:el=>{const url='/admin/web-api/receipt?id='+encodeURIComponent(el.dataset.id);if(el.dataset.type==='photo')$('receipt-body').innerHTML='<img class="receipt-image" src="'+E(url)+'" alt="'+t('receipt')+'">';else $('receipt-body').innerHTML='<a class="button" href="'+E(url)+'" download="receipt.bin">'+t('download')+'</a>';},
      'sub-action':el=>{const nonce=S.detail?.nonce||crypto.randomUUID();confirmAction(t(el.dataset.op==='reset'?'resetUsage':el.dataset.op),t('dangerConfirm'),async()=>{await api('subscriptions/action',{method:'POST',body:{id:el.dataset.id,action:el.dataset.op},nonce});toast(t('completed'),'good');await load();});},
      'node-action':el=>{const nonce=S.editor.nonce;confirmAction(t(el.dataset.op==='delete'?'delete':'resetUsage'),t('dangerConfirm'),async()=>{await api('node-users?'+new URLSearchParams({id:el.dataset.id,action:el.dataset.op==='reset'?'reset':''}),{method:el.dataset.op==='delete'?'DELETE':'POST',nonce});toast(t('completed'),'good');await load();});},
      wallet:el=>{const nonce=crypto.randomUUID();simpleForm(t('walletAdjust'),'<div class="notice neutral">'+t('walletHint')+'</div><label for="amount">'+t('amount')+'</label><input id="amount" type="number" step="1" value="0" dir="ltr"><label for="reason">'+t('reason')+'</label><input id="reason" maxlength="200">',async()=>{await api('customers/action',{method:'POST',nonce,body:{id:Number(el.dataset.id),action:'wallet',amount:Number($('amount').value),reason:$('reason').value}});closeModal();toast(t('saved'),'good');await load();});},
      'ban-user':el=>confirmAction(t(el.dataset.banned==='true'?'ban':'unban'),t('dangerConfirm'),async()=>{await api('customers/action',{method:'POST',body:{id:Number(el.dataset.id),action:'ban',banned:el.dataset.banned==='true'}});toast(t('saved'),'good');await load();}),
      'test-reset':el=>confirmAction(t('resetCooldown'),t('dangerConfirm'),async()=>{await api('customers/action',{method:'POST',body:{id:Number(el.dataset.id),action:'test_reset'}});toast(t('completed'),'good');}),operations:()=>operations(),'operations-next':()=>operations(S.opsFilter,S.opsNext),'operations-first':()=>operations(),
      'retry-op':el=>simpleForm(t('retry'),'<div class="notice warning">'+t('operationHint')+'</div><select id="manual-retry"><option value="">'+t('normalRetry')+'</option><option value="absent">'+t('confirmedAbsent')+'</option><option value="reset">'+t('confirmedReset')+'</option></select>',async()=>{await api('operations/retry',{method:'POST',body:{id:el.dataset.id,manual:$('manual-retry').value}});closeModal();toast(t('completed'),'good');}),
      'legacy-tools':async()=>{const d=await api('editor?kind=panel');showModal(t('legacyTools'),'<p class="muted">'+t('legacyHint')+'</p><div class="editor-actions"><a class="button primary" href="/'+encodeURIComponent(d.doc.api_route)+'/dash" target="_blank" rel="noopener noreferrer">'+t('legacyTools')+' ↗</a></div>',btn('close-modal',t('close')));},keys:()=>keysView(),'new-key':()=>simpleForm(t('registerKey'),'<div class="notice neutral">'+t('keysHint')+'</div><label for="key-name">'+t('name')+'</label><input id="key-name" maxlength="80"><label for="key-ref">'+t('secretReference')+'</label><input id="key-ref" dir="ltr" placeholder="NODE_KEY_…">',async()=>{await api('keys',{method:'POST',body:{name:$('key-name').value,secret_ref:$('key-ref').value}});toast(t('saved'),'good');await keysView();}),
      'revoke-key':el=>confirmAction(t('revoke'),t('revokeText'),async()=>{await api('keys?id='+encodeURIComponent(el.dataset.id),{method:'DELETE'});await keysView();}),
      probe:el=>probeOne(el.dataset.id),'test-page':()=>testPage(),'stop-tests':()=>stopBatch(),'clear-selection':()=>{S.selected.clear();updateProxyTable();},'apply-proxy':()=>applyDialog(),
      'rollback-proxy':()=>{const p=S.proxy.policies.find(p=>p.target===S.target);if(!p?.can_rollback)throw new Error('no_proxy_rollback');const target=S.target;confirmAction(t('rollback'),t('rollbackText'),async()=>{await api('proxy/rollback',{method:'POST',body:{target,version:p.version}});toast(t('saved'),'good');await load();updateSelection();});},
      'remove-proxy':el=>confirmAction(t('removeEntry'),t('removeEntryHelp'),async()=>{await api('proxy/remove',{method:'POST',body:{id:el.dataset.id}});S.selected.delete(el.dataset.id);await load();updateSelection();}),sync:()=>syncList(),import:()=>importDialog(),
      'start-import':async()=>{S.importJob=await api('proxy/import',{method:'POST',body:{data:$('import-data').value}});await continueImport();},'resume-import':async()=>{S.importJob=await api('proxy/import-status?id='+encodeURIComponent(S.importJob.id));await continueImport();},'stop-import':async()=>{S.importStopped=true;if(S.importJob){await api('proxy/cancel-import',{method:'POST',body:{id:S.importJob.id}});S.importJob.state='cancelled';}closeModal();await load();updateSelection();}
    };
    document.addEventListener('click',async event=>{const el=event.target.closest('[data-action]');if(!el||el.disabled)return;const action=handlers[el.dataset.action];if(!action)return;const was=el.disabled;el.disabled=true;try{await action(el);updateSelection();}catch(error){showError(error);}finally{if(el.isConnected)el.disabled=was;}});
    document.addEventListener('change',async event=>{const el=event.target;try{
      if(el.dataset.selectProxy){if(el.checked){if(S.selected.size>=4){el.checked=false;toast(t('selectHelp'));return;}S.selected.add(el.dataset.selectProxy);}else S.selected.delete(el.dataset.selectProxy);updateSelection();}
      else if(el.id==='proxy-country'||el.id==='state-filter'){stopBatch();if(el.id==='proxy-country')S.filter.country=el.value;else S.filter.state=el.value;S.filter.cursor='';S.filter.history=[];await load();updateSelection();}
      else if(el.id==='ops-filter')await operations(el.value);
      else if(el.id==='probe-mode'){S.mode=el.value;if(S.mode==='external')S.probeNode='';$('probe-node').disabled=S.mode==='external';}
      else if(el.id==='probe-node')S.probeNode=el.value;else if(el.id==='proxy-target')S.target=el.value;
      else if(el.id==='import-file'&&el.files[0]){if(el.files[0].size>1048576)throw new Error('body_too_large');$('import-data').value=await el.files[0].text();}
    }catch(error){showError(error);}});
    document.addEventListener('input',event=>{if(event.target.matches('#editor-form [data-field],#raw-editor')){if(S.editor)S.editor.valid=null;if($('save-editor'))$('save-editor').disabled=true;if($('validation-box'))$('validation-box').hidden=true;}});
    document.addEventListener('submit',async event=>{event.preventDefault();try{
      if(event.target.id==='login-form'){const button=$('login-button');button.disabled=true;let key=$('admin-key').value;try{for(let i=0;i<10;i++){$('login-status').textContent=t('loading');const response=await fetch('/admin/web-api/login',{method:'POST',headers:{Authorization:'Bearer '+key},credentials:'same-origin',cache:'no-store'});const data=await response.json();if(!response.ok)throw apiError(data,response);if(data.migration_required){$('login-status').textContent='D1 · '+data.version;continue;}key='';$('admin-key').value='';$('login-status').textContent='';openApp(data);return;}throw new Error('migration_not_finished');}finally{key='';$('admin-key').value='';button.disabled=false;}}
      if(event.target.id==='search-form'){stopBatch();S.filter.q=$('search-q').value;S.filter.cursor='';S.filter.history=[];await load();updateSelection();}
    }catch(error){if(event.target.id==='login-form')$('login-status').textContent=uiError(error);else showError(error);}});
    $('modal').addEventListener('cancel',()=>{S.importStopped=true;S.modalAction=null;});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('modal').open){document.body.classList.remove('nav-open');document.querySelector('.mobile-menu').setAttribute('aria-expanded','false');}});
    window.addEventListener('hashchange',()=>{if(S.session)go(location.hash.slice(1));});
    translate();api('session').then(openApp).catch(error=>{showLogin();if(error.code!=='unauthorized')$('login-status').textContent=uiError(error);});
  })();
`;

// ---- Embedded QR encoder follows. Transpiled once from Project Nayuki TypeScript.
// No deployment compilation, remote dependency, dynamic evaluation or Node API.
/*!
 * QR Code generator library (TypeScript)
 *
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */
// Original namespace wrappers adapted to a plain-JavaScript factory for checkJs.
const qrcodegen = createQrEncoder();
function createQrEncoder() {
    /*---- QR Code symbol class ----*/
    /*
     * A QR Code symbol, which is a type of two-dimension barcode.
     * Invented by Denso Wave and described in the ISO/IEC 18004 standard.
     * Instances of this class represent an immutable square grid of dark and light cells.
     * The class provides static factory functions to create a QR Code from text or binary data.
     * The class covers the QR Code Model 2 specification, supporting all versions (sizes)
     * from 1 to 40, all 4 error correction levels, and 4 character encoding modes.
     *
     * Ways to create a QR Code object:
     * - High level: Take the payload data and call QrCode.encodeText() or QrCode.encodeBinary().
     * - Mid level: Custom-make the list of segments and call QrCode.encodeSegments().
     * - Low level: Custom-make the array of data codeword bytes (including
     *   segment headers and final padding, excluding error correction codewords),
     *   supply the appropriate version number, and call the QrCode() constructor.
     * (Note that all ways require supplying the desired error correction level.)
     */
    class QrCode {
        /** @type {typeof Ecc} */
        static Ecc;
        /*-- Static factory functions (high level) --*/
        // Returns a QR Code representing the given Unicode text string at the given error correction level.
        // As a conservative upper bound, this function is guaranteed to succeed for strings that have 738 or fewer
        // Unicode code points (not UTF-16 code units) if the low error correction level is used. The smallest possible
        // QR Code version is automatically chosen for the output. The ECC level of the result may be higher than the
        // ecl argument if it can be done without increasing the version.
        static encodeText(text, ecl) {
            const segs = QrSegment.makeSegments(text);
            return QrCode.encodeSegments(segs, ecl);
        }
        // Returns a QR Code representing the given binary data at the given error correction level.
        // This function always encodes using the binary segment mode, not any text mode. The maximum number of
        // bytes allowed is 2953. The smallest possible QR Code version is automatically chosen for the output.
        // The ECC level of the result may be higher than the ecl argument if it can be done without increasing the version.
        static encodeBinary(data, ecl) {
            const seg = QrSegment.makeBytes(data);
            return QrCode.encodeSegments([seg], ecl);
        }
        /*-- Static factory functions (mid level) --*/
        // Returns a QR Code representing the given segments with the given encoding parameters.
        // The smallest possible QR Code version within the given range is automatically
        // chosen for the output. Iff boostEcl is true, then the ECC level of the result
        // may be higher than the ecl argument if it can be done without increasing the
        // version. The mask number is either between 0 to 7 (inclusive) to force that
        // mask, or -1 to automatically choose an appropriate mask (which may be slow).
        // This function allows the user to create a custom sequence of segments that switches
        // between modes (such as alphanumeric and byte) to encode text in less space.
        // This is a mid-level API; the high-level API is encodeText() and encodeBinary().
        static encodeSegments(segs, ecl, minVersion = 1, maxVersion = 40, mask = -1, boostEcl = true) {
            if (!(QrCode.MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= QrCode.MAX_VERSION)
                || mask < -1 || mask > 7)
                throw new RangeError("Invalid value");
            // Find the minimal version number to use
            let version;
            let dataUsedBits;
            for (version = minVersion;; version++) {
                const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8; // Number of data bits available
                const usedBits = QrSegment.getTotalBits(segs, version);
                if (usedBits <= dataCapacityBits) {
                    dataUsedBits = usedBits;
                    break; // This version number is found to be suitable
                }
                if (version >= maxVersion) // All versions in the range could not fit the given data
                    throw new RangeError("Data too long");
            }
            // Increase the error correction level while the data still fits in the current version number
            for (const newEcl of [QrCode.Ecc.MEDIUM, QrCode.Ecc.QUARTILE, QrCode.Ecc.HIGH]) { // From low to high
                if (boostEcl && dataUsedBits <= QrCode.getNumDataCodewords(version, newEcl) * 8)
                    ecl = newEcl;
            }
            // Concatenate all segments to create the data bit string
            let bb = [];
            for (const seg of segs) {
                appendBits(seg.mode.modeBits, 4, bb);
                appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
                for (const b of seg.getData())
                    bb.push(b);
            }
            assert(bb.length == dataUsedBits);
            // Add terminator and pad up to a byte if applicable
            const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
            assert(bb.length <= dataCapacityBits);
            appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
            appendBits(0, (8 - bb.length % 8) % 8, bb);
            assert(bb.length % 8 == 0);
            // Pad with alternating bytes until data capacity is reached
            for (let padByte = 0xEC; bb.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11)
                appendBits(padByte, 8, bb);
            // Pack bits into bytes in big endian
            let dataCodewords = [];
            while (dataCodewords.length * 8 < bb.length)
                dataCodewords.push(0);
            bb.forEach((b, i) => dataCodewords[i >>> 3] |= b << (7 - (i & 7)));
            // Create the QR Code object
            return new QrCode(version, ecl, dataCodewords, mask);
        }
        /*-- Constructor (low level) and fields --*/
        // Creates a new QR Code with the given version number,
        // error correction level, data codeword bytes, and mask number.
        // This is a low-level API that most users should not use directly.
        // A mid-level API is the encodeSegments() function.
        constructor(
        // The version number of this QR Code, which is between 1 and 40 (inclusive).
        // This determines the size of this barcode.
        version, 
        // The error correction level used in this QR Code.
        errorCorrectionLevel, dataCodewords, msk) {
            this.version = version;
            this.errorCorrectionLevel = errorCorrectionLevel;
            // The modules of this QR Code (false = light, true = dark).
            // Immutable after constructor finishes. Accessed through getModule().
            this.modules = [];
            // Indicates function modules that are not subjected to masking. Discarded when constructor finishes.
            this.isFunction = [];
            // Check scalar arguments
            if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION)
                throw new RangeError("Version value out of range");
            if (msk < -1 || msk > 7)
                throw new RangeError("Mask value out of range");
            this.size = version * 4 + 17;
            // Initialize both grids to be size*size arrays of Boolean false
            let row = [];
            for (let i = 0; i < this.size; i++)
                row.push(false);
            for (let i = 0; i < this.size; i++) {
                this.modules.push(row.slice()); // Initially all light
                this.isFunction.push(row.slice());
            }
            // Compute ECC, draw modules
            this.drawFunctionPatterns();
            const allCodewords = this.addEccAndInterleave(dataCodewords);
            this.drawCodewords(allCodewords);
            // Do masking
            if (msk == -1) { // Automatically choose best mask
                let minPenalty = 1000000000;
                for (let i = 0; i < 8; i++) {
                    this.applyMask(i);
                    this.drawFormatBits(i);
                    const penalty = this.getPenaltyScore();
                    if (penalty < minPenalty) {
                        msk = i;
                        minPenalty = penalty;
                    }
                    this.applyMask(i); // Undoes the mask due to XOR
                }
            }
            assert(0 <= msk && msk <= 7);
            this.mask = msk;
            this.applyMask(msk); // Apply the final choice of mask
            this.drawFormatBits(msk); // Overwrite old format bits
            this.isFunction = [];
        }
        /*-- Accessor methods --*/
        // Returns the color of the module (pixel) at the given coordinates, which is false
        // for light or true for dark. The top left corner has the coordinates (x=0, y=0).
        // If the given coordinates are out of bounds, then false (light) is returned.
        getModule(x, y) {
            return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
        }
        /*-- Private helper methods for constructor: Drawing function modules --*/
        // Reads this object's version field, and draws and marks all function modules.
        drawFunctionPatterns() {
            // Draw horizontal and vertical timing patterns
            for (let i = 0; i < this.size; i++) {
                this.setFunctionModule(6, i, i % 2 == 0);
                this.setFunctionModule(i, 6, i % 2 == 0);
            }
            // Draw 3 finder patterns (all corners except bottom right; overwrites some timing modules)
            this.drawFinderPattern(3, 3);
            this.drawFinderPattern(this.size - 4, 3);
            this.drawFinderPattern(3, this.size - 4);
            // Draw numerous alignment patterns
            const alignPatPos = this.getAlignmentPatternPositions();
            const numAlign = alignPatPos.length;
            for (let i = 0; i < numAlign; i++) {
                for (let j = 0; j < numAlign; j++) {
                    // Don't draw on the three finder corners
                    if (!(i == 0 && j == 0 || i == 0 && j == numAlign - 1 || i == numAlign - 1 && j == 0))
                        this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
                }
            }
            // Draw configuration data
            this.drawFormatBits(0); // Dummy mask value; overwritten later in the constructor
            this.drawVersion();
        }
        // Draws two copies of the format bits (with its own error correction code)
        // based on the given mask and this object's error correction level field.
        drawFormatBits(mask) {
            // Calculate error correction code and pack bits
            const data = this.errorCorrectionLevel.formatBits << 3 | mask; // errCorrLvl is uint2, mask is uint3
            let rem = data;
            for (let i = 0; i < 10; i++)
                rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const bits = (data << 10 | rem) ^ 0x5412; // uint15
            assert(bits >>> 15 == 0);
            // Draw first copy
            for (let i = 0; i <= 5; i++)
                this.setFunctionModule(8, i, getBit(bits, i));
            this.setFunctionModule(8, 7, getBit(bits, 6));
            this.setFunctionModule(8, 8, getBit(bits, 7));
            this.setFunctionModule(7, 8, getBit(bits, 8));
            for (let i = 9; i < 15; i++)
                this.setFunctionModule(14 - i, 8, getBit(bits, i));
            // Draw second copy
            for (let i = 0; i < 8; i++)
                this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
            for (let i = 8; i < 15; i++)
                this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
            this.setFunctionModule(8, this.size - 8, true); // Always dark
        }
        // Draws two copies of the version bits (with its own error correction code),
        // based on this object's version field, iff 7 <= version <= 40.
        drawVersion() {
            if (this.version < 7)
                return;
            // Calculate error correction code and pack bits
            let rem = this.version; // version is uint6, in the range [7, 40]
            for (let i = 0; i < 12; i++)
                rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            const bits = this.version << 12 | rem; // uint18
            assert(bits >>> 18 == 0);
            // Draw two copies
            for (let i = 0; i < 18; i++) {
                const color = getBit(bits, i);
                const a = this.size - 11 + i % 3;
                const b = Math.floor(i / 3);
                this.setFunctionModule(a, b, color);
                this.setFunctionModule(b, a, color);
            }
        }
        // Draws a 9*9 finder pattern including the border separator,
        // with the center module at (x, y). Modules can be out of bounds.
        drawFinderPattern(x, y) {
            for (let dy = -4; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    const dist = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev/infinity norm
                    const xx = x + dx;
                    const yy = y + dy;
                    if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
                        this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
                }
            }
        }
        // Draws a 5*5 alignment pattern, with the center module
        // at (x, y). All modules must be in bounds.
        drawAlignmentPattern(x, y) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++)
                    this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
            }
        }
        // Sets the color of a module and marks it as a function module.
        // Only used by the constructor. Coordinates must be in bounds.
        setFunctionModule(x, y, isDark) {
            this.modules[y][x] = isDark;
            this.isFunction[y][x] = true;
        }
        /*-- Private helper methods for constructor: Codewords and masking --*/
        // Returns a new byte string representing the given data with the appropriate error correction
        // codewords appended to it, based on this object's version and error correction level.
        addEccAndInterleave(data) {
            const ver = this.version;
            const ecl = this.errorCorrectionLevel;
            if (data.length != QrCode.getNumDataCodewords(ver, ecl))
                throw new RangeError("Invalid argument");
            // Calculate parameter numbers
            const numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
            const blockEccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
            const rawCodewords = Math.floor(QrCode.getNumRawDataModules(ver) / 8);
            const numShortBlocks = numBlocks - rawCodewords % numBlocks;
            const shortBlockLen = Math.floor(rawCodewords / numBlocks);
            // Split data into blocks and append ECC to each block
            let blocks = [];
            const rsDiv = QrCode.reedSolomonComputeDivisor(blockEccLen);
            for (let i = 0, k = 0; i < numBlocks; i++) {
                let dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
                k += dat.length;
                const ecc = QrCode.reedSolomonComputeRemainder(dat, rsDiv);
                if (i < numShortBlocks)
                    dat.push(0);
                blocks.push(dat.concat(ecc));
            }
            // Interleave (not concatenate) the bytes from every block into a single sequence
            let result = [];
            for (let i = 0; i < blocks[0].length; i++) {
                blocks.forEach((block, j) => {
                    // Skip the padding byte in short blocks
                    if (i != shortBlockLen - blockEccLen || j >= numShortBlocks)
                        result.push(block[i]);
                });
            }
            assert(result.length == rawCodewords);
            return result;
        }
        // Draws the given sequence of 8-bit codewords (data and error correction) onto the entire
        // data area of this QR Code. Function modules need to be marked off before this is called.
        drawCodewords(data) {
            if (data.length != Math.floor(QrCode.getNumRawDataModules(this.version) / 8))
                throw new RangeError("Invalid argument");
            let i = 0; // Bit index into the data
            // Do the funny zigzag scan
            for (let right = this.size - 1; right >= 1; right -= 2) { // Index of right column in each column pair
                if (right == 6)
                    right = 5;
                for (let vert = 0; vert < this.size; vert++) { // Vertical counter
                    for (let j = 0; j < 2; j++) {
                        const x = right - j; // Actual x coordinate
                        const upward = ((right + 1) & 2) == 0;
                        const y = upward ? this.size - 1 - vert : vert; // Actual y coordinate
                        if (!this.isFunction[y][x] && i < data.length * 8) {
                            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
                            i++;
                        }
                        // If this QR Code has any remainder bits (0 to 7), they were assigned as
                        // 0/false/light by the constructor and are left unchanged by this method
                    }
                }
            }
            assert(i == data.length * 8);
        }
        // XORs the codeword modules in this QR Code with the given mask pattern.
        // The function modules must be marked and the codeword bits must be drawn
        // before masking. Due to the arithmetic of XOR, calling applyMask() with
        // the same mask value a second time will undo the mask. A final well-formed
        // QR Code needs exactly one (not zero, two, etc.) mask applied.
        applyMask(mask) {
            if (mask < 0 || mask > 7)
                throw new RangeError("Mask value out of range");
            for (let y = 0; y < this.size; y++) {
                for (let x = 0; x < this.size; x++) {
                    let invert;
                    switch (mask) {
                        case 0:
                            invert = (x + y) % 2 == 0;
                            break;
                        case 1:
                            invert = y % 2 == 0;
                            break;
                        case 2:
                            invert = x % 3 == 0;
                            break;
                        case 3:
                            invert = (x + y) % 3 == 0;
                            break;
                        case 4:
                            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0;
                            break;
                        case 5:
                            invert = x * y % 2 + x * y % 3 == 0;
                            break;
                        case 6:
                            invert = (x * y % 2 + x * y % 3) % 2 == 0;
                            break;
                        case 7:
                            invert = ((x + y) % 2 + x * y % 3) % 2 == 0;
                            break;
                        default: throw new Error("Unreachable");
                    }
                    if (!this.isFunction[y][x] && invert)
                        this.modules[y][x] = !this.modules[y][x];
                }
            }
        }
        // Calculates and returns the penalty score based on state of this QR Code's current modules.
        // This is used by the automatic mask choice algorithm to find the mask pattern that yields the lowest score.
        getPenaltyScore() {
            let result = 0;
            // Adjacent modules in row having same color, and finder-like patterns
            for (let y = 0; y < this.size; y++) {
                let runColor = false;
                let runX = 0;
                let runHistory = [0, 0, 0, 0, 0, 0, 0];
                for (let x = 0; x < this.size; x++) {
                    if (this.modules[y][x] == runColor) {
                        runX++;
                        if (runX == 5)
                            result += QrCode.PENALTY_N1;
                        else if (runX > 5)
                            result++;
                    }
                    else {
                        this.finderPenaltyAddHistory(runX, runHistory);
                        if (!runColor)
                            result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
                        runColor = this.modules[y][x];
                        runX = 1;
                    }
                }
                result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * QrCode.PENALTY_N3;
            }
            // Adjacent modules in column having same color, and finder-like patterns
            for (let x = 0; x < this.size; x++) {
                let runColor = false;
                let runY = 0;
                let runHistory = [0, 0, 0, 0, 0, 0, 0];
                for (let y = 0; y < this.size; y++) {
                    if (this.modules[y][x] == runColor) {
                        runY++;
                        if (runY == 5)
                            result += QrCode.PENALTY_N1;
                        else if (runY > 5)
                            result++;
                    }
                    else {
                        this.finderPenaltyAddHistory(runY, runHistory);
                        if (!runColor)
                            result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
                        runColor = this.modules[y][x];
                        runY = 1;
                    }
                }
                result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * QrCode.PENALTY_N3;
            }
            // 2*2 blocks of modules having same color
            for (let y = 0; y < this.size - 1; y++) {
                for (let x = 0; x < this.size - 1; x++) {
                    const color = this.modules[y][x];
                    if (color == this.modules[y][x + 1] &&
                        color == this.modules[y + 1][x] &&
                        color == this.modules[y + 1][x + 1])
                        result += QrCode.PENALTY_N2;
                }
            }
            // Balance of dark and light modules
            let dark = 0;
            for (const row of this.modules)
                dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
            const total = this.size * this.size; // Note that size is odd, so dark/total != 1/2
            // Compute the smallest integer k >= 0 such that (45-5k)% <= dark/total <= (55+5k)%
            const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
            assert(0 <= k && k <= 9);
            result += k * QrCode.PENALTY_N4;
            assert(0 <= result && result <= 2568888); // Non-tight upper bound based on default values of PENALTY_N1, ..., N4
            return result;
        }
        /*-- Private helper functions --*/
        // Returns an ascending list of positions of alignment patterns for this version number.
        // Each position is in the range [0,177), and are used on both the x and y axes.
        // This could be implemented as lookup table of 40 variable-length lists of integers.
        getAlignmentPatternPositions() {
            if (this.version == 1)
                return [];
            else {
                const numAlign = Math.floor(this.version / 7) + 2;
                const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
                let result = [6];
                for (let pos = this.size - 7; result.length < numAlign; pos -= step)
                    result.splice(1, 0, pos);
                return result;
            }
        }
        // Returns the number of data bits that can be stored in a QR Code of the given version number, after
        // all function modules are excluded. This includes remainder bits, so it might not be a multiple of 8.
        // The result is in the range [208, 29648]. This could be implemented as a 40-entry lookup table.
        static getNumRawDataModules(ver) {
            if (ver < QrCode.MIN_VERSION || ver > QrCode.MAX_VERSION)
                throw new RangeError("Version number out of range");
            let result = (16 * ver + 128) * ver + 64;
            if (ver >= 2) {
                const numAlign = Math.floor(ver / 7) + 2;
                result -= (25 * numAlign - 10) * numAlign - 55;
                if (ver >= 7)
                    result -= 36;
            }
            assert(208 <= result && result <= 29648);
            return result;
        }
        // Returns the number of 8-bit data (i.e. not error correction) codewords contained in any
        // QR Code of the given version number and error correction level, with remainder bits discarded.
        // This stateless pure function could be implemented as a (40*4)-cell lookup table.
        static getNumDataCodewords(ver, ecl) {
            return Math.floor(QrCode.getNumRawDataModules(ver) / 8) -
                QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] *
                    QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
        }
        // Returns a Reed-Solomon ECC generator polynomial for the given degree. This could be
        // implemented as a lookup table over all possible parameter values, instead of as an algorithm.
        static reedSolomonComputeDivisor(degree) {
            if (degree < 1 || degree > 255)
                throw new RangeError("Degree out of range");
            // Polynomial coefficients are stored from highest to lowest power, excluding the leading term which is always 1.
            // For example the polynomial x^3 + 255x^2 + 8x + 93 is stored as the uint8 array [255, 8, 93].
            let result = [];
            for (let i = 0; i < degree - 1; i++)
                result.push(0);
            result.push(1); // Start off with the monomial x^0
            // Compute the product polynomial (x - r^0) * (x - r^1) * (x - r^2) * ... * (x - r^{degree-1}),
            // and drop the highest monomial term which is always 1x^degree.
            // Note that r = 0x02, which is a generator element of this field GF(2^8/0x11D).
            let root = 1;
            for (let i = 0; i < degree; i++) {
                // Multiply the current product by (x - r^i)
                for (let j = 0; j < result.length; j++) {
                    result[j] = QrCode.reedSolomonMultiply(result[j], root);
                    if (j + 1 < result.length)
                        result[j] ^= result[j + 1];
                }
                root = QrCode.reedSolomonMultiply(root, 0x02);
            }
            return result;
        }
        // Returns the Reed-Solomon error correction codeword for the given data and divisor polynomials.
        static reedSolomonComputeRemainder(data, divisor) {
            let result = divisor.map(_ => 0);
            for (const b of data) { // Polynomial division
                const factor = b ^ result.shift();
                result.push(0);
                divisor.forEach((coef, i) => result[i] ^= QrCode.reedSolomonMultiply(coef, factor));
            }
            return result;
        }
        // Returns the product of the two given field elements modulo GF(2^8/0x11D). The arguments and result
        // are unsigned 8-bit integers. This could be implemented as a lookup table of 256*256 entries of uint8.
        static reedSolomonMultiply(x, y) {
            if (x >>> 8 != 0 || y >>> 8 != 0)
                throw new RangeError("Byte out of range");
            // Russian peasant multiplication
            let z = 0;
            for (let i = 7; i >= 0; i--) {
                z = (z << 1) ^ ((z >>> 7) * 0x11D);
                z ^= ((y >>> i) & 1) * x;
            }
            assert(z >>> 8 == 0);
            return z;
        }
        // Can only be called immediately after a light run is added, and
        // returns either 0, 1, or 2. A helper function for getPenaltyScore().
        finderPenaltyCountPatterns(runHistory) {
            const n = runHistory[1];
            assert(n <= this.size * 3);
            const core = n > 0 && runHistory[2] == n && runHistory[3] == n * 3 && runHistory[4] == n && runHistory[5] == n;
            return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
                + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
        }
        // Must be called at the end of a line (row or column) of modules. A helper function for getPenaltyScore().
        finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
            if (currentRunColor) { // Terminate dark run
                this.finderPenaltyAddHistory(currentRunLength, runHistory);
                currentRunLength = 0;
            }
            currentRunLength += this.size; // Add light border to final run
            this.finderPenaltyAddHistory(currentRunLength, runHistory);
            return this.finderPenaltyCountPatterns(runHistory);
        }
        // Pushes the given value to the front and drops the last value. A helper function for getPenaltyScore().
        finderPenaltyAddHistory(currentRunLength, runHistory) {
            if (runHistory[0] == 0)
                currentRunLength += this.size; // Add light border to initial run
            runHistory.pop();
            runHistory.unshift(currentRunLength);
        }
    }
    /*-- Constants and tables --*/
    // The minimum version number supported in the QR Code Model 2 standard.
    QrCode.MIN_VERSION = 1;
    // The maximum version number supported in the QR Code Model 2 standard.
    QrCode.MAX_VERSION = 40;
    // For use in getPenaltyScore(), when evaluating which mask is best.
    QrCode.PENALTY_N1 = 3;
    QrCode.PENALTY_N2 = 3;
    QrCode.PENALTY_N3 = 40;
    QrCode.PENALTY_N4 = 10;
    QrCode.ECC_CODEWORDS_PER_BLOCK = [
        // Version: (note that index 0 is for padding, and is set to an illegal value)
        //0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
        [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Low
        [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // Medium
        [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Quartile
        [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // High
    ];
    QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
        // Version: (note that index 0 is for padding, and is set to an illegal value)
        //0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
        [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // Low
        [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // Medium
        [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Quartile
        [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // High
    ];
    // Appends the given number of low-order bits of the given value
    // to the given buffer. Requires 0 <= len <= 31 and 0 <= val < 2^len.
    function appendBits(val, len, bb) {
        if (len < 0 || len > 31 || val >>> len != 0)
            throw new RangeError("Value out of range");
        for (let i = len - 1; i >= 0; i--) // Append bit by bit
            bb.push((val >>> i) & 1);
    }
    // Returns true iff the i'th bit of x is set to 1.
    function getBit(x, i) {
        return ((x >>> i) & 1) != 0;
    }
    // Throws an exception if the given condition is false.
    function assert(cond) {
        if (!cond)
            throw new Error("Assertion error");
    }
    /*---- Data segment class ----*/
    /*
     * A segment of character/binary/control data in a QR Code symbol.
     * Instances of this class are immutable.
     * The mid-level way to create a segment is to take the payload data
     * and call a static factory function such as QrSegment.makeNumeric().
     * The low-level way to create a segment is to custom-make the bit buffer
     * and call the QrSegment() constructor with appropriate values.
     * This segment class imposes no length restrictions, but QR Codes have restrictions.
     * Even in the most favorable conditions, a QR Code can only hold 7089 characters of data.
     * Any segment longer than this is meaningless for the purpose of generating QR Codes.
     */
    class QrSegment {
        /** @type {typeof Mode} */
        static Mode;
        /*-- Static factory functions (mid level) --*/
        // Returns a segment representing the given binary data encoded in
        // byte mode. All input byte arrays are acceptable. Any text string
        // can be converted to UTF-8 bytes and encoded as a byte mode segment.
        static makeBytes(data) {
            let bb = [];
            for (const b of data)
                appendBits(b, 8, bb);
            return new QrSegment(QrSegment.Mode.BYTE, data.length, bb);
        }
        // Returns a segment representing the given string of decimal digits encoded in numeric mode.
        static makeNumeric(digits) {
            if (!QrSegment.isNumeric(digits))
                throw new RangeError("String contains non-numeric characters");
            let bb = [];
            for (let i = 0; i < digits.length;) { // Consume up to 3 digits per iteration
                const n = Math.min(digits.length - i, 3);
                appendBits(parseInt(digits.substring(i, i + n), 10), n * 3 + 1, bb);
                i += n;
            }
            return new QrSegment(QrSegment.Mode.NUMERIC, digits.length, bb);
        }
        // Returns a segment representing the given text string encoded in alphanumeric mode.
        // The characters allowed are: 0 to 9, A to Z (uppercase only), space,
        // dollar, percent, asterisk, plus, hyphen, period, slash, colon.
        static makeAlphanumeric(text) {
            if (!QrSegment.isAlphanumeric(text))
                throw new RangeError("String contains unencodable characters in alphanumeric mode");
            let bb = [];
            let i;
            for (i = 0; i + 2 <= text.length; i += 2) { // Process groups of 2
                let temp = QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45;
                temp += QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1));
                appendBits(temp, 11, bb);
            }
            if (i < text.length) // 1 character remaining
                appendBits(QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6, bb);
            return new QrSegment(QrSegment.Mode.ALPHANUMERIC, text.length, bb);
        }
        // Returns a new mutable list of zero or more segments to represent the given Unicode text string.
        // The result may use various segment modes and switch modes to optimize the length of the bit stream.
        static makeSegments(text) {
            // Select the most efficient segment encoding automatically
            if (text == "")
                return [];
            else if (QrSegment.isNumeric(text))
                return [QrSegment.makeNumeric(text)];
            else if (QrSegment.isAlphanumeric(text))
                return [QrSegment.makeAlphanumeric(text)];
            else
                return [QrSegment.makeBytes(QrSegment.toUtf8ByteArray(text))];
        }
        // Returns a segment representing an Extended Channel Interpretation
        // (ECI) designator with the given assignment value.
        static makeEci(assignVal) {
            let bb = [];
            if (assignVal < 0)
                throw new RangeError("ECI assignment value out of range");
            else if (assignVal < (1 << 7))
                appendBits(assignVal, 8, bb);
            else if (assignVal < (1 << 14)) {
                appendBits(0b10, 2, bb);
                appendBits(assignVal, 14, bb);
            }
            else if (assignVal < 1000000) {
                appendBits(0b110, 3, bb);
                appendBits(assignVal, 21, bb);
            }
            else
                throw new RangeError("ECI assignment value out of range");
            return new QrSegment(QrSegment.Mode.ECI, 0, bb);
        }
        // Tests whether the given string can be encoded as a segment in numeric mode.
        // A string is encodable iff each character is in the range 0 to 9.
        static isNumeric(text) {
            return QrSegment.NUMERIC_REGEX.test(text);
        }
        // Tests whether the given string can be encoded as a segment in alphanumeric mode.
        // A string is encodable iff each character is in the following set: 0 to 9, A to Z
        // (uppercase only), space, dollar, percent, asterisk, plus, hyphen, period, slash, colon.
        static isAlphanumeric(text) {
            return QrSegment.ALPHANUMERIC_REGEX.test(text);
        }
        /*-- Constructor (low level) and fields --*/
        // Creates a new QR Code segment with the given attributes and data.
        // The character count (numChars) must agree with the mode and the bit buffer length,
        // but the constraint isn't checked. The given bit buffer is cloned and stored.
        constructor(
        // The mode indicator of this segment.
        mode, 
        // The length of this segment's unencoded data. Measured in characters for
        // numeric/alphanumeric/kanji mode, bytes for byte mode, and 0 for ECI mode.
        // Always zero or positive. Not the same as the data's bit length.
        numChars, 
        // The data bits of this segment. Accessed through getData().
        bitData) {
            this.mode = mode;
            this.numChars = numChars;
            this.bitData = bitData;
            if (numChars < 0)
                throw new RangeError("Invalid argument");
            this.bitData = bitData.slice(); // Make defensive copy
        }
        /*-- Methods --*/
        // Returns a new copy of the data bits of this segment.
        getData() {
            return this.bitData.slice(); // Make defensive copy
        }
        // (Package-private) Calculates and returns the number of bits needed to encode the given segments at
        // the given version. The result is infinity if a segment has too many characters to fit its length field.
        static getTotalBits(segs, version) {
            let result = 0;
            for (const seg of segs) {
                const ccbits = seg.mode.numCharCountBits(version);
                if (seg.numChars >= (1 << ccbits))
                    return Infinity; // The segment's length doesn't fit the field's bit width
                result += 4 + ccbits + seg.bitData.length;
            }
            return result;
        }
        // Returns a new array of bytes representing the given string encoded in UTF-8.
        static toUtf8ByteArray(str) {
            str = encodeURI(str);
            let result = [];
            for (let i = 0; i < str.length; i++) {
                if (str.charAt(i) != "%")
                    result.push(str.charCodeAt(i));
                else {
                    result.push(parseInt(str.substring(i + 1, i + 3), 16));
                    i += 2;
                }
            }
            return result;
        }
    }
    /*-- Constants --*/
    // Describes precisely all strings that are encodable in numeric mode.
    QrSegment.NUMERIC_REGEX = /^[0-9]*$/;
    // Describes precisely all strings that are encodable in alphanumeric mode.
    QrSegment.ALPHANUMERIC_REGEX = /^[A-Z0-9 $%*+.\/:-]*$/;
    // The set of all legal characters in alphanumeric mode,
    // where each character value maps to the index in the string.
    QrSegment.ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
        class Ecc {
            /*-- Constructor and fields --*/
            constructor(
            // In the range 0 to 3 (unsigned 2-bit integer).
            ordinal, 
            // (Package-private) In the range 0 to 3 (unsigned 2-bit integer).
            formatBits) {
                this.ordinal = ordinal;
                this.formatBits = formatBits;
            }
        }
        /*-- Constants --*/
        Ecc.LOW = new Ecc(0, 1); // The QR Code can tolerate about  7% erroneous codewords
        Ecc.MEDIUM = new Ecc(1, 0); // The QR Code can tolerate about 15% erroneous codewords
        Ecc.QUARTILE = new Ecc(2, 3); // The QR Code can tolerate about 25% erroneous codewords
        Ecc.HIGH = new Ecc(3, 2); // The QR Code can tolerate about 30% erroneous codewords
        QrCode.Ecc = Ecc;
        class Mode {
            /*-- Constructor and fields --*/
            constructor(
            // The mode indicator bits, which is a uint4 value (range 0 to 15).
            modeBits, 
            // Number of character count bits for three different version ranges.
            numBitsCharCount) {
                this.modeBits = modeBits;
                this.numBitsCharCount = numBitsCharCount;
            }
            /*-- Method --*/
            // (Package-private) Returns the bit width of the character count field for a segment in
            // this mode in a QR Code at the given version number. The result is in the range [0, 16].
            numCharCountBits(ver) {
                return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
            }
        }
        /*-- Constants --*/
        Mode.NUMERIC = new Mode(0x1, [10, 12, 14]);
        Mode.ALPHANUMERIC = new Mode(0x2, [9, 11, 13]);
        Mode.BYTE = new Mode(0x4, [8, 16, 16]);
        Mode.KANJI = new Mode(0x8, [8, 10, 12]);
        Mode.ECI = new Mode(0x7, [0, 0, 0]);
        QrSegment.Mode = Mode;
    return { QrCode, QrSegment };
}
