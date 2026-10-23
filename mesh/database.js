// Manager-only authoritative ledger. No copy of this storage layer is shipped to nodes.
const SCHEMA_VERSION = 1;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nx3_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS nx3_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS nx3_sessions (hash TEXT PRIMARY KEY,credential_hash TEXT NOT NULL,expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS nx3_session_expiry ON nx3_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS nx3_nodes (id TEXT PRIMARY KEY,label TEXT NOT NULL,origin TEXT NOT NULL UNIQUE,key_ref TEXT NOT NULL UNIQUE,country TEXT NOT NULL DEFAULT 'ZZ',connect_host TEXT NOT NULL DEFAULT '',fallbacks TEXT NOT NULL DEFAULT '[]',enabled INTEGER NOT NULL DEFAULT 0,verified_at INTEGER NOT NULL DEFAULT 0,last_check INTEGER NOT NULL DEFAULT 0,last_status TEXT NOT NULL DEFAULT 'untested',version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS nx3_probes (id TEXT PRIMARY KEY,node_id TEXT NOT NULL,created_at INTEGER NOT NULL,seen_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS nx3_accounts (id TEXT PRIMARY KEY,uuid TEXT NOT NULL UNIQUE,trojan_hash TEXT NOT NULL UNIQUE,token TEXT NOT NULL UNIQUE,name TEXT NOT NULL UNIQUE COLLATE NOCASE,notes TEXT NOT NULL DEFAULT '',protocol TEXT NOT NULL DEFAULT 'vless',node_mode TEXT NOT NULL DEFAULT 'all',total_bytes INTEGER NOT NULL CHECK(total_bytes>0),daily_bytes INTEGER NOT NULL CHECK(daily_bytes>0),expires_at INTEGER NOT NULL,conn_limit INTEGER NOT NULL CHECK(conn_limit BETWEEN 1 AND 32),status TEXT NOT NULL DEFAULT 'active',epoch INTEGER NOT NULL DEFAULT 1,auth_version INTEGER NOT NULL DEFAULT 1,last_mutation TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,activate_after INTEGER NOT NULL DEFAULT 0,create_key TEXT NOT NULL UNIQUE,create_hash TEXT NOT NULL,created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS nx3_members (account_id TEXT NOT NULL REFERENCES nx3_accounts(id),node_id TEXT NOT NULL REFERENCES nx3_nodes(id),PRIMARY KEY(account_id,node_id))`,
  `CREATE TABLE IF NOT EXISTS nx3_usage (account_id TEXT NOT NULL REFERENCES nx3_accounts(id),epoch INTEGER NOT NULL,charged INTEGER NOT NULL DEFAULT 0 CHECK(charged>=0),up INTEGER NOT NULL DEFAULT 0,down INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,epoch))`,
  `CREATE TABLE IF NOT EXISTS nx3_daily (account_id TEXT NOT NULL,epoch INTEGER NOT NULL,day TEXT NOT NULL,charged INTEGER NOT NULL DEFAULT 0 CHECK(charged>=0),up INTEGER NOT NULL DEFAULT 0,down INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,epoch,day))`,
  `CREATE TABLE IF NOT EXISTS nx3_node_usage (account_id TEXT NOT NULL,epoch INTEGER NOT NULL,node_id TEXT NOT NULL,charged INTEGER NOT NULL DEFAULT 0 CHECK(charged>=0),up INTEGER NOT NULL DEFAULT 0,down INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,epoch,node_id))`,
  `CREATE TABLE IF NOT EXISTS nx3_connections (id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES nx3_accounts(id),node_id TEXT NOT NULL REFERENCES nx3_nodes(id),epoch INTEGER NOT NULL,auth_version INTEGER NOT NULL,protocol TEXT NOT NULL,created_at INTEGER NOT NULL,hard_until INTEGER NOT NULL,active_until INTEGER NOT NULL,closed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS nx3_connection_active ON nx3_connections(account_id,active_until,closed)`,
  `CREATE TABLE IF NOT EXISTS nx3_leases (id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES nx3_connections(id),account_id TEXT NOT NULL,node_id TEXT NOT NULL,epoch INTEGER NOT NULL,day TEXT NOT NULL,granted INTEGER NOT NULL CHECK(granted>0 AND granted<=4194304),up INTEGER NOT NULL DEFAULT 0,down INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0,issued_at INTEGER NOT NULL,hard_until INTEGER NOT NULL,CHECK(up>=0 AND down>=0 AND up+down<=granted))`,
  `CREATE INDEX IF NOT EXISTS nx3_lease_connection ON nx3_leases(connection_id,closed)`,
  `CREATE INDEX IF NOT EXISTS nx3_lease_account ON nx3_leases(account_id,epoch,hard_until)`,
  `CREATE INDEX IF NOT EXISTS nx3_daily_day ON nx3_daily(day)`,
  `CREATE TRIGGER IF NOT EXISTS nx3_node_cap BEFORE INSERT ON nx3_nodes WHEN (SELECT COUNT(*) FROM nx3_nodes)>=12 BEGIN SELECT RAISE(ABORT,'mesh_node_limit'); END`,
  `CREATE TABLE IF NOT EXISTS nx3_mutations (id TEXT PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,request_hash TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS nx3_profiles (id TEXT PRIMARY KEY,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,previous TEXT)`,
  `CREATE TABLE IF NOT EXISTS nx3_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS nx3_profile_guard AFTER UPDATE ON nx3_profiles BEGIN SELECT CASE WHEN (SELECT SUM(CASE WHEN json_extract(data,'$.enabled')=1 THEN MAX(1,json_array_length(data,'$.ech')) ELSE 0 END) FROM nx3_profiles) NOT BETWEEN 1 AND 6 THEN RAISE(ABORT,'mesh_profile_budget') END; END`,
  `CREATE TRIGGER IF NOT EXISTS nx3_open_guard BEFORE INSERT ON nx3_connections BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM nx3_accounts a JOIN nx3_nodes n ON n.id=NEW.node_id WHERE a.id=NEW.account_id AND a.epoch=NEW.epoch AND a.auth_version=NEW.auth_version AND a.status='active' AND a.expires_at>NEW.created_at AND a.activate_after<=NEW.created_at AND n.enabled=1 AND (a.protocol='both' OR a.protocol=NEW.protocol) AND (a.node_mode='all' OR EXISTS(SELECT 1 FROM nx3_members m WHERE m.account_id=a.id AND m.node_id=n.id))) THEN RAISE(ABORT,'mesh_account_unavailable') END;
    SELECT CASE WHEN (SELECT COUNT(*) FROM nx3_connections c WHERE c.account_id=NEW.account_id AND c.closed=0 AND c.active_until>NEW.created_at)>=(SELECT conn_limit FROM nx3_accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'mesh_connection_limit') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS nx3_grant_guard BEFORE INSERT ON nx3_leases BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM nx3_connections c JOIN nx3_accounts a ON a.id=c.account_id JOIN nx3_nodes n ON n.id=c.node_id WHERE c.id=NEW.connection_id AND c.account_id=NEW.account_id AND c.node_id=NEW.node_id AND c.epoch=NEW.epoch AND c.epoch=a.epoch AND c.auth_version=a.auth_version AND c.closed=0 AND c.active_until>NEW.issued_at AND c.hard_until>=NEW.hard_until AND a.status='active' AND a.expires_at>NEW.issued_at AND a.activate_after<=NEW.issued_at AND n.enabled=1 AND (a.protocol='both' OR a.protocol=c.protocol) AND (a.node_mode='all' OR EXISTS(SELECT 1 FROM nx3_members m WHERE m.account_id=a.id AND m.node_id=n.id))) THEN RAISE(ABORT,'mesh_account_unavailable') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM nx3_leases l WHERE l.connection_id=NEW.connection_id AND l.closed=0) THEN RAISE(ABORT,'mesh_lease_not_closed') END;
    SELECT CASE WHEN COALESCE((SELECT charged FROM nx3_usage WHERE account_id=NEW.account_id AND epoch=NEW.epoch),0)+NEW.granted>(SELECT total_bytes FROM nx3_accounts WHERE id=NEW.account_id) OR COALESCE((SELECT charged FROM nx3_daily WHERE account_id=NEW.account_id AND epoch=NEW.epoch AND day=NEW.day),0)+NEW.granted>(SELECT daily_bytes FROM nx3_accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'mesh_quota_exceeded') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS nx3_grant_charge AFTER INSERT ON nx3_leases BEGIN
    INSERT INTO nx3_usage(account_id,epoch,charged) VALUES(NEW.account_id,NEW.epoch,NEW.granted) ON CONFLICT(account_id,epoch) DO UPDATE SET charged=charged+NEW.granted;
    INSERT INTO nx3_node_usage(account_id,epoch,node_id,charged) VALUES(NEW.account_id,NEW.epoch,NEW.node_id,NEW.granted) ON CONFLICT(account_id,epoch,node_id) DO UPDATE SET charged=charged+NEW.granted;
    INSERT INTO nx3_daily(account_id,epoch,day,charged) VALUES(NEW.account_id,NEW.epoch,NEW.day,NEW.granted) ON CONFLICT(account_id,epoch,day) DO UPDATE SET charged=charged+NEW.granted;
  END`,
  `CREATE TRIGGER IF NOT EXISTS nx3_report_guard BEFORE UPDATE ON nx3_leases BEGIN
    SELECT CASE WHEN NEW.id<>OLD.id OR NEW.connection_id<>OLD.connection_id OR NEW.account_id<>OLD.account_id OR NEW.node_id<>OLD.node_id OR NEW.epoch<>OLD.epoch OR NEW.day<>OLD.day OR NEW.granted<>OLD.granted OR NEW.hard_until<>OLD.hard_until OR NEW.up<OLD.up OR NEW.down<OLD.down OR NEW.closed<OLD.closed OR (OLD.closed=1 AND (NEW.up<>OLD.up OR NEW.down<>OLD.down)) THEN RAISE(ABORT,'mesh_invalid_report') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS nx3_report_usage AFTER UPDATE ON nx3_leases BEGIN
    UPDATE nx3_usage SET up=up+NEW.up-OLD.up,down=down+NEW.down-OLD.down,charged=charged-CASE WHEN NEW.closed=1 AND OLD.closed=0 THEN NEW.granted-NEW.up-NEW.down ELSE 0 END WHERE account_id=NEW.account_id AND epoch=NEW.epoch;
    UPDATE nx3_node_usage SET up=up+NEW.up-OLD.up,down=down+NEW.down-OLD.down,charged=charged-CASE WHEN NEW.closed=1 AND OLD.closed=0 THEN NEW.granted-NEW.up-NEW.down ELSE 0 END WHERE account_id=NEW.account_id AND epoch=NEW.epoch AND node_id=NEW.node_id;
    UPDATE nx3_daily SET up=up+NEW.up-OLD.up,down=down+NEW.down-OLD.down,charged=charged-CASE WHEN NEW.closed=1 AND OLD.closed=0 THEN NEW.granted-NEW.up-NEW.down ELSE 0 END WHERE account_id=NEW.account_id AND epoch=NEW.epoch AND day=NEW.day;
  END`
];
function managerDb(env) {
  let raw, queries=0;
  function db() {
    if(raw)return raw;
    try{raw=env.DB;}catch{fail('d1_binding_unavailable',503);}
    if(raw==null)fail('d1_binding_missing',503);
    try{if(typeof raw!=='object'||typeof raw.prepare!=='function'||typeof raw.batch!=='function')fail('d1_binding_invalid',503);}
    catch(error){if(trustedFaults.has(error))throw error;fail('d1_binding_invalid',503);}return raw;
  }
  function reserve(n) {if(queries+n>46)fail('query_budget',503);queries+=n;}
  function classify(error) {
    if(trustedFaults.has(error))throw error;
    const message=errorText(error);
    /** @type {[string,string,number][]} */
    const codes=[['mesh_quota_exceeded','quota_exceeded',403],['mesh_account_unavailable','account_unavailable',403],['mesh_connection_limit','connection_limit',429],['mesh_lease_not_closed','lease_not_closed',409],['mesh_invalid_report','invalid_report',409],['mesh_node_limit','node_limit',409],['mesh_profile_budget','profile_variant_budget',409]];
    for(const [marker,code,status] of codes)if(message.includes(marker))fail(code,status);
    if(/no such table:\s*nx3_/i.test(message))fail('setup_required',503);
    if(/UNIQUE constraint failed/i.test(message))fail('conflict',409);
    fail('d1_unavailable',503);
  }
  const statement=(sql,args)=>db().prepare(sql).bind(...args);
  return {
    get queries(){return queries;},
    async first(sql,...args){reserve(1);try{const op=statement(sql,args).first();return await (/^\s*SELECT\b/i.test(sql)?deadline(op,8000,'d1_read_timeout'):op);}catch(error){return classify(error);}},
    async all(sql,...args){reserve(1);try{const op=statement(sql,args).all(),result=await (/^\s*SELECT\b/i.test(sql)?deadline(op,8000,'d1_read_timeout'):op);return result.results||[];}catch(error){return classify(error);}},
    async run(sql,...args){reserve(1);try{return await statement(sql,args).run();}catch(error){return classify(error);}},
    async batch(items){reserve(items.length);try{return await db().batch(items.map(([sql,...args])=>statement(sql,args)));}catch(error){return classify(error);}}
  };
}
function auditStmt(action,target,detail = {}) { return ['INSERT INTO nx3_audit(action,target,detail,created_at) VALUES(?,?,?,?)',action,target,JSON.stringify(detail),now()]; }
async function initialize(db) {
  let version=0;try{version=(await db.first('SELECT version FROM nx3_meta WHERE id=1'))?.version||0;}catch(error){if(!trustedFaults.has(error)||error.code!=='setup_required')throw error;}
  if(version>SCHEMA_VERSION)fail('schema_newer_than_worker',503);
  if(version===SCHEMA_VERSION){await requireSchema(db);return;}
  await db.batch([...SCHEMA.map(sql=>[sql]),['INSERT OR IGNORE INTO nx3_settings(key,value) VALUES(?,?)','public_origin',''],...DEFAULT_PROFILES.map(profile=>['INSERT OR IGNORE INTO nx3_profiles(id,data) VALUES(?,?)',profile.id,JSON.stringify(profile)]),['INSERT OR REPLACE INTO nx3_meta(id,version) VALUES(1,?)',SCHEMA_VERSION]]);
}
async function managerOrigin(db) { const row=await db.first("SELECT value FROM nx3_settings WHERE key='public_origin'");if(!row?.value)fail('set_public_origin_first',409);return httpsOrigin(row.value); }

async function requireSchema(db) {
  const tables=SCHEMA.map(sql=>sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/)?.[1]).filter(Boolean);
  const triggers=SCHEMA.map(sql=>sql.match(/^CREATE TRIGGER IF NOT EXISTS (\w+)/)?.[1]).filter(Boolean);
  const row=await db.first(`SELECT (SELECT version FROM nx3_meta WHERE id=1) AS version,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (${tables.map(()=>'?').join(',')})) AS tables,(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN (${triggers.map(()=>'?').join(',')})) AS triggers`,...tables,...triggers);
  if(row?.version!==SCHEMA_VERSION||row.tables!==tables.length||row.triggers!==triggers.length)fail('schema_incomplete',503);
}
async function maintenance(db) {
  await requireSchema(db);const before=now()-7*DAY;
  // No usage refunds on pruning. Per-account/day/node counters survive. Mutations
  // and account identities are NOT purged, preserving administrative idempotency.
  await db.batch([
    ['DELETE FROM nx3_probes WHERE id IN (SELECT id FROM nx3_probes WHERE created_at<? LIMIT 100)',now()-60000],
    ['DELETE FROM nx3_sessions WHERE hash IN (SELECT hash FROM nx3_sessions WHERE expires_at<? LIMIT 100)',now()],
    ['DELETE FROM nx3_leases WHERE id IN (SELECT id FROM nx3_leases WHERE hard_until<? ORDER BY hard_until LIMIT 100)',before],
    ['DELETE FROM nx3_connections WHERE id IN (SELECT id FROM nx3_connections c WHERE hard_until<? AND NOT EXISTS(SELECT 1 FROM nx3_leases l WHERE l.connection_id=c.id) ORDER BY hard_until LIMIT 100)',before]
  ]);
}
