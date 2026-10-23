// Central authorization, global connection admission and reserve-before-forward credits.
async function nodeAuth(db, env, request) {
  sameOrigin(request);
  const authorization=request.headers.get('authorization')||'';if(!authorization.startsWith('Bearer ')||!strongSecret(authorization.slice(7)))fail('unauthorized',401);
  const id=ident(request.headers.get('X-NexiUP-Node')||'');
  const node=await db.first('SELECT * FROM nx3_nodes WHERE id=?',id);
  if(!node)fail('unauthorized',401);
  const secret=env[secretRef(node.key_ref)];
  if(!strongSecret(secret)||constantTimeEqual(secret,env.OWNER_KEY)||!constantTimeEqual(request.headers.get('authorization')||'','Bearer '+secret))fail('unauthorized',401);
  return node;
}
function connectionReply(connection, account, node, lease = null) {
  return {protocol:PROTOCOL,version:VERSION,server_time:now(),connection_id:connection.id,account_id:account.id,epoch:account.epoch,auth_version:account.auth_version,
    permit_until:connection.active_until,hard_until:connection.hard_until,fallbacks:parse(node.fallbacks,[]),
    ...(lease?{lease:{id:lease.id,granted:lease.granted,up:lease.up,down:lease.down,closed:!!lease.closed,hard_until:lease.hard_until}}:{})};
}
async function allowedAccount(db, node, accountId, protocol, time = now()) {
  const a=await db.first("SELECT a.* FROM nx3_accounts a WHERE a.id=? AND a.status='active' AND a.expires_at>? AND a.activate_after<=? AND (a.protocol=? OR a.protocol='both') AND (a.node_mode='all' OR EXISTS(SELECT 1 FROM nx3_members m WHERE m.account_id=a.id AND m.node_id=?))",accountId,time,time,protocol,node.id);
  if(!a||!node.enabled)fail('account_unavailable',403);return a;
}
function reportStatement(node, report, connectionId) {
  keys(report,['lease_id','up','down']);nonce(report.lease_id);
  number(report.up,0,MAX_GRANT,true);number(report.down,0,MAX_GRANT,true);
  return ['UPDATE nx3_leases SET up=?,down=?,closed=1 WHERE id=? AND node_id=? AND connection_id=? AND closed=0 AND up<=? AND down<=? AND granted>=?',report.up,report.down,report.lease_id,node.id,connectionId,report.up,report.down,report.up+report.down];
}
async function verifyReport(db,node,report,connectionId) {
  reportStatement(node,report,connectionId);
  const row=await db.first('SELECT * FROM nx3_leases WHERE id=? AND node_id=? AND connection_id=?',report.lease_id,node.id,connectionId);
  if(!row||report.up<row.up||report.down<row.down||report.up+report.down>row.granted||(row.closed&&(report.up!==row.up||report.down!==row.down)))fail('invalid_report',409);
  return row;
}
async function grant(db,node,connection,account,leaseId,wanted,previous = null) {
  nonce(leaseId);number(wanted,1,MAX_GRANT,true);
  const existing=await db.first('SELECT * FROM nx3_leases WHERE id=?',leaseId);
  if(existing){
    if(existing.connection_id!==connection.id||existing.node_id!==node.id||existing.account_id!==account.id)fail('idempotency_conflict',409);
    if(existing.closed||existing.hard_until<=now())fail('lease_closed',409);
    return existing;
  }
  let previousRow=null;
  if(previous)previousRow=await verifyReport(db,node,previous,connection.id);
  const time=now(),day=dayKey(time);
  const usage=await db.first('SELECT COALESCE((SELECT charged FROM nx3_usage WHERE account_id=? AND epoch=?),0) AS total,COALESCE((SELECT charged FROM nx3_daily WHERE account_id=? AND epoch=? AND day=?),0) AS daily',account.id,account.epoch,account.id,account.epoch,day);
  const refund=previousRow&&!previousRow.closed?previousRow.granted-previous.up-previous.down:0;
  const dailyRefund=previousRow?.day===day?refund:0;
  const amount=Math.min(wanted,account.total_bytes-usage.total+refund,account.daily_bytes-usage.daily+dailyRefund);
  if(amount<1)fail('quota_exceeded',403);
  const statements=[];
  if(previous)statements.push(reportStatement(node,previous,connection.id));
  statements.push(['INSERT INTO nx3_leases(id,connection_id,account_id,node_id,epoch,day,granted,issued_at,hard_until) VALUES(?,?,?,?,?,?,?,?,?)',leaseId,connection.id,account.id,node.id,account.epoch,day,amount,time,Math.min(connection.hard_until,account.expires_at,dayEnd(time))]);
  // Triggers re-check CURRENT entitlements and counters inside the same D1
  // transaction, not the optimistic reads above. No timeout/retry around writes.
  try{await db.batch(statements);}catch(error){
    if(db.queries<44){
      const duplicate=await db.first('SELECT * FROM nx3_leases WHERE id=? AND connection_id=? AND node_id=?',leaseId,connection.id,node.id);
      if(duplicate&&!duplicate.closed)return duplicate;
    }
    throw error;
  }
  return {id:leaseId,granted:amount,up:0,down:0,closed:0,hard_until:Math.min(connection.hard_until,account.expires_at,dayEnd(time))};
}
async function controlApi(db,env,request,action) {
  if(request.method!=='POST')fail('method_not_allowed',405);
  const node=await nodeAuth(db,env,request),body=await bodyJson(request,4096),time=now();
  await requireSchema(db);
  if(action==='ping'){
    keys(body,['challenge']);
    if(body.challenge!==undefined){nonce(body.challenge);const observed=await db.run('UPDATE nx3_probes SET seen_at=? WHERE id=? AND node_id=? AND created_at>=?',time,body.challenge,node.id,time-15000);if(!changes(observed))fail('probe_not_requested',403);}
    return json({protocol:PROTOCOL,version:VERSION,node_id:node.id,manager_origin:await managerOrigin(db),server_time:time});
  }
  if(action==='open'){
    keys(body,['connection_id','lease_id','identity','protocol']);nonce(body.connection_id);nonce(body.lease_id);
    if(!['vless','trojan'].includes(body.protocol))fail('unsupported_protocol');
    if(body.protocol==='vless')uuid(body.identity);else if(typeof body.identity!=='string'||!/^[a-f0-9]{56}$/.test(body.identity))fail('invalid_identity');
    const found=await db.first(body.protocol==='vless'?'SELECT id FROM nx3_accounts WHERE uuid=?':'SELECT id FROM nx3_accounts WHERE trojan_hash=?',body.identity);
    if(!found)fail('account_unavailable',403);
    const account=await allowedAccount(db,node,found.id,body.protocol,time);
    let connection=await db.first('SELECT * FROM nx3_connections WHERE id=?',body.connection_id);
    if(connection){
      if(connection.node_id!==node.id||connection.account_id!==account.id||connection.protocol!==body.protocol)fail('idempotency_conflict',409);
      if(connection.closed||connection.epoch!==account.epoch||connection.auth_version!==account.auth_version||connection.active_until<=time||connection.hard_until<=time)fail('connection_expired',403);
    }else{
      const available=await db.first('SELECT COALESCE((SELECT charged FROM nx3_usage WHERE account_id=? AND epoch=?),0) AS total,COALESCE((SELECT charged FROM nx3_daily WHERE account_id=? AND epoch=? AND day=?),0) AS daily',account.id,account.epoch,account.id,account.epoch,dayKey(time));
      if(available.total>=account.total_bytes||available.daily>=account.daily_bytes)fail('quota_exceeded',403);
      const hard=Math.min(time+CONNECTION_MS,account.expires_at,dayEnd(time));
      connection={id:body.connection_id,account_id:account.id,node_id:node.id,epoch:account.epoch,auth_version:account.auth_version,protocol:body.protocol,created_at:time,hard_until:hard,active_until:Math.min(time+PERMIT_MS,hard),closed:0};
      try{await db.run('INSERT INTO nx3_connections(id,account_id,node_id,epoch,auth_version,protocol,created_at,hard_until,active_until) VALUES(?,?,?,?,?,?,?,?,?)',connection.id,account.id,node.id,account.epoch,account.auth_version,body.protocol,time,hard,connection.active_until);}
      catch(error){
        const duplicate=await db.first('SELECT * FROM nx3_connections WHERE id=?',body.connection_id);
        if(!duplicate||duplicate.account_id!==account.id||duplicate.node_id!==node.id||duplicate.epoch!==account.epoch||duplicate.auth_version!==account.auth_version||duplicate.protocol!==body.protocol||duplicate.closed||duplicate.active_until<=now())throw error;
        connection=duplicate;
      }
    }
    const lease=await grant(db,node,connection,account,body.lease_id,FIRST_GRANT);
    return json(connectionReply(connection,account,node,lease));
  }
  if(action==='close'){
    keys(body,['connection_id','report']);nonce(body.connection_id);
    const connection=await db.first('SELECT * FROM nx3_connections WHERE id=? AND node_id=?',body.connection_id,node.id);
    if(!connection)fail('connection_not_found',404);
    const statements=[];
    if(body.report){await verifyReport(db,node,body.report,connection.id);statements.push(reportStatement(node,body.report,connection.id));}
    statements.push(['UPDATE nx3_connections SET closed=1,active_until=MIN(active_until,?) WHERE id=? AND node_id=?',time,connection.id,node.id]);
    await db.batch(statements);return json({success:true,protocol:PROTOCOL});
  }
  if(!['check','grant'].includes(action))fail('not_found',404);
  keys(body,action==='check'?['connection_id']:['connection_id','lease_id','wanted','previous']);nonce(body.connection_id);
  const connection=await db.first('SELECT * FROM nx3_connections WHERE id=? AND node_id=?',body.connection_id,node.id);
  if(!connection||connection.closed||connection.active_until<=time||connection.hard_until<=time)fail('connection_expired',403);
  const account=await allowedAccount(db,node,connection.account_id,connection.protocol,time);
  if(connection.epoch!==account.epoch||connection.auth_version!==account.auth_version)fail('connection_expired',403);
  const until=Math.min(time+PERMIT_MS,connection.hard_until,account.expires_at,dayEnd(time));
  const update=await db.run("UPDATE nx3_connections SET active_until=? WHERE id=? AND closed=0 AND epoch=? AND active_until>? AND EXISTS(SELECT 1 FROM nx3_accounts a JOIN nx3_nodes n ON n.id=? WHERE a.id=? AND a.epoch=? AND a.auth_version=? AND a.status='active' AND a.expires_at>? AND n.enabled=1 AND (a.node_mode='all' OR EXISTS(SELECT 1 FROM nx3_members m WHERE m.account_id=a.id AND m.node_id=n.id)))",until,connection.id,account.epoch,time,node.id,account.id,account.epoch,account.auth_version,time);
  if(!changes(update))fail('account_unavailable',403);
  connection.active_until=until;
  const lease=action==='grant'?await grant(db,node,connection,account,body.lease_id,body.wanted,body.previous||null):null;
  return json(connectionReply(connection,account,node,lease));
}
