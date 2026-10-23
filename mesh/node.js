// API-only node: no D1/KV, no copied panel and no account database or master key.
let activeSockets = 0;
function nodeConfig(env) {
  const id=ident(env.NODE_ID||'');if(!strongSecret(env.NODE_KEY))fail('node_key_required_min_32',503);
  return {id,key:env.NODE_KEY,manager:httpsOrigin(env.MANAGER_URL||'')};
}
async function nodeRpc(config, action, body, budget) {
  if(++budget.calls>36&&action!=='close')fail('control_budget',503);
  const sent=performance.now();
  let remote;
  try{remote=await fetchJson(config.manager+'/mesh/v1/'+action,{method:'POST',headers:{Authorization:'Bearer '+config.key,'X-NexiUP-Node':config.id,'Content-Type':'application/json'},body:JSON.stringify(body)});}
  catch{fail('manager_unavailable',503);}
  if(!remote.response.ok){
    const safe=['account_unavailable','quota_exceeded','connection_limit','connection_expired','unauthorized','lease_closed','lease_not_closed','idempotency_conflict','invalid_report'];
    fail(safe.includes(remote.data.error)?remote.data.error:'manager_unavailable',remote.response.status===429?429:403);
  }
  if(remote.data.protocol!==PROTOCOL)fail('incompatible_manager',503);
  return {data:remote.data,elapsed:performance.now()-sent};
}
// One meter belongs to ONE socket. Its IDs are generated here, never accepted from
// a client. The serialized meter protects simultaneous upload/download reservations.
class NodeMeter {
  constructor(config, protocol, identity) {
    this.config=config;this.protocol=protocol;this.identity=identity;this.connectionId=randomId();this.firstLeaseId=randomId();
    this.budget={calls:0};this.tail=Promise.resolve();this.stopped=false;this.lease=null;this.opened=false;
    this.permit=0;this.hard=performance.now()+CONNECTION_MS;this.fallbacks=[];
  }
  async serial(fn) {
    const prior=this.tail;let release=()=>{};this.tail=new Promise(resolve=>{release=()=>resolve(undefined);});
    await prior;try{return await fn();}finally{release();}
  }
  apply(reply) {
    const data=reply.data;
    if(data.connection_id!==this.connectionId||typeof data.account_id!=='string')fail('invalid_manager_response',503);
    number(data.server_time,1,Number.MAX_SAFE_INTEGER,true);number(data.permit_until,1,Number.MAX_SAFE_INTEGER,true);number(data.hard_until,1,Number.MAX_SAFE_INTEGER,true);
    // Subtract the WHOLE round trip, so clock skew/latency cannot lengthen a permit.
    const at=performance.now();this.permit=at+Math.max(0,Math.min(PERMIT_MS,data.permit_until-data.server_time)-reply.elapsed-25);
    this.hard=Math.min(this.hard,at+Math.max(0,data.hard_until-data.server_time-reply.elapsed-25));
    if(data.lease){
      const lease=data.lease;nonce(lease.id);number(lease.granted,1,MAX_GRANT,true);
      if(lease.closed||lease.up!==0||lease.down!==0)fail('lease_not_fresh',409);
      this.lease={id:lease.id,granted:lease.granted,up:0,down:0};
    }
    if(Array.isArray(data.fallbacks)&&data.fallbacks.length<=4)this.fallbacks=data.fallbacks.map(item=>({host:publicHost(item.host),port:number(item.port,1,65535,true)}));
  }
  alive() { if(this.stopped||performance.now()>=this.permit||performance.now()>=this.hard)fail('connection_expired',403); }
  async open() {
    return this.serial(async()=>{
      if(this.stopped)fail('connection_expired',403);
      const reply=await nodeRpc(this.config,'open',{connection_id:this.connectionId,lease_id:this.firstLeaseId,identity:this.identity,protocol:this.protocol},this.budget);
      this.apply(reply);this.opened=true;this.alive();
    });
  }
  async pulse() {
    return this.serial(async()=>{this.alive();this.apply(await nodeRpc(this.config,'check',{connection_id:this.connectionId},this.budget));this.alive();});
  }
  async take(wanted,direction) {
    number(wanted,1,16384,true);if(!['up','down'].includes(direction))fail('invalid_direction');
    return this.serial(async()=>{
      this.alive();
      if(!this.lease||this.lease.up+this.lease.down>=this.lease.granted){
        const previous=this.lease?{lease_id:this.lease.id,up:this.lease.up,down:this.lease.down}:null;
        const leaseId=randomId();
        const reply=await nodeRpc(this.config,'grant',{connection_id:this.connectionId,lease_id:leaseId,wanted:MAX_GRANT,previous},this.budget);
        this.apply(reply);this.alive();
      }
      const size=Math.min(wanted,this.lease.granted-this.lease.up-this.lease.down);
      if(size<1)fail('quota_exceeded',403);
      this.lease[direction]+=size;return size;
    });
  }
  async finish() {
    this.stopped=true;
    return this.serial(async()=>{
      // Even an ambiguous open may have reserved a slot/credit. Close that ID;
      // unknown credits are NOT refunded on a guess and remain conservatively charged.
      const report=this.lease?{lease_id:this.lease.id,up:this.lease.up,down:this.lease.down}:null;
      try{await nodeRpc(this.config,'close',{connection_id:this.connectionId,report},this.budget);}catch{}
    });
  }
}
async function publicConnect(address) {
  // Documented socket API, loaded only AFTER authenticated admission. Neither the
  // manager nor this node's boot/login/health path imports a TCP module at startup.
  const sockets=await import('cloudflare:sockets');
  return sockets.connect(address);
}
function closeTcp(socket) { try{socket?.close()?.catch?.(()=>{});}catch{} }
async function nodeTunnel(request,env,context,config) {
  if(activeSockets>=32)fail('isolate_busy',503);
  let early=null;const encoded=request.headers.get('sec-websocket-protocol');
  if(encoded){if(encoded.length>10924||!/^[A-Za-z0-9_+/=-]+$/.test(encoded))fail('invalid_early_data');try{const raw=atob(encoded.replaceAll('-','+').replaceAll('_','/'));early=Uint8Array.from(raw,c=>c.charCodeAt(0));if(early.length>8192)fail('invalid_early_data');}catch{fail('invalid_early_data');}}
  const pair=new WebSocketPair(),client=pair[0],ws=pair[1];
  // Since 2026-03-17, standard binary frames default to Blob. This parser needs
  // ArrayBuffer; set it explicitly before accepting, on every compatibility date.
  ws.binaryType='arraybuffer';ws.accept();activeSockets++;
  let stopped=false,header=new Uint8Array(),meter=null,socket=null,writer=null,prefix=null,queue=Promise.resolve(),queued=0;
  let handshake,permitTimer,pulseTimer,lifeTimer;
  const tail=promise=>{if(context&&typeof context.waitUntil==='function')context.waitUntil(promise.catch(()=>{}));else promise.catch(()=>{});};
  function stop(code = 1000, reason = 'closed') {
    if(stopped)return;stopped=true;activeSockets=Math.max(0,activeSockets-1);
    clearTimeout(handshake);clearTimeout(permitTimer);clearInterval(pulseTimer);clearTimeout(lifeTimer);
    try{ws.close(code,reason);}catch{}closeTcp(socket);
    if(meter)tail(meter.finish());
  }
  function abort(error) {
    if(stopped)return;
    let code='tunnel_failed';try{if(trustedFaults.has(error))code=error.code;}catch{}
    try{if(env.NEXIUP_DIAGNOSTICS==='true')console.error(JSON.stringify({event:'nexiup_mesh_tunnel_error',version:VERSION,component:'node',code,request_id:randomId(12)}));}catch{}
    stop(1008,code);
  }
  function armPermit() {clearTimeout(permitTimer);if(!stopped&&meter)permitTimer=setTimeout(()=>abort(new Fault('permit_expired',403)),Math.max(1,Math.min(meter.permit,meter.hard)-performance.now()));}
  async function forward(bytes,direction) {
    for(let offset=0;offset<bytes.length;){
      if(stopped)return;
      const size=await meter.take(Math.min(16384,bytes.length-offset),direction);if(stopped)return;
      meter.alive();const chunk=bytes.subarray(offset,offset+size);offset+=size;
      if(direction==='up')await deadline(writer.write(chunk),5000,'socket_timeout');
      else{
        const buffered=safeField(ws,'bufferedAmount');if(typeof buffered==='number'&&buffered>1024*1024)fail('downlink_backpressure',503);
        const data=prefix?concat(prefix,chunk):chunk;prefix=null;ws.send(data);
      }
      armPermit();
    }
  }
  async function consume(bytes) {
    if(stopped)return;
    if(!meter){
      header=concat(header,bytes);const parsed=parseTunnelHeader(header);
      if(!parsed){if(header.length>8192)fail('handshake_too_large');return;}
      if(parsed.udp)fail('udp_not_supported');if(!parsed.port||parsed.port===25)fail('destination_port_denied');
      const identity=parsed.protocol==='vless'?parsed.identity.slice(0,8)+'-'+parsed.identity.slice(8,12)+'-'+parsed.identity.slice(12,16)+'-'+parsed.identity.slice(16,20)+'-'+parsed.identity.slice(20):parsed.identity;
      meter=new NodeMeter(config,parsed.protocol,identity);
      await meter.open();if(stopped)return;clearTimeout(handshake);armPermit();
      lifeTimer=setTimeout(()=>abort(new Fault('connection_lifetime',403)),Math.max(1,meter.hard-performance.now()));
      pulseTimer=setInterval(()=>{if(!stopped)tail(meter.pulse().then(armPermit).catch(abort));},20000);
      for(const address of [{host:parsed.host,port:parsed.port},...meter.fallbacks]){
        if(stopped)return;meter.alive();
        try{socket=await publicConnect({hostname:address.host,port:address.port});if(stopped){closeTcp(socket);return;}socket.closed?.catch(()=>{});await deadline(socket.opened,5000,'socket_timeout');break;}
        catch{closeTcp(socket);socket=null;}
      }
      if(stopped){closeTcp(socket);return;}if(!socket)fail('tcp_connect_failed',502);
      writer=socket.writable.getWriter();prefix=parsed.response;header=null;
      const read=async()=>{try{const reader=socket.readable.getReader();try{while(!stopped){const {value,done}=await reader.read();if(done)break;if(value?.length)await forward(value,'down');}}finally{reader.releaseLock();}}catch(error){abort(error);}finally{stop();}};
      tail(read());if(parsed.payload.length)await forward(parsed.payload,'up');
    }else await forward(bytes,'up');
  }
  function incoming(event) {
    if(stopped)return;
    if(typeof event.data==='string')return stop();
    let bytes;try{bytes=event.data instanceof Uint8Array?event.data:new Uint8Array(event.data);}catch{return stop();}
    if(bytes.length>262144||queued+bytes.length>1024*1024)return stop();
    queued+=bytes.length;queue=queue.then(()=>consume(bytes)).catch(abort).finally(()=>{queued-=bytes.length;});
  }
  ws.addEventListener('message',incoming);ws.addEventListener('close',()=>stop());ws.addEventListener('error',()=>abort(new Fault('websocket_error',502)));
  handshake=setTimeout(()=>abort(new Fault('handshake_timeout',408)),5000);if(early)incoming({data:early});
  return new Response(null,{status:101,webSocket:client});
}
export default {
  async fetch(request,env,context) {
    try{
      env=env??{};const url=new URL(request.url);
      if(url.pathname==='/health'){
        let configured=false;try{nodeConfig(env);configured=true;}catch{}
        return json({component:'node',version:VERSION,protocol:PROTOCOL,status:'alive',configured,database_required:false,tcp_tested:false});
      }
      if(url.pathname==='/'&&request.method==='GET')return bootstrap('NexiUP Node','<p>این Worker نود است؛ پنل مدیریت روی Worker مرکزی قرار دارد.</p><p>This is an API-only node. Set <code>NODE_ID</code>, secret <code>NODE_KEY</code>, and <code>MANAGER_URL</code>. No D1 or KV is needed.</p><p>آن را در پنل مرکزی ثبت، تست و سپس فعال کنید. / Register, test and enable it in the manager.</p><p><a href="/health">Health / وضعیت اجرای کد</a> — this does not prove TCP or ISP reachability.</p>');
      const config=nodeConfig(env);
      if(url.pathname==='/_mesh/health'&&request.method==='GET'){
        sameOrigin(request);if(!constantTimeEqual(request.headers.get('authorization')||'','Bearer '+config.key))fail('unauthorized',401);
        const challenge=string(request.headers.get('X-NexiUP-Challenge')||'',100),ping=await nodeRpc(config,'ping',challenge?{challenge}:{}, {calls:0});
        if(ping.data.node_id!==config.id||ping.data.manager_origin!==config.manager)fail('node_manager_mismatch',409);
        return json({component:'node',version:VERSION,protocol:PROTOCOL,node_id:config.id,manager_origin:config.manager,manager_reachable:true,challenge,colo:request.cf?.colo||null,tcp_tested:false});
      }
      if(url.pathname==='/connect'&&request.headers.get('upgrade')?.toLowerCase()==='websocket'){
        if(url.protocol!=='https:')fail('https_required');return await nodeTunnel(request,env,context,config);
      }
      fail('not_found',404);
    }catch(error){return failure(error,env,'node');}
  }
};
