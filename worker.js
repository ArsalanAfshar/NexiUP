/**
 * NexiUP 2 — Telegram sales hub and original Nahan-compatible node.
 * Copyright (c) 2026 NexiUP Contributors. MIT; see LICENSE and THIRD_PARTY.md.
 * One ES module; paste directly into Cloudflare Workers. No runtime npm dependencies.
 * Nahan source is NOT vendored: its inspected license grant was incomplete.
 * Sections: storage/security, profiles/formats, node API/tunnel, provisioning,
 * Telegram UI/administration, delivery/cron, HTTP router, embedded MIT QR encoder.
 */
import { connect } from 'cloudflare:sockets';

const VERSION = '2.0.0';
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
  constructor(code, status = 400, retry = 0) { super(code); this.code = code; this.status = status; this.retry = retry; }
}
const fail = (code, status = 400) => { throw new Fault(code, status); };
const now = () => Date.now();
const randomId = (bytes = 12) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const copy = x => JSON.parse(JSON.stringify(x));
const parse = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const changes = r => Number(r?.meta?.changes || 0);
const html = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const codeOf = e => e instanceof Fault ? e.code : 'internal_error'; // Never store remote error bodies, URLs or stacks.
const stamp = ms => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
const t = (u, fa, en) => u?.lang === 'en' ? en : fa;
const noStore = { 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers:{ ...noStore, 'Content-Type':'application/json; charset=utf-8', ...extra } });
function constantTimeEqual(a, b) {
  a = enc.encode(String(a || '')); b = enc.encode(String(b || ''));
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
function strongSecret(v) { return typeof v === 'string' && v.length >= 32 && v.length <= 256; }
function getRole(env) { const r = env.ROLE || 'all'; if (!['hub','node','all'].includes(r)) fail('invalid_role', 503); return r; }
function ownerIds(env) { return String(env.ADMIN_IDS || '').split(',').filter(x => /^\d{1,16}$/.test(x.trim())).map(x => Number(x.trim())).filter(x => x > 0 && Number.isSafeInteger(x)).slice(0, 5); }

/** Counts statements, not just batch round trips. Leaves room below D1's Free 50. */
function runtime(env, execution = {}) {
  const raw = env.DB;
  let queries = 0, external = 0;
  const dbError = e => { if(String(e?.message||'').includes('insufficient_balance'))throw new Fault('insufficient_balance',409);throw e; };
  const reserve = n => { if (queries + n > 46) throw new Fault('query_budget', 503, 60); queries += n; };
  const st = (sql, args) => raw.prepare(sql).bind(...args);
  return {
    env, raw, execution,
    get queries() { return queries; }, get external() { return external; },
    first(sql, ...args) { reserve(1); return st(sql, args).first(); },
    async all(sql, ...args) { reserve(1); return (await st(sql, args).all()).results || []; },
    run(sql, ...args) { reserve(1); return st(sql, args).run().catch(dbError); },
    batch(items) { reserve(items.length); return raw.batch(items.map(([sql, ...args]) => st(sql, args))).catch(dbError); },
    async fetch(url, init = {}, timeout = 8000) {
      if (++external > 40) throw new Fault('fetch_budget', 503, 60);
      // Disallow redirects so Authorization never follows a node to a different origin.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { ...init, redirect:'error', signal:controller.signal });
        // Body reads must be bounded by the same deadline, not just response headers.
        const bytes = await boundedBody(res, 1024 * 1024);
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
  ]
];

/** One migration per call: safe to repeat concurrently, and fits the 50-query ceiling. */
async function migrate(r) {
  await r.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const v = (await r.first('SELECT MAX(version) AS version FROM schema_version'))?.version || 0;
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
    const row = await r.first('SELECT MAX(version) AS version FROM schema_version');
    if (row?.version === MIGRATIONS.length) { initialized.set(r.raw, true); return; }
  } catch {}
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
  const fallback = ({ bot:DEFAULT_SETTINGS, test:DEFAULT_TEST, panel:DEFAULT_PANEL })[key] || {};
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
function auditStmt(actor, action, target, detail = {}) { return ['INSERT INTO nx_audit(actor,action,target,detail,created_at) VALUES(?,?,?,?,?)', String(actor), action, String(target), JSON.stringify(detail), now()]; }
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
    ...[['bot',DEFAULT_SETTINGS],['test',DEFAULT_TEST],['panel',DEFAULT_PANEL]].map(([k,v]) => ['INSERT OR IGNORE INTO nx_settings(key,value,updated_at) VALUES(?,?,?)', k, JSON.stringify(v), now()]),
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
  p.clean_ips=listHosts(p.clean_ips); p.proxy_ips=listHosts(p.proxy_ips); p.user_nodes=listHosts(p.user_nodes);
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
  for(const k of ['proxyIp','cleanIp','userNodes']) if(input[k]!==undefined) d[k]=listHosts(input[k] || []).join(',');
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
    const d=parse(row.data); d.isPaused=!d.isPaused;
    await r.run('UPDATE nx_panel_users SET data=? WHERE id=?',JSON.stringify(d),id);
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
  await rate(r,'panel-api:'+actor+':'+ip,100);
  return actor;
}
async function panelApi(r,request,url,panel) {
  const route=`/${panel.api_route}/api/`, endpoint=url.pathname.slice(route.length);
  const actor=await panelAuth(r,request,['config','keys','backup','restore','logs','usage','update'].includes(endpoint));
  const id=url.searchParams.get('id'),action=url.searchParams.get('action')||'', method=request.method;
  if(endpoint==='users') {
    if(method==='GET') {
      if(id) return json({success:true,user:await panelGet(r,id,url.origin)});
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
      if(!strongSecret(r.env[data.secret_ref])||constantTimeEqual(r.env[data.secret_ref],r.env.MASTER_KEY)) fail('set_distinct_panel_key_secret_first');
      if((await r.first('SELECT COUNT(*) AS n FROM nx_panel_keys')).n>=8) fail('too_many_keys');
      const kid=randomId(8);
      await r.run('INSERT INTO nx_panel_keys(id,name,secret_ref,created_at) VALUES(?,?,?,?)',kid,data.name,data.secret_ref,now());
      await audit(r,actor,'key_registered',kid,{secret_ref:data.secret_ref});return json({success:true,id:kid},201);
    }
  }
  if(endpoint==='stats'&&method==='GET') return json({success:true,colo:request.cf?.colo||null,edge_country:request.cf?.country||null,proxy_exit:{verified:false,ip:null,country:null},users:(await r.first('SELECT COUNT(*) AS n FROM nx_panel_users')).n,version:VERSION});
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
      const proxies=listHosts(auth.proxyIp||panel.proxy_ips);
      for(const host of [parsed.host,...proxies].slice(0,3)) {
        try{socket=connect({hostname:host,port:parsed.port});socket.closed?.catch(()=>{});await timed(socket.opened,5000,()=>closeSocket(socket));break;}catch{closeSocket(socket);socket=null;}
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
  if(early){try{if(early.length>5464)fail('early_data_limit');const s=atob(early.replaceAll('-','+').replaceAll('_','/'));incoming({data:Uint8Array.from(s,c=>c.charCodeAt(0)).buffer});}catch{close();}}
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
  if(!n.local&&(!strongSecret(r.env[n.api_key_ref])||constantTimeEqual(r.env[n.api_key_ref],r.env.MASTER_KEY)))fail('distinct_node_secret_required');
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
  if(node.local) {
    if(getRole(r.env)==='hub')fail('local_requires_all_role',503);
    if(!strongSecret(r.env.MASTER_KEY))fail('master_key_required_min_32',503);
    if(method==='GET'&&id)return {success:true,user:await panelGet(r,id,node.base_url)};
    if(method==='GET')return {success:true,total:(await r.first('SELECT COUNT(*) AS n FROM nx_panel_users')).n};
    if(method==='POST'&&!id)return {success:true,user:await panelCreate(r,payload,idempotency)};
    return panelMutate(r,id,method,payload||{},action,idempotency);
  }
  const key=r.env[node.api_key_ref];
  if(!strongSecret(key)||constantTimeEqual(key,r.env.MASTER_KEY))fail('node_api_key_missing_or_master',503);
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
    // Node's ordinary subscription base mode is account-scoped and has no arbitrary URL trust.
    const url=`${node.base_url}/${node.api_route}?sub=${encodeURIComponent(user.name)}&format=base`;
    const res=await r.fetch(url);if(!res.ok)fail('node_configs_unavailable',502);
    const bases=parse(await res.text());if(!Array.isArray(bases)||!bases.length||bases.length>4)fail('invalid_node_configs');
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
  if(['bot','test','panel'].includes(kind))return {doc:await setting(r,kind,true),version:0};
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
  if(kind==='test'){
    const t=validateTestSettings(doc);if(t.enabled){const n=await r.first('SELECT * FROM nx_nodes WHERE id=? AND enabled=1',t.node_id);if(!n)fail('test_node_unavailable');if(n.purpose!=='test'&&!t.allow_sales_node)fail('sales_node_not_explicitly_allowed_for_tests');}return t;
  }
  if(kind==='profiles')return validateProfile(doc);
  if(kind==='nodes')return validateNode(doc);
  return validateCatalog(kind,doc);
}
async function applyEdit(r,actor,kind,doc,version) {
  const value=await validateEdit(r,kind,doc);
  if(['bot','test','panel'].includes(kind))return putSetting(r,kind,value,actor);
  if(kind==='profiles')return saveProfile(r,actor,value,version);
  if(kind==='nodes')return saveNode(r,value,actor);
  return saveCatalog(r,actor,kind,value,version);
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
async function isAdmin(r,id){if(ownerIds(r.env).includes(Number(id)))return true;const u=await r.first('SELECT admin,banned FROM nx_users WHERE id=?',id);return !!u?.admin&&!u.banned;}
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
  const buttons=[
    ['nodes','🌐 نودها / Nodes'],['profiles','📡 پروفایل اپراتور / Profiles'],['test','🧪 تنظیمات تست / Test settings'],
    ['plans','🛒 پلن‌ها / Plans'],['payments','💳 پرداخت / Payments'],['guides','📖 راهنما / Guides'],['channels','📢 عضویت / Channels'],['coupons','🎟 تخفیف / Coupons'],['texts','📝 متن‌ها / Texts'],['bot','⚙️ تنظیمات ربات / Bot settings'],['panel','🛡 تنظیمات نود محلی / Local node']
  ].map(([id,label])=>({label,action:'manage',id}));
  buttons.push({label:'📦 سفارش‌ها / Orders',action:'orders'},{label:'🔁 صدور و بازیابی / Operations',action:'ops'},{label:'🧪 سابقه تست / Test grants',action:'grants'},{label:'👥 کاربران / Users',action:'users'},{label:'💸 برداشت‌ها / Withdrawals',action:'withdrawals'},{label:'📣 همگانی / Broadcast',action:'broadcast'},{label:'📊 آمار / Statistics',action:'stats'},{label:'☁️ مصرف Cloudflare / Usage',action:'usage'},{label:'💾 پشتیبان تنظیمات / Backup',action:'backup'},{label:'📋 رویدادها / Audit',action:'audit'},back(u));
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
  return send(r,u,`${id}\nUser: ${s.user_id}; node: ${s.node_id}\n${s.status}; expiry: ${stamp(s.expires_at)}`,[{label:'توقف/ادامه / Pause/resume',action:'subtoggle',id},{label:'افزودن روز / Extend days',action:'subextend',id},{label:'صفرکردن مصرف / Reset usage',action:'subreset',id},{label:'حذف حساب / Delete account',action:'subdelete',id},{label:'مدیریت / Admin',action:'admin'}]);
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
      if(full.length<=4096)steps.push({method:'sendMessage',payload:{chat_id:u.id,text:full,link_preview_options:{is_disabled:true}}});
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

const ADMIN_ACTIONS=new Set(['admin','manage','managepage','edit','apply','rollback','nodetest','channeltest','resetcool','cooluser','orders','review','approve','reject','ops','opview','retryop','absentop','resetdone','confirmop','users','userview','usersearch','ban','balance','directmsg','usersubs','setadmin','admsub','subtoggle','subextend','subreset','subdelete','subconfirm','grants','withdrawals','wdview','wdapprove','wdreject','broadcast','bcstart','bcstop','stats','usage','audit','backup','exportkind','ticketreply']);
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
    const rows=await r.all('SELECT * FROM nx_nodes WHERE id>? ORDER BY id LIMIT 7',cursor);records=[];
    for(const row of rows.slice(0,6))records.push((await editableDoc(r,'nodes',row.id)).doc);if(rows.length>6)next=rows[5].id;
  }else if(kind==='profiles')records=(await profiles(r,true)).map(({version,...doc})=>doc);
  else {const rows=await catalog(r,kind,false,cursor,7);records=rows.slice(0,6).map(({version,...doc})=>doc);if(rows.length>6)next=rows[5].id;}
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
  if(!d||d.project!=='NexiUP'||d.version!==2||!Array.isArray(d.records)||d.records.length>6)fail('invalid_v2_backup');
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
        try{await send(r,{id:uid},`⚠️ ${e.code}${e.retry?' ('+e.retry+'s)':''}\n${t(null,'لطفاً وضعیت را بررسی کنید یا دوباره از منو اقدام کنید.','Check status or retry from the menu.')}`,[{label:'منو / Menu',action:'home'}]);}catch{}
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
    ['DELETE FROM nx_flush WHERE id IN(SELECT id FROM nx_flush WHERE created_at<? LIMIT 100)',now()-7*DAY]
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
  if(slot===0||slot===2){const op=await r.first("SELECT id FROM nx_ops WHERE state IN ('queued','creating','ready','reconcile') AND retry_at<=? ORDER BY created_at LIMIT 1",now());if(op)await processOp(r,op.id);}
  else if(slot===1||slot===3){const job=await r.first("SELECT id FROM nx_jobs WHERE status='queued' AND due<=? ORDER BY created_at LIMIT 1",now());if(job)await processJob(r,job.id,3);}
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
    async function safe(fn){try{$('status').textContent='…';await fn();$('status').textContent='✓';}catch(e){$('status').textContent=e.message;}}
    function editor(doc){$('editor').value=JSON.stringify(doc,null,2);}
    function userDoc(u){const keys=['name','trafficLimit','dailyLimit','expiryMs','notes','connLimit','maxConfigs','proxyIp','cleanIp','userNodes','userPanelUrl','userMode','userPorts','isPaused'];return Object.fromEntries(keys.filter(k=>u[k]!==undefined).map(k=>[k,u[k]]));}
    async function load(){
      $('title').textContent=tab; $('list').replaceChildren();$('next').classList.add('hidden');
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
    $('new').onclick=()=>{tab='users';selected='';editor({name:'',trafficLimit:1,dailyLimit:1,expiryDays:1,connLimit:1,maxConfigs:4,notes:''});};
    $('save').onclick=()=>safe(async()=>{const doc=JSON.parse($('editor').value);if(!confirm('Apply validated changes?'))return;if(tab==='config'){show(await api('config','PUT',doc));base='/'+doc.api_route+'/api/';history.replaceState(null,'','/'+doc.api_route+'/dash');}else if(tab==='keys')show(await api('keys','POST',doc));else show(await api('users'+(selected?'?id='+encodeURIComponent(selected):''),selected?'PUT':'POST',doc));});
    for(const [id,action]of [['pause','toggle'],['reset','reset'],['delete','delete']])$(id).onclick=()=>safe(async()=>{if(!selected||!confirm('Confirm '+action+'?'))return;show(await api('users?id='+encodeURIComponent(selected)+(action==='delete'?'':'&action='+action),action==='delete'?'DELETE':'POST'));});
    $('download').onclick=()=>{if(!last)return;const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(last,null,2)],{type:'application/json'}));a.href=url;a.download='nexiup-panel-page.json';a.click();URL.revokeObjectURL(url);};
    $('import').onclick=()=>safe(async()=>{const f=$('restore').files[0];if(!f||f.size>64000)throw Error('Select a backup page under 64 KB');if(!confirm('Upsert identities/settings? Usage will not be reset.'))return;show(await api('restore','POST',JSON.parse(await f.text())));});
    $('lang').onclick=()=>{const en=document.documentElement.lang!=='en';document.documentElement.lang=en?'en':'fa';document.documentElement.dir=en?'ltr':'rtl';};
  `);
}
function setupPage() {
  return page('Setup',`<header><div><span class="badge">NexiUP / Setup</span><h1>راه‌اندازی امن / Secure setup</h1></div></header>
  <div class="card"><p>در نقش hub/all از SETUP_KEY و در نقش node از MASTER_KEY استفاده کنید. راز در URL ذخیره نمی‌شود. / Use SETUP_KEY for hub/all, MASTER_KEY for node. No secrets in URLs.</p><label for="key">Setup secret</label><input type="password" id="key" autocomplete="off"><label for="origin">Main HTTPS Worker origin (hub/all)</label><input id="origin" placeholder="https://…"><button id="migrate">۱. آماده‌سازی D1 / Initialize D1</button><button id="configure">۲. دامنه اصلی / Save main origin</button><button id="hook">۳. فعال‌سازی ربات / Register webhook</button><p>Then configure nodes, plans and test settings in Telegram /admin. Enable one cron: <code>* * * * *</code>.</p><button class="secondary" id="op">صدور بعدی / Process next operation</button><button class="secondary" id="job">تحویل بعدی / Process next delivery</button><pre id="result" role="status"></pre></div>`,String.raw`
  const $=id=>document.getElementById(id);let busy=false;
  async function call(action,extra={}){const res=await fetch('/setup',{method:'POST',headers:{Authorization:'Bearer '+$('key').value,'Content-Type':'application/json'},body:JSON.stringify({action,...extra})});const d=await res.json();$('result').textContent=JSON.stringify(d,null,2);if(!res.ok)throw Error(d.error||res.status);return d;}
  async function safe(fn){if(busy)return;busy=true;try{await fn();}catch(e){$('result').textContent=e.message;}finally{busy=false;}}
  $('migrate').onclick=()=>safe(async()=>{for(let i=0;i<6;i++){const d=await call('migrate');if(d.ready)break;}});
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
async function setup(r,request) {
  if(request.method==='GET')return setupPage();if(request.method!=='POST')fail('method_not_allowed',405);
  const role=getRole(r.env),secret=role==='node'?r.env.MASTER_KEY:r.env.SETUP_KEY;
  if(!strongSecret(secret))fail('setup_secret_required_min_32',503);
  if(!constantTimeEqual(request.headers.get('authorization'),'Bearer '+secret))fail('unauthorized',401);
  const b=await bodyJson(request);
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
    if(b.kind==='op'){const op=await r.first("SELECT id FROM nx_ops WHERE state IN ('queued','creating','ready','reconcile') AND retry_at<=? ORDER BY created_at LIMIT 1",now());if(op)await processOp(r,op.id);return json({processed:op?.id||null});}
    if(b.kind==='job'){const job=await r.first("SELECT id FROM nx_jobs WHERE status='queued' AND due<=? ORDER BY created_at LIMIT 1",now());if(job)await processJob(r,job.id,2);return json({processed:job?.id||null});}
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
    const r=runtime(env,execution);
    try{
      const role=getRole(env),url=new URL(request.url);
      if(url.pathname==='/health')return json({project:'NexiUP',version:VERSION,role});
      if(url.pathname==='/setup')return await setup(r,request);
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
    }catch(e){return json({error:codeOf(e)},e instanceof Fault?e.status:500,e.retry?{'Retry-After':String(e.retry)}:{});}
  },
  async scheduled(event,env,execution) {
    const work=scheduled(runtime(env,execution),event).catch(()=>{}); // Never log tokens, URLs, receipts or configs.
    execution.waitUntil(work);
  }
};

// ---- Embedded QR encoder follows. Transpiled once from Project Nayuki TypeScript.
// No deployment compilation, remote dependency, dynamic evaluation or Node API.
/*
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
"use strict";
var qrcodegen;
(function (qrcodegen) {
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
        /*-- Static factory functions (high level) --*/
        // Returns a QR Code representing the given Unicode text string at the given error correction level.
        // As a conservative upper bound, this function is guaranteed to succeed for strings that have 738 or fewer
        // Unicode code points (not UTF-16 code units) if the low error correction level is used. The smallest possible
        // QR Code version is automatically chosen for the output. The ECC level of the result may be higher than the
        // ecl argument if it can be done without increasing the version.
        static encodeText(text, ecl) {
            const segs = qrcodegen.QrSegment.makeSegments(text);
            return QrCode.encodeSegments(segs, ecl);
        }
        // Returns a QR Code representing the given binary data at the given error correction level.
        // This function always encodes using the binary segment mode, not any text mode. The maximum number of
        // bytes allowed is 2953. The smallest possible QR Code version is automatically chosen for the output.
        // The ECC level of the result may be higher than the ecl argument if it can be done without increasing the version.
        static encodeBinary(data, ecl) {
            const seg = qrcodegen.QrSegment.makeBytes(data);
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
    qrcodegen.QrCode = QrCode;
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
    qrcodegen.QrSegment = QrSegment;
})(qrcodegen || (qrcodegen = {}));
/*---- Public helper enumeration ----*/
(function (qrcodegen) {
    var QrCode;
    (function (QrCode) {
        /*
         * The error correction level in a QR Code symbol. Immutable.
         */
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
    })(QrCode = qrcodegen.QrCode || (qrcodegen.QrCode = {}));
})(qrcodegen || (qrcodegen = {}));
/*---- Public helper enumeration ----*/
(function (qrcodegen) {
    var QrSegment;
    (function (QrSegment) {
        /*
         * Describes how a segment's data bits are interpreted. Immutable.
         */
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
    })(QrSegment = qrcodegen.QrSegment || (qrcodegen.QrSegment = {}));
})(qrcodegen || (qrcodegen = {}));
