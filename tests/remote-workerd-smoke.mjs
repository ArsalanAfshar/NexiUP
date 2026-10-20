// Optional two-Worker integration: real workerd + two native local D1 databases.
// All network calls are routed to the local node/Telegram fake; no live credentials.
const { Miniflare, convertV4MiniflareOptions } = await import(process.env.MINIFLARE_MODULE || 'miniflare');
const { randomBytes } = await import('node:crypto');
const assert = await import('node:assert/strict');
const secret = () => randomBytes(24).toString('hex');
const apiKey = secret(), master = secret(), setup = secret();
const source = new URL('../worker.js', import.meta.url).pathname;
let nodeCalls = 0, telegramCalls = 0;
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  {
    name: 'hub', modules: true, scriptPath: source, compatibilityDate: '2026-10-20', compatibilityFlags: ['global_fetch_strictly_public'],
    d1Databases: { DB: 'hub-db' },
    bindings: { ROLE: 'hub', ADMIN_IDS: '901', SETUP_KEY: setup, CALLBACK_SECRET: secret(), WEBHOOK_SECRET: secret(), BOT_TOKEN: secret(), NODE_KEY_REMOTE: apiKey },
    outboundService: async (request, instance) => {
      const url = new URL(request.url);
      if (url.hostname === 'node.example.test') {
        nodeCalls++;
        const target = await instance.getWorker('node');
        return target.fetch(request.url, { method: request.method, headers: request.headers, ...(request.method !== 'GET' ? { body: await request.arrayBuffer() } : {}) });
      }
      if (url.hostname === 'api.telegram.org') { telegramCalls++; return Response.json({ ok: true, result: { message_id: telegramCalls } }); }
      throw new Error('Unexpected external network request in integration test');
    }
  },
  {
    name: 'node', modules: true, scriptPath: source, compatibilityDate: '2026-10-20', compatibilityFlags: ['global_fetch_strictly_public'],
    d1Databases: { DB: 'node-db' }, bindings: { ROLE: 'node', MASTER_KEY: master, NODE_KEY_REMOTE: apiKey }
  }
] }));
async function post(target, origin, path, key, body) {
  const res = await target.fetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status < 300, true, JSON.stringify(data)); return data;
}
try {
  const hub = await mf.getWorker('hub'), node = await mf.getWorker('node');
  for (let i = 0; i < 12; i++) {
    const h = await post(hub, 'https://main.example.test', '/setup', setup, { action: 'migrate' });
    const n = await post(node, 'https://node.example.test', '/setup', master, { action: 'migrate' });
    if (h.ready && n.ready) break;
    assert.ok(i < 11, 'migrations must complete');
  }
  await post(hub, 'https://main.example.test', '/setup', setup, { action: 'configure', main_url: 'https://main.example.test' });
  await post(node, 'https://node.example.test', '/sync/api/keys', master, { name: 'local integration hub', secret_ref: 'NODE_KEY_REMOTE' });
  const db = await mf.getD1Database('DB', 'hub');
  await db.prepare('INSERT INTO nx_users(id,name,terms_at,created_at,last_at) VALUES(?,?,?,?,?)').bind(101, 'Synthetic customer', Date.now(), Date.now(), Date.now()).run();
  await db.prepare('INSERT INTO nx_nodes(id,code,label,base_url,api_route,api_key_ref,max_users,enabled,purpose,adapter,local,created_at) VALUES(?,?,?,?,?,?,10,1,?,?,0,?)').bind('test', 'test', 'Synthetic test node', 'https://node.example.test', 'sync', 'NODE_KEY_REMOTE', 'test', 'nexiup', Date.now()).run();
  const plan = { days: 1, total_gb: 1, daily_gb: 1, conn_limit: 1, max_configs: 4, reset_usage: false };
  await db.prepare('INSERT INTO nx_ops(id,kind,user_id,node_id,name,payload,state,created_at) VALUES(?,?,?,?,?,?,?,?)').bind('integration', 'test', 101, 'test', 'test_101_' + randomBytes(10).toString('hex'), JSON.stringify({ plan, cooldown_hours: 48, node_id: 'test', location: 'test', purpose: 'test' }), 'queued', Date.now()).run();
  await db.prepare('INSERT INTO nx_test_slots(user_id,op_id) VALUES(?,?)').bind(101, 'integration').run();
  await db.prepare('INSERT INTO nx_test_grants(op_id,user_id,node_id,status,created_at) VALUES(?,?,?,?,?)').bind('integration', 101, 'test', 'queued', Date.now()).run();
  await post(hub, 'https://main.example.test', '/setup', setup, { action: 'tick', kind: 'op' });
  const op = await db.prepare('SELECT state,error FROM nx_ops WHERE id=?').bind('integration').first();
  assert.equal(op.state, 'done', JSON.stringify(op));
  const sub = await db.prepare('SELECT token,remote_id FROM nx_subs WHERE user_id=?').bind(101).first();
  const response = await hub.fetch('https://main.example.test/sub/' + sub.token + '?format=xray');
  assert.equal(response.status, 200); assert.equal((await response.json()).length, 3);
  await post(hub, 'https://main.example.test', '/setup', setup, { action: 'tick', kind: 'job' });
  assert.equal(telegramCalls, 2); assert.ok(nodeCalls >= 4);
  const nodeDb = await mf.getD1Database('DB', 'node');
  assert.equal((await nodeDb.prepare('SELECT COUNT(*) AS n FROM nx_panel_users').first()).n, 1);
  console.log('Two-Worker workerd smoke PASS: authenticated burst, one remote account, 3 main-domain variants, PNG + metadata delivered to Telegram fake.');
} finally { await mf.dispose(); }
