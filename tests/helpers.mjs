import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { runtime, migrate, DEFAULT_SETTINGS, DEFAULT_TEST, DAY } from '../worker.js';

// Real SQLite semantics behind a D1-shaped fake: batch atomicity, triggers, UNIQUE and CAS
// are exercised, rather than faking the expected SQL results.
export class FakeD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.calls = []; this.writes = 0; }
  prepare(sql) {
    const db = this;
    return { bind(...args) {
      const exec = (mode) => {
        db.calls.push({ sql, args });
        if (/^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(sql)) db.writes++;
        const stmt = db.sqlite.prepare(sql);
        if (mode === 'first') return stmt.get(...args) || null;
        if (mode === 'all' || /^\s*SELECT\b/i.test(sql)) return { results: stmt.all(...args), meta: { changes: 0 } };
        if (/\bRETURNING\b/i.test(sql)) {
          const results = stmt.all(...args); return { results, meta: { changes: results.length } };
        }
        const info = stmt.run(...args); return { results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      };
      return { first: async () => exec('first'), all: async () => exec('all'), run: async () => exec('run'), _exec: exec };
    } };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const out = statements.map(s => s._exec('run')); this.sqlite.exec('COMMIT'); return out; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  row(sql, ...args) { return this.sqlite.prepare(sql).get(...args); }
  rows(sql, ...args) { return this.sqlite.prepare(sql).all(...args); }
  exec(sql, ...args) { return this.sqlite.prepare(sql).run(...args); }
  close() { this.sqlite.close(); }
}
export async function fixture(role = 'all') {
  const DB = new FakeD1();
  const secret = () => randomBytes(24).toString('hex');
  const env = { DB, ROLE: role, ADMIN_IDS: '901', MASTER_KEY: secret(), SETUP_KEY: secret(), CALLBACK_SECRET: secret(), WEBHOOK_SECRET: secret(), BOT_TOKEN: secret(), NODE_KEY_DE: secret(), NODE_KEY_TEST: secret() };
  let info;
  do { info = await migrate(runtime(env)); } while (!info.ready);
  const bot = { ...DEFAULT_SETTINGS, main_url: 'https://main.example.test', bot_username: 'NexiUPTestBot' };
  DB.exec("UPDATE nx_settings SET value=? WHERE key='bot'", JSON.stringify(bot));
  for (const id of [901, 101, 102, 103]) DB.exec('INSERT INTO nx_users(id,name,terms_at,created_at,last_at) VALUES(?,?,?,?,?)', id, 'Test user', Date.now(), Date.now(), Date.now());
  return { env, DB, r: () => runtime(env, { waitUntil: p => p.catch(() => {}) }), bot };
}
export function node(f, { id = 'de', code = 'de', purpose = 'sales', local = true, adapter = 'nexiup', enabled = true, capacity = 10 } = {}) {
  const origin = `https://${id}.example.test`;
  f.DB.exec('INSERT INTO nx_nodes(id,code,label,base_url,api_route,api_key_ref,max_users,enabled,purpose,adapter,local,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, code, id, origin, 'sync', purpose === 'test' ? 'NODE_KEY_TEST' : 'NODE_KEY_DE', capacity, +enabled, purpose, adapter, +local, Date.now());
  return f.DB.row('SELECT * FROM nx_nodes WHERE id=?', id);
}
export function testSettings(f, id, more = {}) {
  f.DB.exec("UPDATE nx_settings SET value=? WHERE key='test'", JSON.stringify({ ...DEFAULT_TEST, enabled: true, node_id: id, ...more }));
}
export function plan(f, more = {}) {
  const p = { id: 'basic', name: 'Test plan', description: 'Finite test fixture', days: 30, daily_gb: 1, total_gb: 20, conn_limit: 2, price: 100, locations: ['de', 'us'], enabled: true, reset_usage: false, max_configs: 4, ...more };
  f.DB.exec('INSERT OR REPLACE INTO nx_catalog(kind,id,data,enabled) VALUES(?,?,?,?)', 'plans', p.id, JSON.stringify(p), +p.enabled); return p;
}
export function pendingOrder(f, id = 'order1', more = {}) {
  const p = plan(f);
  f.DB.exec('INSERT INTO nx_orders(id,user_id,plan_id,kind,location,snapshot,total,status,receipt,created_at,expires_at,renewal_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, more.user_id || 101, p.id, 'sale', 'de', JSON.stringify({ ...p, ...more.plan }), 100, more.status || 'pending', JSON.stringify({ type: 'photo', file_id: 'synthetic_file_reference', note: '' }), Date.now(), Date.now() + DAY, more.renewal_id || null);
  return f.DB.row('SELECT * FROM nx_orders WHERE id=?', id);
}
export function uri(id = crypto.randomUUID(), host = 'node.example.test') {
  return `vless://${id}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent('/sync/ws?ed=2048')}`;
}
export function mockNetwork(t, handlers = {}) {
  const calls = [], remote = new Map();
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method || 'GET';
    const payload = init.body instanceof FormData ? init.body : (init.body ? JSON.parse(init.body) : null);
    const call = { url, method, payload, headers: init.headers }; calls.push(call);
    if (url.hostname === 'api.telegram.org') {
      if (handlers.telegram) { const res = await handlers.telegram(call); if (res) return res; }
      return Response.json({ ok: true, result: url.pathname.endsWith('getMe') ? { id: 999, username: 'NexiUPTestBot' } : { message_id: calls.length } });
    }
    if (handlers.node) { const res = await handlers.node(call, remote); if (res) return res; }
    const id = url.searchParams.get('id');
    if (url.pathname.endsWith('/api/users')) {
      const user = [...remote.values()].find(u => u.id === id || u.name === id);
      if (method === 'GET') return id ? (user ? Response.json({ success: true, user, ...(url.searchParams.get('action') === 'configs' ? { bases: [{ protocol: 'vless', id: user.id, server: url.hostname, host: url.hostname, sni: url.hostname, port: 443, path: '/sync/ws', alpn: [] }] } : {}) }) : Response.json({ success: false }, { status: 404 })) : Response.json({ success: true, total: remote.size, users: [...remote.values()] });
      if (method === 'POST' && !id) {
        const u = { ...payload, id: crypto.randomUUID(), expiryMs: Date.now() + Number(payload.expiryDays) * DAY, usage: { total: 0 } }; remote.set(u.name, u); return Response.json({ success: true, user: u }, { status: 201 });
      }
      if (method === 'PUT' && user) { Object.assign(user, payload); if (payload.expiryDays) user.expiryMs = Date.now() + Number(payload.expiryDays) * DAY; return Response.json({ success: true, user }); }
      if (method === 'POST' && user) { if (url.searchParams.get('action') === 'toggle') user.isPaused = !user.isPaused; else user.usage.total = 0; return Response.json({ success: true, user }); }
      if (method === 'DELETE') { if (user) remote.delete(user.name); return Response.json({ success: true }); }
    }
    if (url.pathname === '/sync') {
      const u = remote.get(url.searchParams.get('sub'));
      if (!u) return new Response('not found', { status: 404 });
      if (url.searchParams.get('format') === 'base') return Response.json([{ protocol: 'vless', id: u.id, server: url.hostname, host: url.hostname, sni: url.hostname, port: 443, path: '/sync/ws', alpn: [] }]);
      return new Response(btoa(uri(u.id, url.hostname)));
    }
    throw new Error('Unexpected network endpoint in test: ' + url.hostname + url.pathname);
  });
  return { calls, remote };
}
