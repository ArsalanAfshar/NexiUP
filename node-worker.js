/*!
 * NexiUP Mesh 3.0.0 — node.
 * Copyright (c) 2026 NexiUP Contributors. MIT; see LICENSE.
 * Standalone ES module: paste this COMPLETE file. No runtime npm dependency.
 * Generated from original mesh/ sources by scripts/build-mesh.mjs.
 * No Nahan or uploaded third-party tunnel/UI source is copied here.
 */

// Original NexiUP shared utilities. MIT. Included in each standalone delivery file.
const VERSION = '3.0.0';
const PROTOCOL = 'nexiup-mesh/1';
const DAY = 86400000;
const GIB = 1073741824;
const PERMIT_MS = 30000;
const CONNECTION_MS = 240000;
const MAX_GRANT = 4 * 1024 * 1024;
const FIRST_GRANT = 64 * 1024;
const MAX_NODES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();
const trustedFaults = new WeakSet();
class Fault extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; trustedFaults.add(this); }
}
function fail(code, status = 400) { throw new Fault(code, status); }
const now = () => Date.now();
const copy = value => JSON.parse(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = (text, fallback = null) => { try { return JSON.parse(text); } catch { return fallback; } };
const randomId = (bytes = 16) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n => n.toString(16).padStart(2, '0')).join('');
const noStore = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-NexiUP-Version':VERSION};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers:{...noStore,'Content-Type':'application/json; charset=utf-8',...headers}});
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const changes = value => Number(value?.meta?.changes || 0);
function strongSecret(value) { return typeof value === 'string' && value.length >= 32 && value.length <= 256; }
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 1024 || b.length > 1024) return false;
  const x=enc.encode(a), y=enc.encode(b); let diff=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++) diff|=(x[i]||0)^(y[i]||0);
  return diff===0;
}
function number(value, min, max, integer = false) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isSafeInteger(value))) fail('invalid_number');
  return value;
}
function string(value, max = 200, min = 0) {
  if(typeof value!=='string'||value.length<min||enc.encode(value).length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('invalid_text');
  return value;
}
function bool(value) { if(typeof value!=='boolean') fail('invalid_boolean'); return value; }
function ident(value, max = 48) {
  if(typeof value!=='string'||!new RegExp('^[A-Za-z0-9_-]{1,'+max+'}$').test(value)) fail('invalid_identifier');
  return value;
}
function keys(value, allowed) { if(!isObject(value)||Object.keys(value).some(key=>!allowed.includes(key))) fail('unknown_field'); }
function uuid(value) { if(typeof value!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) fail('invalid_uuid'); return value; }
function nonce(value) { if(typeof value!=='string'||!/^[a-f0-9]{32,64}$/.test(value)) fail('invalid_nonce'); return value; }
function secretRef(value) { if(typeof value!=='string'||!/^NODE_KEY_[A-Z0-9_]{1,40}$/.test(value)) fail('invalid_secret_reference'); return value; }
function publicHost(value) {
  string(value,253,1);const host=value.toLowerCase().replace(/^\[|\]$/g,'');
  if(host==='localhost'||/\.(?:localhost|local|internal|lan)$/.test(host)||host.includes('%')) fail('private_host');
  if(host.includes(':')) {
    if(!/^[a-f0-9:]+$/.test(host)||/^(?:::|0|fc|fd|fe8|fe9|fea|feb|ff)/.test(host)) fail('private_host');
    try{new URL('https://['+host+']');}catch{fail('invalid_host');}
  } else if(/^[0-9.]+$/.test(host)) {
    const p=host.split('.').map(Number);
    if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255)||[0,10,127].includes(p[0])||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)) fail('private_host');
  } else if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) fail('invalid_host');
  return host;
}
function httpsOrigin(value) {
  string(value,240,1);let url;try{url=new URL(value);}catch{fail('invalid_origin');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.port&&url.port!=='443')) fail('invalid_origin');
  publicHost(url.hostname);return url.origin;
}
function httpsUrl(value) {
  let url;try{url=new URL(value);}catch{fail('invalid_url');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash) fail('invalid_url');publicHost(url.hostname);return url.href;
}
const hostPort = host => host.includes(':')&&!host.startsWith('[')?'['+host+']':host;
function sameOrigin(request) {
  const url=new URL(request.url), origin=request.headers.get('origin');
  if(url.protocol!=='https:') fail('https_required');
  if((origin&&origin!==url.origin)||request.headers.get('sec-fetch-site')==='cross-site') fail('origin_forbidden',403);
}
async function boundedBody(input, max = 65536) {
  if(Number(input.headers.get('content-length'))>max) fail('body_too_large',413);
  if(!input.body)return new Uint8Array();
  const reader=input.body.getReader(),chunks=[];let length=0;
  try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>max){await reader.cancel();fail('body_too_large',413);}chunks.push(item.value);}}
  finally{reader.releaseLock();}
  return concat(...chunks);
}
async function bodyJson(request, max = 65536) {
  const bytes=await deadline(boundedBody(request,max),8000,'body_timeout');let value;
  try{value=JSON.parse(dec.decode(bytes));}catch{fail('invalid_json');}
  if(!isObject(value)) fail('invalid_json');return value;
}
async function deadline(operation, ms = 8000, code = 'read_timeout') {
  let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Fault(code,503)),ms);})]);}
  finally{clearTimeout(timer);}
}
async function fetchJson(url, init = {}, ms = 8000) {
  const controller=new AbortController();
  try {
    return await deadline((async()=>{
      const response=await fetch(url,{...init,redirect:'manual',signal:controller.signal});
      if(response.status>=300&&response.status<400){await response.body?.cancel();fail('redirect_forbidden',502);}
      const data=parse(dec.decode(await boundedBody(response,65536)));
      if(!isObject(data))fail('invalid_remote_response',502);
      return {response,data};
    })(),ms,'upstream_timeout');
  } finally {controller.abort();}
}
async function digest(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text))),n=>n.toString(16).padStart(2,'0')).join(''); }
async function hmac(secret, text) {
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(text))),n=>n.toString(16).padStart(2,'0')).join('');
}
function dayKey(time = now()) { return new Date(time).toISOString().slice(0,10); }
function dayEnd(time = now()) { return (Math.floor(time/DAY)+1)*DAY; }
function safeField(value,key) { try{return value?.[key];}catch{return undefined;} }
function errorText(error) {
  let text='';for(let i=0;i<3&&error!=null;i++){const msg=safeField(error,'message');if(typeof msg==='string')text+=' '+msg.slice(0,1500);error=safeField(error,'cause');}return text;
}
function failure(error, env, component) {
  let requestId='unavailable';try{requestId=randomId(12);}catch{}
  try{
    const fault=trustedFaults.has(error), code=fault?error.code:'internal_error', status=fault?error.status:500;
    if(env?.NEXIUP_DIAGNOSTICS==='true'&&status>=500){
      try{const stack=safeField(error,'stack'),position=typeof stack==='string'?stack.match(/^\s+at [^\n]*(?:manager-worker|node-worker)\.js:(\d{1,7}):(\d{1,7})/m):null;
        console.error(JSON.stringify({event:'nexiup_mesh_error',component,version:VERSION,code,request_id:requestId,...(position?{line:Number(position[1]),column:Number(position[2])}:{})}));}catch{}
    }
    return json({error:code,component,version:VERSION,request_id:requestId},status,{'X-NexiUP-Request-ID':requestId});
  }catch{return new Response('{"error":"internal_error"}',{status:500,headers:{...noStore,'Content-Type':'application/json'}});}
}
function bootstrap(component, body) {
  return new Response('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NexiUP '+component+'</title><style>body{font:16px/1.9 system-ui;background:#f4f6fa;color:#182330;max-width:780px;margin:7vh auto;padding:24px}main{background:#fff;border:1px solid #dce3ec;border-radius:20px;padding:30px}code,pre{direction:ltr;display:inline-block;background:#eef3f8;padding:2px 6px;border-radius:5px}a{color:#08766b}h1{margin:0}</style><main><small>NexiUP '+VERSION+'</small><h1>'+html(component)+'</h1>'+body+'</main></html>',{headers:{...noStore,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"}});
}

function concat(...chunks) { const out = new Uint8Array(chunks.reduce((n,c) => n+c.length,0)); let i=0; for (const c of chunks) { out.set(c,i);i+=c.length; } return out; }

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
