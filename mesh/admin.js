const COOKIE = '__Host-nexiup-mesh';
const SESSION_MS = 30 * 60000;
const loginFailures = new Map();
function ownerSecret(env) { if(!strongSecret(env.OWNER_KEY))fail('owner_secret_required_min_32',503);return env.OWNER_KEY; }
function bearerOwner(env,request) { sameOrigin(request);if(!constantTimeEqual(request.headers.get('authorization')||'','Bearer '+ownerSecret(env)))fail('unauthorized',401); }
function authThrottle(request, failed = false) {
  const id=String(request.headers.get('cf-connecting-ip')||'unknown'),row=loginFailures.get(id),time=now();
  if(row?.until>time&&row.count>=8)fail('auth_throttled',429);
  if(failed){if(loginFailures.size>1000)loginFailures.clear();loginFailures.set(id,{count:(row?.until>time?row.count:0)+1,until:time+60000});fail('unauthorized',401);}
}
function cookie(token = '', age = 0) { return COOKIE+'='+token+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age='+age; }
async function ownerAuth(db,env,request) {
  sameOrigin(request);const secret=ownerSecret(env),authorization=request.headers.get('authorization');
  if(authorization!==null){if(!constantTimeEqual(authorization,'Bearer '+secret))fail('unauthorized',401);return {csrf:'',hash:'',expires_at:0};}
  const value=(request.headers.get('cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
  if(!/^[a-f0-9]{64}$/.test(value))fail('unauthorized',401);
  const hash=await digest(value),session=await db.first('SELECT * FROM nx3_sessions WHERE hash=? AND expires_at>?',hash,now());
  if(!session||!constantTimeEqual(session.credential_hash,await digest(secret)))fail('unauthorized',401);
  const csrf=await hmac(secret,'mesh-csrf:'+value);
  if(!['GET','HEAD'].includes(request.method)&&!constantTimeEqual(request.headers.get('X-NexiUP-CSRF')||'',csrf))fail('csrf_required',403);
  return {csrf,hash,expires_at:session.expires_at};
}
async function login(db,env,request) {
  sameOrigin(request);authThrottle(request);
  const secret=ownerSecret(env);if(!constantTimeEqual(request.headers.get('authorization')||'','Bearer '+secret))authThrottle(request,true);
  await initialize(db);
  const token=randomId(32),hash=await digest(token),expires=now()+SESSION_MS;
  await db.batch([
    ['DELETE FROM nx3_sessions WHERE expires_at<=?',now()],
    ['DELETE FROM nx3_sessions WHERE hash IN (SELECT hash FROM nx3_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 15)'],
    ['INSERT INTO nx3_sessions(hash,credential_hash,expires_at) VALUES(?,?,?)',hash,await digest(secret),expires],
    auditStmt('login','owner')
  ]);
  return json({success:true,version:VERSION,csrf:await hmac(secret,'mesh-csrf:'+token),expires_at:expires},200,{'Set-Cookie':cookie(token,SESSION_MS/1000)});
}
async function diagnostics(db,env,request) {
  bearerOwner(env,request);const requestId=randomId(12),report={component:'manager',version:VERSION,request_id:requestId,read_only:true,ready:false,database:'not_checked',schema:0,external_connectivity_tested:false,statements:0};
  let expired=false;
  try{await deadline((async()=>{
    const ping=await db.first('SELECT 1 AS value');if(expired)return;if(ping?.value!==1)fail('d1_invalid_response',503);report.database='ok';
    const meta=await db.first('SELECT version FROM nx3_meta WHERE id=1');if(expired)return;report.schema=meta?.version||0;
    const expected=SCHEMA.map(sql=>sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/)?.[1]).filter(Boolean);
    const tables=new Set((await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+expected.map(()=>'?').join(',')+")",...expected)).map(row=>row.name));if(expired)return;
    report['missing_tables']=expected.filter(name=>!tables.has(name));
    const required=SCHEMA.map(sql=>sql.match(/^CREATE TRIGGER IF NOT EXISTS (\w+)/)?.[1]).filter(Boolean);
    const triggers=new Set((await db.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ("+required.map(()=>'?').join(',')+")",...required)).map(row=>row.name));if(expired)return;
    report['missing_triggers']=required.filter(name=>!triggers.has(name));
    report.ready=report.schema===SCHEMA_VERSION&&report['missing_tables'].length===0&&report['missing_triggers'].length===0;
  })(),8000,'d1_read_timeout');}catch(error){report['error']=trustedFaults.has(error)?error.code:'d1_unavailable';if(report.database==='not_checked')report.database=report['error'];}finally{expired=true;}
  report.statements=db.queries;return json(report,report.ready?200:503,{'X-NexiUP-Request-ID':requestId});
}
function fallbackEndpoint(input) {
  string(input,280,1);let url;try{url=new URL('https://'+input);}catch{fail('invalid_fallback');}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('invalid_fallback');
  const host=publicHost(url.hostname),port=number(Number(url.port||443),1,65535,true);if(port===25)fail('invalid_fallback');
  return {host,port};
}
async function saveNode(db,env,body) {
  keys(body,['id','label','origin','key_ref','country','connect_host','fallbacks','enabled','version']);
  const id=ident(body.id),label=string(body.label,120,1).trim(),origin=httpsOrigin(body.origin),keyRef=secretRef(body.key_ref),country=body.country||'ZZ';
  if(!/^[A-Z]{2}$/.test(country))fail('invalid_country');
  const connectHost=body.connect_host?publicHost(body.connect_host):'';
  if(!Array.isArray(body.fallbacks)||body.fallbacks.length>4)fail('invalid_fallbacks');
  const fallbacks=body.fallbacks.map(fallbackEndpoint);
  bool(body.enabled);number(body.version,0,1e9,true);
  const secret=env[keyRef];if(!strongSecret(secret)||constantTimeEqual(secret,ownerSecret(env)))fail('node_secret_missing_or_owner_key',409);
  const other=await db.all('SELECT id,key_ref FROM nx3_nodes WHERE id<>?',id);
  if(other.some(row=>constantTimeEqual(env[row.key_ref],secret)))fail('node_secret_must_be_unique',409);
  const existing=await db.first('SELECT * FROM nx3_nodes WHERE id=?',id);
  if(!existing){if(body.version!==0)fail('version_conflict',409);if(other.length>=MAX_NODES)fail('node_limit',409);
    await db.batch([['INSERT INTO nx3_nodes(id,label,origin,key_ref,country,connect_host,fallbacks,created_at) VALUES(?,?,?,?,?,?,?,?)',id,label,origin,keyRef,country,connectHost,JSON.stringify(fallbacks),now()],auditStmt('node_registered',id)]);
  }else{
    if(existing.version!==body.version)fail('version_conflict',409);
    const identityChanged=existing.origin!==origin||existing.key_ref!==keyRef;
    if(body.enabled&&(identityChanged||!existing.verified_at))fail('test_node_before_enabling',409);
    const result=await db.run('UPDATE nx3_nodes SET label=?,origin=?,key_ref=?,country=?,connect_host=?,fallbacks=?,enabled=?,verified_at=?,last_status=?,version=version+1 WHERE id=? AND version=?',label,origin,keyRef,country,connectHost,JSON.stringify(fallbacks),body.enabled?1:0,identityChanged?0:existing.verified_at,identityChanged?'untested':existing.last_status,id,body.version);
    if(!changes(result))fail('version_conflict',409);await db.batch([auditStmt('node_updated',id,{enabled:body.enabled})]);
  }
  return db.first('SELECT * FROM nx3_nodes WHERE id=?',id);
}
async function testNode(db,env,id) {
  ident(id);const node=await db.first('SELECT * FROM nx3_nodes WHERE id=?',id);if(!node)fail('not_found',404);
  const secret=env[node.key_ref];if(!strongSecret(secret)||constantTimeEqual(secret,env.OWNER_KEY))fail('node_secret_missing_or_owner_key',409);
  const origin=await managerOrigin(db),challenge=randomId();let result;
  await db.run('INSERT INTO nx3_probes(id,node_id,created_at) VALUES(?,?,?)',challenge,node.id,now());
  try{
    const remote=await fetchJson(node.origin+'/_mesh/health',{headers:{Authorization:'Bearer '+secret,'X-NexiUP-Challenge':challenge}});
    if(!remote.response.ok)fail('node_check_failed',502);
    const data=remote.data;
    if(data.protocol!==PROTOCOL||data.component!=='node'||data.node_id!==node.id||data.challenge!==challenge)fail('incompatible_node',422);
    if(data.manager_origin!==origin||data.manager_reachable!==true)fail('node_manager_mismatch',409);
    const observed=await db.first('SELECT seen_at FROM nx3_probes WHERE id=? AND node_id=?',challenge,node.id);if(!observed?.seen_at)fail('bidirectional_probe_not_observed',502);
    result={ok:true,protocol:PROTOCOL,version:data.version,colo:typeof data.colo==='string'?data.colo.slice(0,8):null,api_round_trip_verified:true,proxy_exit_verified:false};
  }catch(error){result={ok:false,error:trustedFaults.has(error)?error.code:'node_unreachable',api_round_trip_verified:false,proxy_exit_verified:false};}finally{await db.run('DELETE FROM nx3_probes WHERE id=?',challenge);}
  const status=result.ok?'api_online':result.error;
  const saved=await db.run('UPDATE nx3_nodes SET last_check=?,last_status=?,verified_at=?,enabled=CASE WHEN ?=1 THEN enabled ELSE 0 END,version=version+1 WHERE id=? AND version=?',now(),status,result.ok?now():0,result.ok?1:0,id,node.version);
  if(!changes(saved))fail('version_conflict',409);
  await db.batch([auditStmt('node_tested',id,{ok:result.ok,code:status})]);return result;
}
function accountInput(body, creating = false) {
  keys(body,creating?['name','notes','days','expires_at','total_bytes','daily_bytes','conn_limit','protocol','node_mode','nodes','nonce']:['name','notes','expires_at','total_bytes','daily_bytes','conn_limit','protocol','node_mode','nodes','version']);
  const name=string(body.name,120,1).normalize('NFC').trim();if(!name)fail('name_required');
  const notes=string(body.notes||'',600),total=number(body.total_bytes,1,1e15,true),daily=number(body.daily_bytes,1,total,true),conn=number(body.conn_limit,1,32,true);
  if(!['vless','trojan','both'].includes(body.protocol)||!['all','selected'].includes(body.node_mode))fail('invalid_account_mode');
  if(!Array.isArray(body.nodes)||body.nodes.length>MAX_NODES||new Set(body.nodes).size!==body.nodes.length)fail('invalid_nodes');body.nodes.forEach(id=>ident(id));
  if(body.node_mode==='selected'&&!body.nodes.length)fail('choose_nodes');
  let expires=body.expires_at;
  if(creating&&body.days!==undefined){if(body.expires_at!==undefined)fail('choose_days_or_expiry');expires=now()+number(body.days,1,3650,true)*DAY;}
  number(expires,creating?now()+1000:1,now()+3651*DAY,true);
  return {name,notes,expires_at:expires,total_bytes:total,daily_bytes:daily,conn_limit:conn,protocol:body.protocol,node_mode:body.node_mode,nodes:body.node_mode==='all'?[]:body.nodes};
}
async function validateMembers(db, data) {
  const nodes=await db.all('SELECT id,enabled,verified_at FROM nx3_nodes');
  const allowed=nodes.filter(node=>node.enabled&&node.verified_at).map(node=>node.id);
  if(data.node_mode==='all'&&!allowed.length)fail('enable_a_tested_node_first',409);
  if(data.node_mode==='selected'&&data.nodes.some(id=>!allowed.includes(id)))fail('selected_node_unavailable',409);
}
async function accountView(db,id,withNodes = false) {
  ident(id);const a=await db.first(`SELECT a.*,COALESCE(u.charged,0) AS charged,COALESCE(u.up,0) AS up,COALESCE(u.down,0) AS down,COALESCE(d.charged,0) AS daily_charged,COALESCE(d.up,0) AS daily_up,COALESCE(d.down,0) AS daily_down FROM nx3_accounts a LEFT JOIN nx3_usage u ON u.account_id=a.id AND u.epoch=a.epoch LEFT JOIN nx3_daily d ON d.account_id=a.id AND d.epoch=a.epoch AND d.day=? WHERE a.id=?`,dayKey(),id);
  if(!a)fail('not_found',404);
  a.nodes=(await db.all('SELECT node_id FROM nx3_members WHERE account_id=? ORDER BY node_id',id)).map(row=>row.node_id);
  a.reserved_or_unreported=Math.max(0,a.charged-a.up-a.down);a.daily_reserved_or_unreported=Math.max(0,a.daily_charged-a.daily_up-a.daily_down);
  a.effective_status=a.status!=='active'?a.status:a.expires_at<=now()?'expired':a.activate_after>now()?'cooldown':a.charged>=a.total_bytes||a.daily_charged>=a.daily_bytes?'quota_reserved_or_exhausted':'active';
  a.subscription_url=(await managerOrigin(db))+'/sub/'+a.token;
  if(withNodes){a.node_usage=await db.all('SELECT u.node_id,u.up,u.down,u.charged-u.up-u.down AS outstanding,MAX(0,u.charged-u.up-u.down-COALESCE((SELECT SUM(granted-up-down) FROM nx3_leases l WHERE l.account_id=u.account_id AND l.epoch=u.epoch AND l.node_id=u.node_id AND l.closed=0 AND l.hard_until>?),0)) AS uncertain FROM nx3_node_usage u WHERE u.account_id=? AND u.epoch=? ORDER BY u.node_id',now(),id,a.epoch);a.connections=await db.all('SELECT node_id,COUNT(*) AS active FROM nx3_connections WHERE account_id=? AND closed=0 AND active_until>? GROUP BY node_id',id,now());}
  delete a.trojan_hash;delete a.create_key;delete a.create_hash;return a;
}
async function createAccount(db,body) {
  const data=accountInput(body,true),key=nonce(body.nonce),hash=await digest(JSON.stringify(body));
  const existing=await db.first('SELECT id,create_hash FROM nx3_accounts WHERE create_key=?',key);
  if(existing){if(existing.create_hash!==hash)fail('idempotency_conflict',409);return accountView(db,existing.id);}
  await managerOrigin(db);await validateMembers(db,data);
  const id=randomId(),identity=crypto.randomUUID(),token=randomId(32);
  const statements=[['INSERT INTO nx3_accounts(id,uuid,trojan_hash,token,name,notes,protocol,node_mode,total_bytes,daily_bytes,expires_at,conn_limit,create_key,create_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,identity,sha224(identity),token,data.name,data.notes,data.protocol,data.node_mode,data.total_bytes,data.daily_bytes,data.expires_at,data.conn_limit,key,hash,now()],...data.nodes.map(node=>['INSERT INTO nx3_members(account_id,node_id) VALUES(?,?)',id,node]),auditStmt('account_created',id,{node_mode:data.node_mode})];
  try{await db.batch(statements);}catch(error){const old=await db.first('SELECT id,create_hash FROM nx3_accounts WHERE create_key=?',key);if(old&&old.create_hash===hash)return accountView(db,old.id);throw error;}
  return accountView(db,id);
}
async function saveAccount(db,id,body) {
  const data=accountInput(body),version=number(body.version,1,1e9,true);await validateMembers(db,data);
  const marker=randomId();
  const statements=[['UPDATE nx3_accounts SET name=?,notes=?,protocol=?,node_mode=?,total_bytes=?,daily_bytes=?,expires_at=?,conn_limit=?,last_mutation=?,version=version+1 WHERE id=? AND version=? AND status<>? AND ? >= COALESCE((SELECT charged FROM nx3_usage WHERE account_id=? AND epoch=nx3_accounts.epoch),0) AND ? >= COALESCE((SELECT MAX(charged) FROM nx3_daily WHERE account_id=? AND epoch=nx3_accounts.epoch AND day>=?),0)',data.name,data.notes,data.protocol,data.node_mode,data.total_bytes,data.daily_bytes,data.expires_at,data.conn_limit,marker,id,version,'revoked',data.total_bytes,id,data.daily_bytes,id,dayKey()],
    ['DELETE FROM nx3_members WHERE account_id=? AND EXISTS(SELECT 1 FROM nx3_accounts WHERE id=? AND last_mutation=?)',id,id,marker],
    ...data.nodes.map(node=>['INSERT INTO nx3_members(account_id,node_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM nx3_accounts WHERE id=? AND last_mutation=?)',id,node,id,marker]),
    ['INSERT INTO nx3_audit(action,target,detail,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM nx3_accounts WHERE id=? AND last_mutation=?)','account_updated',id,'{}',now(),id,marker]];
  const result=await db.batch(statements);if(!changes(result[0]))fail('version_conflict_or_limit_below_committed',409);return accountView(db,id);
}
async function accountAction(db,id,body) {
  keys(body,['action','version','nonce','days','reset','confirm']);ident(id);nonce(body.nonce);number(body.version,1,1e9,true);
  if(!['pause','resume','revoke','renew','reset','rotate-token','rotate-identity'].includes(body.action))fail('invalid_action');
  if(body.reset!==undefined)bool(body.reset);
  const hash=await digest(JSON.stringify(body));
  const previous=await db.first('SELECT * FROM nx3_mutations WHERE id=?',body.nonce);
  if(previous){if(previous.account_id!==id||previous.kind!==body.action||previous.request_hash!==hash)fail('idempotency_conflict',409);return accountView(db,id);}
  const account=await db.first('SELECT * FROM nx3_accounts WHERE id=?',id);if(!account)fail('not_found',404);if(account.version!==body.version)fail('version_conflict',409);
  if(account.status==='revoked')fail('account_revoked',409);
  if(['revoke','reset','rotate-identity'].includes(body.action)&&body.confirm!==id)fail('confirmation_required');
  let set='',args=[];
  if(['pause','resume','revoke'].includes(body.action)){
    if(body.action==='resume'&&account.expires_at<=now())fail('renew_expired_account_first',409);
    set='status=?';args=[{pause:'paused',resume:'active',revoke:'revoked'}[body.action]];
  }else if(body.action==='renew'){
    const expiry=Math.max(account.expires_at,now())+number(body.days,1,3650,true)*DAY;number(expiry,now(),now()+3651*DAY,true);
    set="expires_at=?,status='active'";args=[expiry];
    if(body.reset===true){if(body.confirm!==id)fail('confirmation_required');set+=',epoch=epoch+1,activate_after=?';args.push(now()+PERMIT_MS+1500);}
  }else if(body.action==='reset'){set='epoch=epoch+1,activate_after=?';args=[now()+PERMIT_MS+1500];}
  else if(body.action==='rotate-token'){set='token=?';args=[randomId(32)];}
  else{const identity=crypto.randomUUID();set='uuid=?,trojan_hash=?,auth_version=auth_version+1,activate_after=?';args=[identity,sha224(identity),now()+PERMIT_MS+1500];}
  const statements=[['INSERT INTO nx3_mutations(id,account_id,kind,request_hash,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nx3_accounts WHERE id=? AND version=?)',body.nonce,id,body.action,hash,now(),id,body.version],
    ['UPDATE nx3_accounts SET '+set+',version=version+1,last_mutation=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM nx3_mutations WHERE id=? AND complete=0)',...args,body.nonce,id,body.version,body.nonce],
    ['INSERT INTO nx3_audit(action,target,detail,created_at) SELECT ?,?,?,? FROM nx3_mutations WHERE id=? AND complete=0','account_'+body.action,id,'{}',now(),body.nonce],
    ['UPDATE nx3_mutations SET complete=1 WHERE id=? AND complete=0',body.nonce]];
  try{const result=await db.batch(statements);if(!changes(result[1]))fail('version_conflict',409);}catch(error){const done=await db.first('SELECT * FROM nx3_mutations WHERE id=? AND complete=1',body.nonce);if(!done||done.account_id!==id||done.kind!==body.action||done.request_hash!==hash)throw error;}
  return accountView(db,id);
}
async function managerApi(db,env,request,url) {
  const path=url.pathname.slice(5),method=request.method;
  if(path==='login'&&method==='POST')return login(db,env,request);
  if(path==='diagnostics'&&method==='POST')return diagnostics(db,env,request);
  const auth=await ownerAuth(db,env,request);
  await requireSchema(db);
  if(path==='session'&&method==='GET')return json({csrf:auth.csrf,expires_at:auth.expires_at,version:VERSION});
  if(path==='logout'&&method==='POST'){if(auth.hash)await db.run('DELETE FROM nx3_sessions WHERE hash=?',auth.hash);return json({success:true},200,{'Set-Cookie':cookie()});}
  if(path==='overview'&&method==='GET'){
    const summary=await db.first("SELECT COUNT(*) AS accounts,SUM(status='active' AND expires_at>?) AS active,SUM(status='paused') AS paused,SUM(expires_at<=?) AS expired FROM nx3_accounts",now(),now());
    const usage=await db.first('SELECT COALESCE(SUM(u.charged),0) AS charged,COALESCE(SUM(u.up),0) AS up,COALESCE(SUM(u.down),0) AS down FROM nx3_usage u JOIN nx3_accounts a ON a.id=u.account_id AND a.epoch=u.epoch');
    const nodes=await db.all('SELECT id,label,origin,country,enabled,last_check,last_status FROM nx3_nodes ORDER BY id');
    const settings=await db.first("SELECT value,version FROM nx3_settings WHERE key='public_origin'");
    const days=await db.all('SELECT day,SUM(up+down) AS reported,SUM(charged) AS charged FROM nx3_daily WHERE day>=? GROUP BY day ORDER BY day',dayKey(now()-6*DAY));
    return json({summary,usage,nodes,days,public_origin:settings?.value||'',settings_version:settings?.version||1,version:VERSION,server_time:now(),quota_mode:'shared_reserved_bytes',revocation_max_ms:PERMIT_MS});
  }
  if(path==='settings'&&method==='PUT'){
    const body=await bodyJson(request);keys(body,['public_origin','version']);const origin=httpsOrigin(body.public_origin),version=number(body.version,1,1e9,true);
    const result=await db.run("UPDATE nx3_settings SET value=?,version=version+1 WHERE key='public_origin' AND version=?",origin,version);if(!changes(result))fail('version_conflict',409);await db.batch([auditStmt('origin_saved','manager')]);return json({success:true,public_origin:origin,version:version+1});
  }
  if(path==='nodes'&&method==='GET')return json({items:await db.all('SELECT * FROM nx3_nodes ORDER BY id'),limit:MAX_NODES});
  if(path==='nodes'&&method==='POST')return json({node:await saveNode(db,env,await bodyJson(request))});
  if(/^nodes\/[A-Za-z0-9_-]+\/test$/.test(path)&&method==='POST')return json(await testNode(db,env,path.split('/')[1]));
  if(path==='accounts'&&method==='POST')return json({account:await createAccount(db,await bodyJson(request))},201);
  if(path==='accounts'&&method==='GET'){
    const after=url.searchParams.get('after')||'',q=string(url.searchParams.get('q')||'',100);if(after)ident(after);
    const rows=await db.all(`SELECT a.id,a.name,a.status,a.expires_at,a.total_bytes,a.daily_bytes,a.conn_limit,a.protocol,a.node_mode,a.version,a.activate_after,COALESCE(u.charged,0) AS charged,COALESCE(u.up+u.down,0) AS reported,COALESCE(d.charged,0) AS daily_charged FROM nx3_accounts a LEFT JOIN nx3_usage u ON u.account_id=a.id AND u.epoch=a.epoch LEFT JOIN nx3_daily d ON d.account_id=a.id AND d.epoch=a.epoch AND d.day=? WHERE a.id>? AND (a.name LIKE ? OR a.notes LIKE ?) ORDER BY a.id LIMIT 21`,dayKey(),after,'%'+q+'%','%'+q+'%');
    return json({items:rows.slice(0,20),next:rows.length>20?rows[19].id:null});
  }
  const qrMatch=path.match(/^accounts\/([a-f0-9]{32})\/qr$/);
  if(qrMatch&&method==='GET'){const row=await db.first('SELECT token FROM nx3_accounts WHERE id=?',qrMatch[1]);if(!row)fail('not_found',404);const link=(await managerOrigin(db))+'/sub/'+row.token;return new Response(qrPng(link),{headers:{...noStore,'Content-Type':'image/png'}});}
  const match=path.match(/^accounts\/([a-f0-9]{32})(\/action)?$/);
  if(match){if(match[2]&&method==='POST')return json({account:await accountAction(db,match[1],await bodyJson(request))});if(!match[2]&&method==='GET')return json({account:await accountView(db,match[1],true)});if(!match[2]&&method==='PUT')return json({account:await saveAccount(db,match[1],await bodyJson(request))});}
  if(path==='profiles'&&method==='GET')return json({items:(await db.all('SELECT * FROM nx3_profiles ORDER BY id')).map(row=>({profile:parse(row.data),version:row.version,can_rollback:!!row.previous}))});
  if(path==='profiles'&&method==='PUT'){
    const body=await bodyJson(request);keys(body,['profile','version']);const p=validateProfile(body.profile),version=number(body.version,1,1e9,true);
    const result=await db.run('UPDATE nx3_profiles SET previous=data,data=?,version=version+1 WHERE id=? AND version=?',JSON.stringify(p),p.id,version);if(!changes(result))fail('version_conflict',409);await db.batch([auditStmt('profile_saved',p.id)]);return json({success:true,version:version+1});
  }
  if(path==='profiles/rollback'&&method==='POST'){
    const body=await bodyJson(request);keys(body,['id','version']);ident(body.id);number(body.version,1,1e9,true);
    const old=await db.first('SELECT previous FROM nx3_profiles WHERE id=? AND version=?',body.id,body.version);if(!old?.previous)fail('no_previous_profile',409);validateProfile(parse(old.previous));
    const result=await db.run('UPDATE nx3_profiles SET data=previous,previous=data,version=version+1 WHERE id=? AND version=?',body.id,body.version);if(!changes(result))fail('version_conflict',409);await db.batch([auditStmt('profile_rolled_back',body.id)]);return json({success:true,version:body.version+1});
  }
  if(path==='maintenance'&&method==='POST'){await maintenance(db);return json({success:true,bounded_rows_per_table:100,quota_refunded:false});}
  if(path==='audit'&&method==='GET'){
    const before=number(Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER),1,Number.MAX_SAFE_INTEGER,true);const rows=await db.all('SELECT id,action,target,created_at FROM nx3_audit WHERE id<? ORDER BY id DESC LIMIT 51',before);return json({items:rows.slice(0,50),next:rows.length>50?rows[49].id:null});
  }
  fail('not_found',404);
}
