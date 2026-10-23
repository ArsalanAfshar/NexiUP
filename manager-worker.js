/*!
 * NexiUP Mesh 3.0.0 — manager.
 * Copyright (c) 2026 NexiUP Contributors. MIT; see LICENSE.
 * Standalone ES module: paste this COMPLETE file. No runtime npm dependency.
 * Generated from original mesh/ sources by scripts/build-mesh.mjs.
 * No Nahan or uploaded third-party tunnel/UI source is copied here.
 * Embedded QR: Nayuki MIT. Embedded unmodified font: Vazirmatn OFL-1.1.
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

function base64Utf8(s) { let b = ''; for (const x of enc.encode(s)) b += String.fromCharCode(x); return btoa(b); }

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

function crc32(data) { let c = 0xffffffff; for (const b of data) { c ^= b; for (let k=0;k<8;k++) c = (c>>>1) ^ ((c&1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }

function u32(x) { return Uint8Array.of(x>>>24,(x>>>16)&255,(x>>>8)&255,x&255); }

function pngChunk(type, data) { const bytes = concat(enc.encode(type),data); return concat(u32(data.length),bytes,u32(crc32(bytes))); }

function qrMatrix(text) {
  string(text, 340, 1);
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

const FONT_CSS = "/* Copyright 2015 The Vazirmatn Project Authors (https://github.com/rastikerdar/vazirmatn)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttp://scripts.sil.org/OFL\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded,\nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.\n */\n@font-face{font-family:Vazirmatn;font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,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) format('woff2');}\n";
function managerPage() {
  const nonce=randomId();
  return new Response(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex,nofollow"><title>NexiUP · مدیریت شبکه</title><style nonce="${nonce}">${FONT_CSS}${MESH_STYLE}</style></head><body>
  <section id="login" class="login"><div class="login-story"><a class="brand" href="/"><b>N</b><span>Nexi<span class="accent">UP</span></span><small>MESH / 3</small></a><div><span class="eyebrow">ONE SUBSCRIPTION. YOUR WHOLE NETWORK.</span><h1 data-i="story">یک اشتراک،<br>تمام شبکهٔ شما.</h1><p data-i="storySub">یک مرکز کنترل مستقل؛ چند نود، یک هویت و یک سهمیهٔ مشترک.</p><div class="network-art" aria-hidden="true"><span class="hub">N</span><span class="sat a">01</span><span class="sat b">02</span><span class="sat c">03</span><span class="ring"></span></div></div><small>CLOUDFLARE WORKERS + D1 · NO NAHAN DEPENDENCY</small></div>
  <div class="login-body"><button data-act="language" class="lang">EN / فارسی</button><div><span class="eyebrow">PRIVATE CONTROL PLANE</span><h2 data-i="welcome">به مرکز کنترل خوش آمدید</h2><p class="muted" data-i="loginHelp">با OWNER_KEY وارد شوید. ورود نخست، ساختار جدید و مستقل دیتابیس را آماده می‌کند؛ دادهٔ نسخهٔ قبلی پاک نمی‌شود.</p><form id="login-form"><label data-i="ownerKey" for="owner-key">کلید مالک</label><input id="owner-key" type="password" autocomplete="off" minlength="32" maxlength="256" required spellcheck="false" dir="ltr" placeholder="OWNER_KEY"><button class="primary wide" id="login-button" data-i="signIn">ورود امن</button></form><button class="subtle wide" type="button" data-act="diagnostics" data-i="diagnostics">بررسی دیپلوی، بدون تغییر داده</button><p id="login-status" role="status"></p><pre id="diagnostic-report" hidden></pre><div class="safe-note" data-i="private">کلید فقط برای ورود استفاده می‌شود؛ کوکی HttpOnly، نشست ۳۰ دقیقه‌ای و حفاظت CSRF.</div><a href="/health" target="_blank" rel="noreferrer" data-i="health">بررسی نسخه و اجرای کد ↗</a></div><small class="muted">NexiUP ${VERSION} · MIT / Font OFL · Self-hosted</small></div></section>
  <div id="app" class="app" hidden><button id="backdrop" class="backdrop" data-act="menu" aria-label="Close navigation"></button><aside id="sidebar"><a class="brand" href="#overview"><b>N</b><span>Nexi<span class="accent">UP</span></span><small>3.0</small></a><div class="workspace"><span><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m12 3 9 9-9 9-9-9Z"/><path d="m12 7 5 5-5 5-5-5Z"/></svg></span><div><strong data-i="workspace">شبکهٔ شما</strong><small>MANAGER + API NODES</small></div><i></i></div><nav id="nav"></nav><div class="side-note"><strong data-i="shared">یک سهمیهٔ مشترک</strong><p data-i="sharedNote">افزودن نود، حجم اشتراک را چند برابر نمی‌کند.</p></div><button class="account" data-act="logout"><span class="avatar">M</span><span><strong data-i="owner">مدیر شبکه</strong><small data-i="signOut">خروج از نشست امن</small></span><span>↗</span></button></aside>
  <div class="main"><header class="top"><div><button class="menu-icon" data-act="menu" aria-label="Menu" aria-expanded="false" aria-controls="sidebar"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><span class="muted" data-i="control">مرکز کنترل</span> <span class="slash">/</span> <b id="crumb"></b></div><div><span class="secure"><i></i><span data-i="session">نشست امن</span></span><button class="lang" data-act="language" id="language-button">EN</button><span class="avatar">M</span></div></header><main><div class="heading"><div><span class="eyebrow" id="section-tag">NETWORK OVERVIEW</span><h1 id="title"></h1><p class="muted" id="subtitle"></p></div><div id="actions"></div></div><div id="content" aria-live="polite"></div><footer><span>NexiUP ${VERSION} · Independent control plane</span><span data-i="footer">تست API، تضمین اتصال شبکه یا ظرفیت Free نیست.</span></footer></main></div></div>
  <dialog id="modal"><div class="modal-head"><h2 id="modal-title"></h2><button data-act="close" aria-label="Close">×</button></div><div id="modal-body"></div></dialog><div id="toasts" aria-live="polite"></div><script nonce="${nonce}">${MESH_SCRIPT}</script></body></html>`,{headers:{...noStore,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,'X-Frame-Options':'DENY'}});
}
const MESH_STYLE = `
:root{--ink:#142338;--muted:#7b8797;--line:#e6ebf2;--paper:#f6f8fb;--teal:#087f72;--navy:#0d2533;--soft:#e8f5f0;--red:#b84545;--amber:#aa711c}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.75 Vazirmatn,system-ui,sans-serif}button,input,select,textarea{font:inherit}button,a{touch-action:manipulation}button{cursor:pointer;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);padding:9px 15px;font-weight:600;transition:background .15s}button:hover{background:#f0f5f7}button:disabled{opacity:.5;cursor:wait}a{color:var(--teal);text-decoration:none}a:hover{text-decoration:underline}input,select,textarea{width:100%;padding:10px 12px;border:1px solid #dce4eb;border-radius:8px;background:#fff;color:var(--ink);outline:none}input:focus,select:focus,textarea:focus{border-color:var(--teal);box-shadow:0 0 0 3px #087f7212}input[type=checkbox]{width:auto;accent-color:var(--teal)}label{display:block;font-size:12px;font-weight:600;margin:12px 0 5px}textarea{min-height:90px;resize:vertical}pre,code{font-family:ui-monospace,monospace;direction:ltr;text-align:left;overflow-wrap:anywhere}pre{white-space:pre-wrap;padding:15px;border:1px solid var(--line);border-radius:9px;background:#f5f8fb;max-height:420px;overflow:auto}h1,h2,h3,p{margin:0}h1{font-size:28px;font-weight:750;letter-spacing:-.7px}h2{font-size:21px}h3{font-size:16px}p{margin:8px 0}.muted,small{color:var(--muted)}small{font-size:11px}.accent{color:#34b69a}.eyebrow{font-family:system-ui,sans-serif;font-size:10px;letter-spacing:1.8px;font-weight:700;color:#7a929c}.brand{display:flex;align-items:center;gap:10px;direction:ltr;color:var(--ink);font:700 25px system-ui}.brand:hover{text-decoration:none}.brand>b{display:grid;place-items:center;background:var(--teal);color:#fff;border-radius:11px;width:38px;height:38px;font-size:25px}.brand>small{margin-inline-start:auto;font-size:9px;padding:3px 5px;border:1px solid var(--line);border-radius:5px}.primary{background:var(--teal);border-color:var(--teal);color:#fff}.primary:hover{background:#076c61}.subtle{background:#edf3f6;border-color:#edf3f6}.danger{color:var(--red);background:#fff3f2}.wide{width:100%;margin-top:14px}.lang{font-family:system-ui,sans-serif;font-size:11px;padding:7px 10px}.login{display:grid;grid-template-columns:1fr 1fr;min-height:100vh}.login-story{background:var(--navy);padding:48px 60px;display:flex;flex-direction:column;justify-content:space-between;color:white;overflow:hidden}.login-story .brand{color:white;max-width:280px}.login-story .brand small{border-color:#ffffff28;color:#95b9ba}.login-story h1{font-size:48px;line-height:1.45;margin-top:24px}.login-story p{font-size:16px;max-width:390px;color:#abc3c9}.login-story>small{color:#7d9ea7;font:10px system-ui;letter-spacing:1.3px}.network-art{height:240px;position:relative;max-width:380px;margin:20px auto}.hub,.sat{position:absolute;display:grid;place-items:center;font:600 20px system-ui;z-index:2}.hub{width:68px;height:68px;border-radius:20px;background:#0c8879;top:84px;left:calc(50% - 34px);box-shadow:0 0 0 12px #ffffff06}.sat{width:47px;height:47px;background:#1e3c49;color:#9ed8cd;border:1px solid #43626a;border-radius:14px;font-size:13px}.sat.a{left:10px;top:20px}.sat.b{right:8px;top:85px}.sat.c{left:75px;bottom:5px}.network-art:before,.network-art:after{content:'';position:absolute;width:130px;height:1px;background:#44706f;top:115px;left:30px;transform:rotate(35deg)}.network-art:after{left:auto;right:25px;transform:rotate(-5deg)}.ring{position:absolute;inset:27px 60px;border:1px dashed #ffffff16;border-radius:50%}.login-body{padding:35px 60px;display:flex;flex-direction:column;justify-content:space-between}.login-body>.lang{align-self:flex-end}.login-body>div{max-width:390px;width:100%;margin:20px auto}.login-body h2{margin-top:16px;font-size:28px}.login-body .muted{margin:10px 0 24px}#login-status{font-size:12px;color:var(--red);overflow-wrap:anywhere}.safe-note{font-size:12px;padding:14px;border:1px solid var(--line);border-radius:9px;margin:22px 0;color:var(--muted)}.app{display:grid;grid-template-columns:244px minmax(0,1fr);min-height:100vh}.app[hidden],.login[hidden]{display:none}aside{background:#fff;border-inline-end:1px solid var(--line);padding:28px 22px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}.workspace{display:flex;gap:10px;align-items:center;margin:30px 0 25px;padding:14px 0;border-block:1px solid var(--line)}.workspace>span{display:grid;place-items:center;font-size:23px;color:var(--teal);background:var(--soft);width:36px;height:36px;text-align:center;border-radius:8px}.workspace small,.account small{display:block;font-size:9px}.workspace i,.secure i{display:inline-block;width:6px;height:6px;background:#27a57e;border-radius:50%;margin-inline-start:auto}.workspace strong{font-size:12px}.nav-label{font-size:10px;letter-spacing:.5px;color:#9aa5b4;margin:8px 12px}.nav-item{border:0;display:flex;align-items:center;gap:12px;width:100%;text-align:start;margin:5px 0;color:#6f7c8e;font-weight:500;padding:11px 13px}.nav-item b{display:flex;align-items:center;justify-content:center;font:18px system-ui;opacity:.8;width:19px;text-align:center}.nav-item.active{background:var(--soft);color:var(--teal);font-weight:700}.nav-item.active:after{content:'';width:5px;height:5px;background:var(--teal);border-radius:50%;margin-inline-start:auto}.side-note{margin-top:auto;background:#f7faf9;padding:14px;border-radius:10px;font-size:11px;color:#667a7b}.side-note strong{color:var(--teal);font-size:12px}.side-note p{margin-bottom:0}.account{display:flex;align-items:center;gap:9px;border:0;border-top:1px solid var(--line);border-radius:0;text-align:start;padding:19px 0 0;margin-top:20px}.account>span:last-child{margin-inline-start:auto;color:var(--muted)}.avatar{display:grid;place-items:center;width:31px;height:31px;border-radius:50%;background:#eef2f8;color:#627387;font:600 11px system-ui}.main{min-width:0}.top{height:76px;border-bottom:1px solid var(--line);background:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 36px;font-size:12px}.top>div{display:flex;align-items:center;gap:12px}.slash{color:#cbd3dd}.secure{display:flex;align-items:center;gap:7px;color:#76827f;font-size:11px}.top .avatar{margin-inline-start:8px}main{max-width:1470px;margin:auto;padding:32px 36px 20px}.heading{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:26px}.heading h1{margin:7px 0 1px}.heading p{font-size:12px;margin:4px 0}.heading button{margin-inline-start:6px}.hero{background:var(--navy);color:#fff;border-radius:17px;padding:28px 32px;display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:167px;margin-bottom:25px;position:relative;overflow:hidden}.hero h2{font-size:24px;margin-top:9px}.hero p{color:#a1bac4;font-size:12px;max-width:590px}.hero .eyebrow{color:#80cbbf}.hero .diagram{font:700 40px system-ui;color:#9ce3cf;border:1px solid #6b9e9a;outline:15px solid #ffffff04;flex:0 0 85px;height:85px;display:grid;place-items:center;border-radius:24px;margin:0 23px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:24px}.metric,.card{background:white;border:1px solid var(--line);border-radius:13px}.metric{padding:20px}.metric small{display:block;font-size:11px}.metric .metric-top{display:flex;align-items:center;justify-content:space-between;color:#7b899a;font-size:11px}.metric .metric-top b{display:grid;place-items:center;font:16px system-ui;background:#f0f5f7;width:28px;height:28px;text-align:center;border-radius:7px;color:var(--teal)}.metric strong{display:block;font:600 28px/1.4 Vazirmatn,system-ui;margin:13px 0 4px;direction:ltr;text-align:start}.metric em{font-style:normal;font-size:10px;color:var(--teal)}.grid-two{display:grid;grid-template-columns:1.5fr 1fr;gap:20px}.card-head{display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:1px solid var(--line);gap:10px}.card-head h3{font-size:14px}.card-body{padding:22px}.chart{height:150px;width:100%;margin-top:16px}.chart-labels{display:flex;justify-content:space-between;font-size:9px;color:var(--muted);direction:ltr}.notice{border:1px solid #e3dfc8;background:#fffbef;border-radius:10px;padding:12px 16px;font-size:12px;margin-bottom:20px;color:#786233}.notice.info{background:#edf5f9;border-color:#dce9f1;color:#536e81}.node-mini{display:flex;align-items:center;gap:12px;margin-bottom:17px}.node-mini:last-child{margin-bottom:0}.flag{display:grid;place-items:center;width:37px;height:37px;border-radius:10px;border:1px solid var(--line);background:#f7f9fc;font:600 11px system-ui}.node-mini>div:nth-child(2){flex:1}.node-mini small{display:block;font-size:10px}.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:6px;background:#f0f3f7;color:#778292;font-size:10px;white-space:nowrap}.badge.good{color:#17876b;background:#eaf7f0}.badge.warn{color:#a97a28;background:#fff5df}.badge.bad{color:#b45858;background:#fff0ef}.badge:before{content:'';width:4px;height:4px;border-radius:50%;background:currentColor}.toolbar{display:flex;gap:10px;padding:16px 20px;border-bottom:1px solid var(--line);align-items:center}.toolbar form{display:flex;gap:8px;max-width:420px;width:100%}.toolbar input{background:#f8fafc}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}th{text-align:start;font-size:10px;color:#8b95a4;font-weight:500;background:#fafbfd}td,th{padding:14px 20px;border-bottom:1px solid #edf0f5}tbody tr:hover{background:#fbfcfe}td strong{font-weight:650}td small{display:block;font-size:10px}td button{font-size:11px;padding:5px 9px}td .progress{width:115px;margin-top:5px}.progress{height:5px;background:#eef2f6;border-radius:5px;overflow:hidden}progress.progress{appearance:none;width:100%;border:0}progress::-webkit-progress-bar{background:#eef2f6}progress::-webkit-progress-value{background:#2ca88b;border-radius:5px}progress::-moz-progress-bar{background:#2ca88b}.spaced{margin-top:20px}.progress span{display:block;height:100%;background:#2ca88b;border-radius:5px}.table-foot{display:flex;justify-content:space-between;align-items:center;padding:15px 20px;font-size:11px;color:var(--muted)}.empty{text-align:center;padding:60px 22px}.empty .empty-icon{font:40px system-ui;color:#b2c3cd;margin-bottom:18px}.empty h3{font-size:17px}.empty p{color:var(--muted);max-width:470px;margin:10px auto 20px;font-size:12px}.node-grid,.profile-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.node-card{padding:22px}.node-card .row{display:flex;align-items:center;justify-content:space-between;gap:8px}.node-card h3{margin-top:18px}.node-origin{font:11px system-ui;direction:ltr;overflow-wrap:anywhere;margin:6px 0 18px;color:var(--muted)}.node-card .facts{border-block:1px solid var(--line);padding:12px 0;margin:15px 0;font-size:11px}.facts div{display:flex;justify-content:space-between;padding:5px 0;gap:10px}.node-buttons{display:flex;gap:8px;flex-wrap:wrap}.node-buttons button{flex:1;font-size:11px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}.span-two{grid-column:1/-1}.form-hint{font-size:11px;color:var(--muted);margin:6px 0 14px}.checks{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:12px 0}.checks label{margin:0;padding:10px;background:#f5f8fa;border-radius:7px;display:flex;gap:8px;align-items:center}.form-buttons{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap}.detail-metrics{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}.detail-metrics>div{padding:13px;background:#f5f8fb;border-radius:9px;font-size:11px;color:var(--muted)}.detail-metrics strong{display:block;font-size:18px;color:var(--ink);direction:ltr}.link-box{display:flex;align-items:center;gap:9px;padding:14px;border:1px solid var(--line);border-radius:9px;margin-top:18px}.link-box input{font:11px monospace;min-width:0}.qr-wrap{text-align:center;margin:20px auto}.qr-wrap img{width:190px;height:190px;image-rendering:pixelated}.detail-actions{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0}.detail-actions button{font-size:11px}.steps{counter-reset:step}.step{border-bottom:1px solid var(--line);padding:20px 0;display:flex;gap:18px}.step:first-child{padding-top:0}.step:before{counter-increment:step;content:counter(step);flex:0 0 32px;height:32px;text-align:center;border-radius:9px;background:var(--soft);color:var(--teal);font-weight:700;line-height:32px}.step p{font-size:12px;color:var(--muted)}.step code{font-size:11px;background:#f1f4f8;border-radius:4px;padding:3px 6px}.step:last-child{border-bottom:0}footer{display:flex;justify-content:space-between;margin-top:30px;font-size:10px;color:#9aa4b1;gap:15px}.menu-icon{display:none}.backdrop{display:none}dialog{border:1px solid var(--line);border-radius:16px;padding:0;width:min(680px,calc(100vw - 28px));max-height:90vh;box-shadow:0 24px 100px #0a223533;color:var(--ink)}dialog::backdrop{background:#0b1b3055;backdrop-filter:blur(3px)}.modal-head{display:flex;align-items:center;justify-content:space-between;padding:19px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:white;z-index:2}.modal-head h2{font-size:18px}.modal-head button{border:0;font-size:22px;padding:0 5px;color:var(--muted)}#modal-body{padding:24px}#toasts{position:fixed;bottom:20px;inset-inline-end:20px;z-index:90;display:grid;gap:8px;max-width:min(450px,calc(100vw - 30px))}.toast{display:flex;gap:10px;align-items:center;background:#13352d;color:white;border-radius:10px;padding:13px 17px;box-shadow:0 5px 20px #0001;font-size:12px;overflow-wrap:anywhere}.toast-close{border:0;padding:0 3px;background:transparent;color:inherit;font:19px system-ui}.toast-close:hover{background:transparent}.toast.error{background:#7d3838}.loading{padding:80px;text-align:center;color:var(--muted)}.spinner{display:inline-block;width:17px;height:17px;border:2px solid #deebe6;border-top-color:var(--teal);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-inline-end:9px}@keyframes spin{to{transform:rotate(360deg)}}[dir=ltr] .login-story h1{letter-spacing:-2px;line-height:1.2}[dir=ltr] .brand{direction:ltr}.code-editor{direction:ltr;text-align:left;font:12px/1.8 ui-monospace,monospace;min-height:320px}
@media(max-width:1150px){.node-grid,.profile-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.app{grid-template-columns:220px minmax(0,1fr)}aside{padding:25px 16px}main{padding:25px}.top{padding:0 25px}.login-story,.login-body{padding:38px}.metrics{gap:11px}.metric{padding:16px}.metric strong{font-size:24px}}@media(max-width:900px){.grid-two{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.login-story h1{font-size:39px}.login-story,.login-body{padding:30px}.hero .diagram{display:none}.login-story .network-art{max-width:260px}.login-story>small{font-size:8px}}@media(max-width:740px){.login{display:block}.login-story{display:none}.login-body{min-height:100vh;padding:25px}.app{display:block}aside{position:fixed;inset-inline-start:0;top:0;width:240px;z-index:40;visibility:hidden;transform:translateX(110%);transition:transform .2s}html[dir=ltr] aside{transform:translateX(-110%)}body.menu-open aside{visibility:visible;transform:none}body.menu-open .backdrop{display:block;position:fixed;inset:0;background:#12243866;border:0;border-radius:0;z-index:35}.menu-icon{display:inline-block;padding:2px 5px;border:0;font-size:19px}.top{height:64px;padding:0 16px}.secure{display:none}.top>div{gap:7px}.top .avatar{display:none}main{padding:23px 16px}.heading{align-items:flex-start;flex-direction:column;margin-bottom:20px}.heading h1{font-size:25px}.heading #actions{align-self:stretch;display:flex;justify-content:flex-end}.hero{padding:23px;min-height:160px}.hero h2{font-size:21px}.metric strong{font-size:24px}.metric .metric-top{font-size:10px}.node-grid,.profile-grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.span-two{grid-column:auto}.checks{grid-template-columns:1fr}#modal-body{padding:18px}.modal-head{padding:17px 18px}footer{flex-direction:column;gap:5px}.toolbar{padding:14px}.chart{height:130px}.metric{padding:16px 13px}.link-box{flex-wrap:wrap}.link-box input{flex:1 1 100%}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`;
const MESH_SCRIPT = String.raw`
  (()=>{
    'use strict';
    const $=id=>document.getElementById(id),E=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const S={lang:'fa',session:null,view:'overview',overview:null,nodes:[],accounts:[],profiles:[],next:null,cursor:'',history:[],search:'',seq:0,busy:false,detail:null,nonce:'',action:null};
    const L={story:['یک اشتراک، تمام شبکهٔ شما.','One subscription. Your whole network.'],storySub:['یک مرکز کنترل مستقل؛ چند نود، یک هویت و یک سهمیهٔ مشترک.','An independent control plane. Multiple nodes, one identity, one shared allowance.'],welcome:['به مرکز کنترل خوش آمدید','Welcome to your control center'],loginHelp:['با OWNER_KEY وارد شوید. ورود نخست، ساختار جدید و مستقل دیتابیس را آماده می‌کند؛ دادهٔ نسخهٔ قبلی پاک نمی‌شود.','Sign in with OWNER_KEY. First login initializes the separate manager schema; legacy data is not deleted.'],ownerKey:['کلید مالک','Owner key'],signIn:['ورود امن','Sign in securely'],diagnostics:['بررسی دیپلوی، بدون تغییر داده','Check deployment — read only'],private:['کلید در مرورگر ذخیره نمی‌شود؛ کوکی HttpOnly، نشست ۳۰ دقیقه‌ای و حفاظت CSRF.','No credential storage. HttpOnly cookie, 30-minute session and CSRF protection.'],health:['بررسی نسخه و اجرای کد ↗','Check version and handler liveness ↗'],workspace:['شبکهٔ شما','Your network'],shared:['یک سهمیهٔ مشترک','One shared allowance'],sharedNote:['افزودن نود، حجم اشتراک را چند برابر نمی‌کند.','Adding nodes never multiplies the account allowance.'],owner:['مدیر شبکه','Network owner'],signOut:['خروج از نشست امن','Sign out securely'],control:['مرکز کنترل','Control center'],session:['نشست امن','Secure session'],footer:['تست API، تضمین اتصال شبکه یا ظرفیت Free نیست.','API reachability is not network or Free-capacity certification.'],overview:['نمای کلی','Overview'],accounts:['اشتراک‌ها','Subscriptions'],nodes:['نودهای شبکه','Network nodes'],profiles:['پروفایل اپراتورها','Operator profiles'],audit:['رویدادها','Audit log'],guide:['راهنمای اتصال','Connect your network'],settings:['تنظیمات','Settings'],overviewSub:['وضعیت اشتراک‌ها، نودها و سهمیهٔ مشترک را یک‌جا ببینید.','Your subscriptions, nodes and shared allowance in one place.'],accountsSub:['یک حساب بسازید؛ از همه یا چند نود انتخابی استفاده کنید.','Create one account across all active or selected nodes.'],nodesSub:['نود مستقل، بدون D1 و بدون نیاز به نهان.','Independent API nodes. No node D1 or Nahan required.'],profilesSub:['مقادیر مستقل، نسخه‌دار و قابل بازگردانی؛ بدون تغییر لینک اشتراک.','Versioned, isolated profiles with rollback on the same subscription URL.'],auditSub:['تغییرات مدیریتی؛ بدون کلیدها و بدنهٔ کانفیگ در رویدادها.','Administrative changes, without keys or configuration bodies in events.'],guideSub:['دو فایل مستقل؛ یک کنترل‌کننده و چند نود.','Two standalone files: one manager and multiple nodes.'],settingsSub:['دامنهٔ اصلی اشتراک و مرزهای اعتماد شبکه.','Canonical subscription origin and network trust boundaries.'],refresh:['تازه‌سازی','Refresh'],addAccount:['ساخت اشتراک','New subscription'],addNode:['افزودن نود','Add node'],save:['ذخیره تغییرات','Save changes'],cancel:['انصراف','Cancel'],edit:['ویرایش','Edit'],details:['جزئیات','Details'],test:['تست API','Test API'],enable:['فعال‌سازی','Enable'],disable:['غیرفعال','Disable'],active:['فعال','Active'],cooldown:['مکث ایمنی','Safety pause'],quota_reserved_or_exhausted:['سهمیه تخصیص‌یافته / تمام‌شده','Allowance reserved / exhausted'],paused:['متوقف','Paused'],revoked:['لغوشده','Revoked'],expired:['منقضی','Expired'],disabled:['غیرفعال','Disabled'],api_online:['API تست‌شده','API tested'],untested:['بررسی‌نشده','Untested'],loading:['در حال دریافت…','Loading…'],empty:['هنوز داده‌ای وجود ندارد','Nothing here yet'],emptySub:['شبکه را از راهنما راه‌اندازی کنید؛ هیچ نود یا اشتراک ساختگی از قبل فعال نیست.','Start with the connection guide. No fabricated nodes or subscriptions are pre-enabled.'],allNodes:['همهٔ نودهای فعال، فعلی و آینده','All active nodes, current and future'],selectedNodes:['فقط نودهای انتخابی','Selected nodes only'],name:['نام اشتراک','Subscription name'],notes:['یادداشت خصوصی','Private note'],total:['حجم کل (GiB)','Total allowance (GiB)'],daily:['حجم روزانه (GiB)','Daily allowance (GiB)'],days:['مدت اعتبار (روز)','Validity (days)'],expires:['انقضا','Expires'],connections:['سقف اتصال هم‌زمان، در کل شبکه','Network-wide concurrent connections'],protocol:['پروتکل','Protocol'],scope:['نودهای مجاز','Allowed nodes'],bytesNote:['یک GiB = ۱٬۰۷۳٬۷۴۱٬۸۲۴ بایت. سهمیهٔ روزانه در 00:00 UTC تازه می‌شود؛ صفر به معنی نامحدود نیست.','1 GiB = 1,073,741,824 bytes. Daily allowance resets at 00:00 UTC. Zero does not mean unlimited.'],reported:['گزارش‌شده','Reported'],charged:['مصرف + رزرو','Charged + reserved'],reserve:['رزرو / گزارش‌نشده','Reserved / unreported'],copy:['کپی لینک','Copy link'],copied:['لینک کپی شد','Link copied'],saved:['تغییرات ذخیره شد','Changes saved'],quotaHint:['رزرو قبل از ارسال انجام می‌شود. رزرو استفاده‌نشده با بسته‌شدن تأییدشده برمی‌گردد؛ قطع ناگهانی می‌تواند رزرو نامشخص باقی بگذارد.','Credits are reserved before forwarding. Confirmed closure refunds unused credit; an abrupt loss may leave an uncertain reservation.'],revocationHint:['توقف/لغو حداکثر تا ۳۰ ثانیه روی اتصال موجود اثر می‌کند؛ اتصال جدید فوراً رد می‌شود. Reset و تعویض هویت، مکث امن حدود ۳۲ ثانیه دارند.','Pause/revoke reaches existing connections within 30 seconds; new ones are denied immediately. Reset and identity rotation impose a safe ~32-second pause.'],renew:['تمدید','Renew'],reset:['بازنشانی مصرف','Reset usage'],pause:['توقف','Pause'],resume:['ادامه','Resume'],revoke:['لغو اشتراک','Revoke'],rotateToken:['تعویض لینک','Rotate link'],rotateIdentity:['تعویض UUID','Rotate UUID'],confirm:['تأیید عملیات','Confirm action'],back:['قبلی','Previous'],next:['بعدی','Next'],search:['جستجو در نام / یادداشت','Search name / note'],originMissing:['ابتدا دامنهٔ اصلی اشتراک را در تنظیمات ثبت کنید.','Set your canonical subscription origin in Settings first.'],owner_secret_required_min_32:['OWNER_KEY معتبر با طول ۳۲ تا ۲۵۶ نویسه تنظیم نشده است.','Set a valid 32–256-character OWNER_KEY secret.'],unauthorized:['کلید یا نشست معتبر نیست.','The key or session is not valid.'],d1_binding_missing:['binding نوع D1 با نام DB موجود نیست.','D1 binding DB is missing.'],d1_binding_invalid:['DB باید binding نوع D1 باشد، نه Variable متنی.','DB must be a D1 binding, not a text variable.'],d1_unavailable:['عملیات D1 ناموفق بود؛ شناسهٔ امن خطا را بررسی کنید.','A D1 operation failed. Check the safe error reference.'],d1_read_timeout:['مهلت خواندن D1 تمام شد.','D1 read deadline exceeded.'],node_secret_missing_or_owner_key:['راز مستقل نود را در متغیر ارجاع‌شده تنظیم کنید؛ کلید مالک مجاز نیست.','Set the separate referenced node secret; do not use the owner key.'],test_node_before_enabling:['ابتدا تست رفت‌وبرگشت API نود را اجرا کنید.','Run the bidirectional node API test first.'],enable_a_tested_node_first:['ابتدا حداقل یک نود تست‌شده را فعال کنید.','Enable at least one tested node first.'],version_conflict:['نسخه تغییر کرده؛ تازه‌سازی و دوباره بررسی کنید.','The record changed. Refresh and review it again.'],version_conflict_or_limit_below_committed:['نسخه تغییر کرده یا سقف جدید کمتر از مصرف/رزرو فعلی است.','The version changed or a new limit is below committed usage/reservations.'],conflict:['نام یا شناسه تکراری است؛ تازه‌سازی کنید.','Duplicate name or identifier. Refresh to inspect existing records.']};
    const t=k=>(L[k]||[k,k])[S.lang==='fa'?0:1],w=(fa,en)=>S.lang==='fa'?fa:en,n=value=>new Intl.NumberFormat(S.lang==='fa'?'fa-IR':'en',{maximumFractionDigits:2}).format(Number(value)||0),gb=value=>{const bytes=Number(value)||0;return bytes>=1073741824?n(bytes/1073741824)+' GiB':bytes>=1048576?n(bytes/1048576)+' MiB':bytes>=1024?n(bytes/1024)+' KiB':n(bytes)+' B';};
    const date=value=>value?new Intl.DateTimeFormat(S.lang==='fa'?'fa-IR':'en-GB',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';
    const fresh=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
    const button=(act,label,cls='',extra='')=>'<button type="button" data-act="'+act+'" class="'+cls+'" '+extra+'>'+label+'</button>';
    const badge=(value,good=false)=>'<span class="badge '+(good?'good':['paused','expired','revoked','disabled','cooldown','quota_reserved_or_exhausted'].includes(value)?'warn':'')+'">'+E(t(value))+'</span>';
    const bar=(used,total)=>'<progress class="progress" value="'+Math.max(0,Math.min(100,total?used/total*100:0))+'" max="100"></progress>';
    const I=name=>{const paths={overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',accounts:'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M2 21v-3a6 6 0 0 1 12 0v3 M16 4a4 4 0 0 1 0 7 M17 14a5 5 0 0 1 5 4v3',nodes:'M8 3h8v6H8z M2 16h7v5H2z M15 16h7v5h-7z M12 9v4M5 16v-3h14v3',profiles:'M4 3v6m0 5v7m8-18v12m0 4v2m8-18v3m0 5v10 M1 9h6v5H1z M9 15h6v4H9z M17 6h6v5h-6z',audit:'M20 12a8 8 0 1 1-3-6.2 M20 3v6h-6 M12 7v5l3 2',settings:'M4 7h16M4 17h16 M8 3v8m8 2v8',guide:'M4 4h6v16H4z M14 4h6v16h-6z M7 7v3m10-3v3',traffic:'M4 7h16m-4-4 4 4-4 4 M20 17H4m4-4-4 4 4 4',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 6v6l4 2'};return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(paths[name]||paths.overview)+'"/></svg>';};
    const navs=[['overview','◫'],['accounts','◉'],['nodes','◇'],['profiles','≋'],['audit','◷'],['settings','⚙'],['guide','↗']];
    function translate(){document.documentElement.lang=S.lang;document.documentElement.dir=S.lang==='fa'?'rtl':'ltr';document.querySelectorAll('[data-i]').forEach(el=>el.textContent=t(el.dataset.i));$('language-button').textContent=S.lang==='fa'?'EN':'فا';document.title='NexiUP · '+t('control');}
    function toast(message,bad=false){const node=document.createElement('div');node.className='toast'+(bad?' error':'');const text=document.createElement('span');text.textContent=message;const close=document.createElement('button');close.type='button';close.className='toast-close';close.textContent='×';close.setAttribute('aria-label','Dismiss');close.addEventListener('click',()=>node.remove());node.append(text,close);$('toasts').append(node);while($('toasts').children.length>3)$('toasts').firstElementChild.remove();setTimeout(()=>node.remove(),6000);}
    function errorText(error){return t(error.code||error.message||'error')+(error.reference?' · ID: '+error.reference:'');}
    async function api(path,method='GET',body,extra={}){const headers={Accept:'application/json',...extra};if(body!==undefined)headers['Content-Type']='application/json';if(S.session?.csrf)headers['X-NexiUP-CSRF']=S.session.csrf;const response=await fetch('/api/'+path,{method,headers,credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json().catch(()=>({error:'non_json_platform_response'}));if(!response.ok){const error=Object.assign(new Error(data.error||'request_failed'),{code:data.error,reference:/^[a-f0-9]{24}$/.test(data.request_id)?data.request_id:''});if(response.status===401&&S.session&&path!=='session')showLogin();throw error;}return data;}
    function showLogin(){S.session=null;S.seq++;$('app').hidden=true;$('login').hidden=false;$('owner-key').value='';$('content').innerHTML='';S.detail=null;S.nodes=[];S.accounts=[];S.profiles=[];S.overview=null;S.editAccount=null;S.editNode=null;closeModal();document.body.classList.remove('menu-open');}
    function openApp(session){S.session=session;$('owner-key').value='';$('login').hidden=true;$('app').hidden=false;go((location.hash||'#overview').slice(1));}
    function navigation(){$('nav').innerHTML='<div class="nav-label">WORKSPACE</div>'+navs.map(([id,icon])=>'<button data-act="navigate" data-view="'+id+'" class="nav-item '+(S.view===id?'active':'')+'"><b>'+I(id)+'</b>'+E(t(id))+'</button>').join('');$('crumb').textContent=t(S.view);$('title').textContent=t(S.view);$('subtitle').textContent=t(S.view+'Sub');$('section-tag').textContent=S.view==='overview'?'NETWORK OVERVIEW':'WORKSPACE / '+S.view.toUpperCase();$('actions').innerHTML=(S.view==='accounts'?button('new-account','＋ '+t('addAccount'),'primary'):S.view==='nodes'?button('new-node','＋ '+t('addNode'),'primary'):'')+button('refresh','↻ '+t('refresh'));}
    function go(view){if(!S.session)return;S.view=navs.some(([id])=>id===view)?view:'overview';S.cursor='';S.history=[];S.search='';history.replaceState(null,'','#'+S.view);document.body.classList.remove('menu-open');document.querySelector('.menu-icon').setAttribute('aria-expanded','false');load().catch(error=>toast(errorText(error),true));}
    function empty(action='guide'){return '<div class="card empty"><div class="empty-icon">◇</div><h3>'+t('empty')+'</h3><p>'+t('emptySub')+'</p>'+button(action,t(action==='guide'?'guide':action==='new-node'?'addNode':'addAccount'),'primary')+'</div>';}
    async function load(){if(!S.session)return;const seq=++S.seq;navigation();$('content').innerHTML='<div class="loading"><span class="spinner"></span>'+t('loading')+'</div>';let content='';
      if(S.view==='overview'){S.overview=await api('overview');S.nodes=S.overview.nodes;content=overviewView(S.overview);}
      else if(S.view==='nodes'){S.nodes=(await api('nodes')).items;content=nodesView();}
      else if(S.view==='accounts'){const d=await api('accounts?'+new URLSearchParams({after:S.cursor,q:S.search}));S.accounts=d.items;S.next=d.next;content=accountsView();}
      else if(S.view==='profiles'){S.profiles=(await api('profiles')).items;content=profilesView();}
      else if(S.view==='settings'){S.overview=await api('overview');content=settingsView();}
      else if(S.view==='audit'){const d=await api('audit'+(S.cursor?'?before='+encodeURIComponent(S.cursor):''));S.next=d.next;content=auditView(d.items);}
      else content=guideView();
      if(seq===S.seq&&S.session)$('content').innerHTML=content;
    }
    function metric(label,value,hint,icon){return '<article class="metric"><div class="metric-top"><span>'+label+'</span><b>'+I(({'◉':'accounts','◇':'nodes','↔':'traffic','◷':'clock'})[icon]||icon)+'</b></div><strong>'+value+'</strong><em>'+hint+'</em></article>';}
    function overviewView(d){const reported=d.usage.up+d.usage.down,points=d.days.map(x=>x.reported),max=Math.max(1,...points),coords=points.length?points.map((x,i)=>(points.length===1?300:15+i*570/(points.length-1))+','+(130-x/max*100)).join(' '):'15,130 585,130';return (!d.public_origin?'<div class="notice">'+t('originMissing')+' '+button('settings',t('settings'))+'</div>':'')+'<section class="hero"><div><span class="eyebrow">YOUR NETWORK, ONE CONTROL PLANE</span><h2>'+w('همهٔ مسیرها، یک مرکز کنترل.','Every route. One control center.')+'</h2><p>'+w('حساب را یک‌بار بسازید. نودهای مجاز، هویت و سهمیهٔ همان اشتراک را به‌صورت مرکزی بررسی می‌کنند.','Create an account once. Every allowed node checks the same identity and shared allowance centrally.')+'</p></div><div class="diagram">N</div></section><div class="metrics">'+metric(w('اشتراک فعال','Active subscriptions'),n(d.summary.active),n(d.summary.accounts)+' '+t('accounts'),'◉')+metric(w('نود فعال','Enabled nodes'),n(d.nodes.filter(x=>x.enabled).length),n(d.nodes.length)+' '+w('نود ثبت‌شده','registered nodes'),'◇')+metric(w('مصرف گزارش‌شده دوره','Reported current-period usage'),gb(reported),w('رفت + برگشت پذیرفته‌شده','Admitted upload + download'),'↔')+metric(t('reserve'),gb(Math.max(0,d.usage.charged-reported)),w('جدا از مصرف قطعی نمایش داده می‌شود','Shown separately from reported usage'),'◷')+'</div><div class="grid-two"><section class="card"><div class="card-head"><h3>'+w('روند مصرف گزارش‌شده','Reported usage trend')+'</h3><small>'+w('۷ روز · UTC','7 days · UTC')+'</small></div><div class="card-body"><strong>'+gb(d.days.reduce((sum,row)=>sum+row.reported,0))+'</strong><svg class="chart" viewBox="0 0 600 150" preserveAspectRatio="none" aria-label="Usage"><path d="M15 30H585 M15 80H585 M15 130H585" stroke="#edf1f5" fill="none"/><polyline points="'+coords+'" fill="none" stroke="#159d86" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="chart-labels">'+d.days.map(x=>'<span>'+E(x.day.slice(5))+'</span>').join('')+'</div></div></section><section class="card"><div class="card-head"><h3>'+t('nodes')+'</h3>'+button('nodes',w('مشاهده همه','View all'))+'</div><div class="card-body">'+(d.nodes.length?d.nodes.slice(0,4).map(node=>'<div class="node-mini"><span class="flag">'+E(node.country)+'</span><div><strong>'+E(node.label)+'</strong><small>'+E(node.id)+' · '+E(date(node.last_check))+'</small></div>'+badge(node.enabled?'active':'disabled',!!node.enabled)+'</div>').join(''):'<p class="muted">'+t('emptySub')+'</p>')+'</div></section></div><p class="form-hint">'+t('quotaHint')+'</p>';}
    function nodesView(){if(!S.nodes.length)return empty('new-node');return '<div class="notice info">'+w('تست، رفت‌وبرگشت API را می‌سنجد؛ کشور درج‌شده ادعای مدیر است، نه اثبات خروجی ترافیک.','The test verifies the API round trip. Country labels are operator claims, not exit-location proof.')+'</div><div class="node-grid">'+S.nodes.map(node=>'<article class="card node-card"><div class="row"><span class="flag">'+E(node.country)+'</span>'+badge(node.enabled?'active':'disabled',!!node.enabled)+'</div><h3>'+E(node.label)+'</h3><div class="node-origin">'+E(node.origin)+'</div><div class="facts"><div><span class="muted">ID</span><code>'+E(node.id)+'</code></div><div><span class="muted">'+w('آخرین بررسی','Last check')+'</span><span>'+E(date(node.last_check))+'</span></div><div><span class="muted">API</span>'+badge(node.last_status,node.last_status==='api_online')+'</div></div><div class="node-buttons">'+button('test-node',t('test'),'','data-id="'+E(node.id)+'"')+button('toggle-node',t(node.enabled?'disable':'enable'),node.enabled?'':'primary','data-id="'+E(node.id)+'"')+button('edit-node',t('edit'),'','data-id="'+E(node.id)+'"')+'</div></article>').join('')+'</div>';}
    function accountsView(){const rows=S.accounts.map(a=>{const state=a.status!=='active'?a.status:a.expires_at<=Date.now()?'expired':a.activate_after>Date.now()?'cooldown':a.charged>=a.total_bytes||a.daily_charged>=a.daily_bytes?'quota_reserved_or_exhausted':'active';return '<tr><td><strong>'+E(a.name)+'</strong><small>'+E(a.protocol.toUpperCase())+' · '+E(t(a.node_mode==='all'?'allNodes':'selectedNodes'))+'</small></td><td>'+badge(state,state==='active')+'</td><td>'+gb(a.charged)+' / '+gb(a.total_bytes)+bar(a.charged,a.total_bytes)+'<small>'+t('reported')+': '+gb(a.reported)+'</small></td><td>'+gb(a.daily_charged)+' / '+gb(a.daily_bytes)+'</td><td>'+E(date(a.expires_at))+'</td><td>'+button('account-detail',t('details'),'','data-id="'+E(a.id)+'"')+'</td></tr>';}).join('');return '<section class="card"><div class="toolbar"><form id="search-form"><input id="query" placeholder="'+E(t('search'))+'" value="'+E(S.search)+'"><button>⌕</button></form></div>'+(rows?'<div class="table-scroll"><table><thead><tr>'+[t('name'),w('وضعیت','Status'),t('charged'),w('روزانه · UTC','Daily · UTC'),t('expires'),''].map(v=>'<th>'+v+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="empty"><h3>'+t('empty')+'</h3><p>'+t('emptySub')+'</p>'+button('new-account',t('addAccount'),'primary')+'</div>')+pager(S.accounts.length)+'</section><p class="form-hint">'+t('quotaHint')+'</p>';}
    function pager(count){return '<div class="table-foot"><span>'+n(count)+' '+w('ردیف','records')+'</span><div>'+button('previous',t('back'),'',''+(S.history.length?'':'disabled'))+' '+button('next',t('next'),'',''+(S.next?'':'disabled'))+'</div></div>';}
    function profilesView(){return '<div class="notice info">'+w('JSON کامل Xray، Cipher Suites و ECH/Final Mask را حفظ می‌کند. سازگاری واقعی اپراتور/کلاینت باید تست شود.','Full Xray JSON retains cipher suites and ECH/final mask. Actual client and operator compatibility needs testing.')+'</div><div class="profile-grid">'+S.profiles.map(row=>'<article class="card node-card"><div class="row"><span class="flag">≋</span>'+badge(row.profile.enabled?'active':'disabled',row.profile.enabled)+'</div><h3>'+E(S.lang==='fa'?row.profile.label:row.profile.label_en)+'</h3><div class="facts"><div><span>Fingerprint</span><code>'+E(row.profile.fingerprint)+'</code></div><div><span>ECH</span><span>'+n(row.profile.ech.length)+'</span></div><div><span>'+w('نسخه','Revision')+'</span><span>'+n(row.version)+'</span></div></div><div class="node-buttons">'+button('edit-profile',t('edit'),'primary','data-id="'+E(row.profile.id)+'"')+button('rollback-profile',w('بازگردانی','Rollback'),'','data-id="'+E(row.profile.id)+'" '+(row.can_rollback?'':'disabled'))+'</div></article>').join('')+'</div>';}
    function auditView(rows){return '<section class="card"><div class="table-scroll"><table><thead><tr><th>'+w('زمان','Time')+'</th><th>'+w('عملیات','Action')+'</th><th>'+w('شناسه رکورد','Record ID')+'</th></tr></thead><tbody>'+rows.map(row=>'<tr><td>'+E(date(row.created_at))+'</td><td><code>'+E(row.action)+'</code></td><td><code>'+E(row.target)+'</code></td></tr>').join('')+'</tbody></table></div>'+pager(rows.length)+'</section>';}
    function settingsView(){return '<section class="card"><div class="card-head"><h3>'+w('دامنهٔ اصلی اشتراک','Canonical subscription origin')+'</h3></div><div class="card-body"><form id="settings-form"><label for="public-origin">HTTPS origin</label><input id="public-origin" dir="ltr" type="url" required value="'+E(S.overview.public_origin||location.origin)+'"><p class="form-hint">'+w('فقط origin، بدون مسیر یا query. تغییر دامنه، لینک‌های قدیمی را به‌خودی‌خود منتقل نمی‌کند.','Origin only, no path or query. Changing it does not redirect old subscription URLs.')+'</p><button class="primary">'+t('save')+'</button></form></div></section><div class="notice info spaced">'+t('revocationHint')+'</div><section class="card"><div class="card-body"><h3>'+w('مرز ظرفیت و اعتماد','Capacity and trust boundaries')+'</h3><p class="muted">'+w('نودها باید تحت کنترل شما باشند؛ نود مخرب می‌تواند حسابداری را دور بزند. سهمیه سختِ مشترک، رزرو D1 می‌خواهد و مصرف پلن Free باید در حساب واقعی سنجیده شود. نودها بدون مدیر، اعتبار جدید نمی‌گیرند.','Nodes must be trusted and operator-controlled. A malicious node can bypass metering. Shared quotas require central D1 reservations; Free feasibility must be measured. An unreachable manager cannot grant new credits.')+'</p><p class="muted">'+w('کد قبلی ربات در worker.js حفظ شده؛ حساب‌های Mesh و API این جفت جدید، مستقل از جریان مالی/بات قدیمی‌اند.','The legacy bot remains in worker.js. Mesh accounts and this new pair are separate from legacy bot/financial workflows.')+'</p></div></section>';}
    function guideView(){return '<section class="card"><div class="card-body steps">'+[
      [w('Worker مرکزی','Manager worker'),w('فایل manager-worker.js را Deploy کنید. فقط این Worker یک D1 با binding نام DB و یک Secret به نام OWNER_KEY می‌خواهد. ورود اول، جدول‌های nx3_ را می‌سازد.','Deploy manager-worker.js. Only this Worker needs D1 binding DB and secret OWNER_KEY. First login creates the nx3_ tables.')],
      [w('دامنهٔ اصلی','Canonical origin'),w('در تنظیمات همین پنل، آدرس HTTPS واقعی Worker مرکزی را ذخیره کنید. نقش ROLE یا نهان لازم نیست.','Save the real HTTPS manager origin in Settings. No ROLE switch or Nahan installation is required.')],
      [w('هر نود را جدا Deploy کنید','Deploy each node separately'),w('فایل node-worker.js؛ بدون D1/KV. NODE_ID را شناسه دلخواه، MANAGER_URL را دامنه مرکزی و NODE_KEY را یک Secret تصادفی مستقل ۳۲+ نویسه‌ای قرار دهید.','Use node-worker.js, without D1/KV. Set NODE_ID, MANAGER_URL and a unique random 32+ character NODE_KEY secret.')],
      [w('کلید دوطرفه و ثبت نود','Pair and register the node'),w('همان مقدار NODE_KEY را در Secret مرکزی با نامی مانند NODE_KEY_DE ذخیره کنید. در فرم نود فقط نام این Secret را وارد کنید، نه مقدار کلید. در هر دو Worker، compatibility flag به نام global_fetch_strictly_public فعال باشد.','Store that node key in a manager Secret named like NODE_KEY_DE. Enter only the reference name in the node form. Enable global_fetch_strictly_public on both Workers.')],
      [w('تست، فعال‌سازی، ساخت حساب','Test, enable, create'),w('نود را ذخیره، تست API را اجرا و سپس فعال کنید. اشتراک را روی همه نودهای فعال یا انتخابی بسازید. هر نود در اولین اتصال حساب، از مرکز مجوز می‌گیرد؛ ساخت دستی حساب روی نود لازم نیست.','Save, test the bidirectional API and enable the node. Create an account across all or selected nodes. Nodes authorize it on first connection; no manual per-node account creation is needed.')],
      [w('حجم واقعی و رزرو','Metering and reservations'),t('quotaHint')+' '+t('revocationHint')]
      ].map(([title,text])=>'<div class="step"><div><h3>'+title+'</h3><p>'+text+'</p></div></div>').join('')+'</div></section><div class="notice info spaced">'+w('پروتکل: VLESS/Trojan روی TLS WebSocket؛ TCP. UDP و XHTTP/gRPC در این جفت پیاده‌سازی نشده‌اند. اتصال واقعی ProxyIP/اینترنت ایران تأیید نشده؛ آدرس نمونه‌ای به‌صورت پیش‌فرض فعال نمی‌شود.','Supported: VLESS/Trojan over TLS WebSocket, TCP only. UDP and XHTTP/gRPC are not implemented in this pair. No live ProxyIP/ISP success is certified or sample endpoint enabled.')+'</div>';}
    function modal(title,content){$('modal-title').textContent=title;$('modal-body').innerHTML=content;if(!$('modal').open)$('modal').showModal();}
    function closeModal(){$('modal').close();$('modal-body').innerHTML='';S.action=null;}
    function field(id,label,type='text',value='',attrs=''){return '<div><label for="'+id+'">'+label+'</label><input id="'+id+'" type="'+type+'" value="'+E(value)+'" '+attrs+'></div>';}
    async function editNode(id=''){if(!S.nodes.length||!S.nodes[0].key_ref)S.nodes=(await api('nodes')).items;const node=S.nodes.find(x=>x.id===id)||{id:'',label:'',origin:'',key_ref:'',country:'ZZ',connect_host:'',fallbacks:'[]',enabled:0,version:0};S.editNode=node;const fallback=JSON.parse(node.fallbacks||'[]').map(x=>(x.host.includes(':')?'['+x.host+']':x.host)+':'+x.port).join('\n');modal(t(id?'edit':'addNode'),'<form id="node-form"><div class="form-grid">'+field('node-id','NODE_ID','text',node.id,'required pattern="(?:[A-Za-z0-9_]|-){1,48}" '+(id?'readonly':''))+field('node-label',w('نام نمایشی','Display name'),'text',node.label,'required maxlength="100"')+field('node-origin',w('آدرس HTTPS نود','Node HTTPS origin'),'url',node.origin,'required dir="ltr" placeholder="https://…"')+field('node-key-ref',w('نام Secret در Worker مرکزی','Secret name on the manager'),'text',node.key_ref,'required dir="ltr" pattern="NODE_KEY_[A-Z0-9_]+" placeholder="NODE_KEY_…"')+field('node-country',w('کد کشور ادعایی؛ ZZ نامشخص','Claimed country code; ZZ unknown'),'text',node.country,'required pattern="[A-Z]{2}" maxlength="2" dir="ltr"')+field('node-clean',w('Clean IP/host اختیاری، بدون پورت','Optional clean IP/host, no port'),'text',node.connect_host,'dir="ltr"')+'</div><label for="node-fallbacks">'+w('ProxyIPهای خودتان؛ حداکثر چهار host:port، هر خط یکی','Your own fallback endpoints; up to four host:port entries, one per line')+'</label><textarea id="node-fallbacks" dir="ltr">'+E(fallback)+'</textarea><p class="form-hint">'+w('مقدار کلید را اینجا ننویسید. نود جدید ابتدا غیرفعال است؛ تست API و فعال‌سازی جداگانه‌اند. fallback، تست‌شده فرض نمی‌شود.','Never paste the key value here. New nodes start disabled; test and enable them separately. Fallbacks are not assumed tested.')+'</p><div class="form-buttons">'+button('close',t('cancel'))+'<button class="primary">'+t('save')+'</button></div></form>');}
    async function editAccount(account=null){S.nodes=(await api('nodes')).items;S.editAccount=account;S.nonce=fresh();const a=account||{name:'',notes:'',total_bytes:20*1073741824,daily_bytes:1073741824,conn_limit:4,protocol:'vless',node_mode:'all',nodes:[]};modal(t(account?'edit':'addAccount'),'<form id="account-form"><div class="form-grid">'+field('account-name',t('name'),'text',a.name,'required maxlength="100"')+field('account-total',t('total'),'number',a.total_bytes/1073741824,'required min="0.000001" max="900000" step="any"')+field('account-daily',t('daily'),'number',a.daily_bytes/1073741824,'required min="0.000001" step="any"')+(account?field('account-expiry',t('expires'),'datetime-local',new Date(a.expires_at-new Date(a.expires_at).getTimezoneOffset()*60000).toISOString().slice(0,16),'required'):field('account-days',t('days'),'number',30,'required min="1" max="3650"'))+field('account-connections',t('connections'),'number',a.conn_limit,'required min="1" max="32"')+'<div><label for="account-protocol">'+t('protocol')+'</label><select id="account-protocol">'+['vless','trojan','both'].map(v=>'<option '+(a.protocol===v?'selected':'')+' value="'+v+'">'+v.toUpperCase()+'</option>').join('')+'</select></div><div class="span-two"><label for="account-mode">'+t('scope')+'</label><select id="account-mode"><option value="all" '+(a.node_mode==='all'?'selected':'')+'>'+t('allNodes')+'</option><option value="selected" '+(a.node_mode==='selected'?'selected':'')+'>'+t('selectedNodes')+'</option></select><div class="checks">'+S.nodes.filter(x=>x.enabled).map(node=>'<label><input type="checkbox" name="node" value="'+E(node.id)+'" '+(a.nodes.includes(node.id)?'checked':'')+'>'+E(node.label)+'</label>').join('')+'</div></div><div class="span-two"><label for="account-notes">'+t('notes')+'</label><textarea id="account-notes" maxlength="500">'+E(a.notes)+'</textarea></div></div><p class="form-hint">'+t('bytesNote')+'</p><div class="form-buttons">'+button('close',t('cancel'))+'<button class="primary">'+t('save')+'</button></div></form>');}
    async function detail(id){const a=(await api('accounts/'+id)).account;S.detail=a;modal(a.name,'<div class="row">'+badge(a.effective_status,a.effective_status==='active')+' <small>'+E(date(a.expires_at))+'</small></div><div class="detail-metrics"><div>'+t('charged')+'<strong>'+gb(a.charged)+' / '+gb(a.total_bytes)+'</strong>'+bar(a.charged,a.total_bytes)+'</div><div>'+w('روزانه · UTC','Daily · UTC')+'<strong>'+gb(a.daily_charged)+' / '+gb(a.daily_bytes)+'</strong>'+bar(a.daily_charged,a.daily_bytes)+'</div><div>'+t('reported')+'<strong>'+gb(a.up+a.down)+'</strong></div><div>'+t('reserve')+'<strong>'+gb(a.reserved_or_unreported)+'</strong></div></div><p class="form-hint">'+t('quotaHint')+'</p><div class="link-box"><input id="subscription-link" readonly dir="ltr" value="'+E(a.subscription_url)+'">'+button('copy',t('copy'))+'</div><div class="qr-wrap"><img alt="Subscription QR" src="'+E('/api/accounts/'+a.id+'/qr')+'"></div><p class="node-buttons">'+[['xray','Xray JSON'],['raw','VLESS / Trojan'],['base64','Base64']].map(([format,label])=>'<a download="nexiup-'+format+'.txt" href="'+E(new URL(a.subscription_url).pathname+'?format='+format)+'">'+label+'</a>').join(' · ')+'</p><div class="detail-actions">'+button('edit-current',t('edit'),' ',a.status==='revoked'?'disabled':'')+['renew',a.status==='paused'?'resume':'pause','reset','rotate-token','rotate-identity','revoke'].map(action=>button('account-action',t(({ 'rotate-token':'rotateToken','rotate-identity':'rotateIdentity' })[action]||action),action==='revoke'?'danger':'','data-action="'+action+'" '+(a.status==='revoked'?'disabled':''))).join('')+'</div><p class="form-hint">'+t('revocationHint')+'</p><h3>'+w('تفکیک نود، سهمیه مشترک','Per-node breakdown, shared allowance')+'</h3><div class="table-scroll"><table><thead><tr><th>NODE</th><th>'+t('reported')+'</th><th>'+t('reserve')+'</th><th>'+w('نامشخص پس از قطع','Uncertain after loss')+'</th></tr></thead><tbody>'+a.node_usage.map(row=>'<tr><td>'+E(row.node_id)+'</td><td>'+gb(row.up+row.down)+'</td><td>'+gb(row.outstanding)+'</td><td>'+gb(row.uncertain)+'</td></tr>').join('')+'</tbody></table></div>');}
    function actionModal(action){const a=S.detail;S.action={id:a.id,version:a.version,nonce:fresh(),action};modal(t(({ 'rotate-token':'rotateToken','rotate-identity':'rotateIdentity' })[action]||action),'<form id="action-form"><p>'+E(a.name)+'</p><p class="notice info">'+(action==='rotate-token'?w('تعویض لینک، کانفیگ دانلودشده و UUID را لغو نمی‌کند.','Rotating the link does not revoke a previously downloaded UUID/configuration.'):action==='reset'?w('مصرف دوره جدید صفر می‌شود. حساب حدود ۳۲ ثانیه مکث می‌کند؛ سابقه قبلی حذف نمی‌شود.','A new usage period starts at zero after a safe ~32-second pause. Historical records are retained.'):t('revocationHint'))+'</p>'+(action==='renew'?field('renew-days',t('days'),'number',30,'required min="1" max="3650"')+'<label><input type="checkbox" id="renew-reset"> '+w('مصرف را هم بازنشانی کن (پیش‌فرض خاموش)','Also reset usage (off by default)')+'</label>':'')+'<div class="form-buttons">'+button('close',t('cancel'))+'<button class="primary">'+t('confirm')+'</button></div></form>');}
    document.addEventListener('click',async event=>{const el=event.target.closest('[data-act]');if(!el)return;const action=el.dataset.act;if(action==='language'){S.lang=S.lang==='fa'?'en':'fa';translate();if(S.session)await load().catch(error=>toast(errorText(error),true));return;}if(action==='menu'){document.body.classList.toggle('menu-open');document.querySelector('.menu-icon').setAttribute('aria-expanded',String(document.body.classList.contains('menu-open')));return;}if(action==='close'){closeModal();return;}if(S.busy)return;
      S.busy=true;el.disabled=true;try{
        if(action==='navigate')go(el.dataset.view);else if(['guide','settings','nodes'].includes(action))go(action);else if(action==='refresh')await load();
        else if(action==='logout'){await api('logout','POST',{});showLogin();}
        else if(action==='diagnostics'){const response=await fetch('/api/diagnostics',{method:'POST',headers:{Authorization:'Bearer '+$('owner-key').value,'Content-Type':'application/json'},body:'{}'});const data=await response.json();$('diagnostic-report').hidden=false;$('diagnostic-report').textContent=JSON.stringify(data,null,2);$('owner-key').value='';}
        else if(action==='new-node'||action==='edit-node')await editNode(el.dataset.id||'');
        else if(action==='test-node'){const result=await api('nodes/'+el.dataset.id+'/test','POST',{});toast(result.ok?w('رفت‌وبرگشت API تأیید شد؛ اکنون می‌توانید نود را فعال کنید.','API round trip verified. You can now enable the node.'):t(result.error),!result.ok);await load();}
        else if(action==='toggle-node'){const node=S.nodes.find(x=>x.id===el.dataset.id);await api('nodes','POST',{id:node.id,label:node.label,origin:node.origin,key_ref:node.key_ref,country:node.country,connect_host:node.connect_host,fallbacks:JSON.parse(node.fallbacks).map(x=>(x.host.includes(':')?'['+x.host+']':x.host)+':'+x.port),enabled:!node.enabled,version:node.version});await load();}
        else if(action==='new-account')await editAccount();else if(action==='account-detail')await detail(el.dataset.id);else if(action==='edit-current')await editAccount(S.detail);else if(action==='account-action')actionModal(el.dataset.action);
        else if(action==='copy'){await navigator.clipboard.writeText($('subscription-link').value);toast(t('copied'));}
        else if(action==='next'){S.history.push(S.cursor);S.cursor=String(S.next);await load();}else if(action==='previous'){S.cursor=S.history.pop()||'';await load();}
        else if(action==='edit-profile'){const row=S.profiles.find(x=>x.profile.id===el.dataset.id);S.editProfile=row;modal(t('profiles'),'<form id="profile-form"><p class="form-hint">'+w('ویرایش یک پروفایل، پروفایل دیگر را تغییر نمی‌دهد. مقدار نامعتبر ذخیره نمی‌شود.','Each profile is isolated. Invalid values are not saved.')+'</p><textarea id="profile-json" class="code-editor" spellcheck="false">'+E(JSON.stringify(row.profile,null,2))+'</textarea><div class="form-buttons">'+button('close',t('cancel'))+'<button class="primary">'+t('save')+'</button></div></form>');}
        else if(action==='rollback-profile'){const row=S.profiles.find(x=>x.profile.id===el.dataset.id);await api('profiles/rollback','POST',{id:row.profile.id,version:row.version});toast(t('saved'));await load();}
      }catch(error){if(action==='diagnostics')$('login-status').textContent=errorText(error);else toast(errorText(error),true);}finally{S.busy=false;el.disabled=false;}
    });
    document.addEventListener('submit',async event=>{event.preventDefault();if(S.busy)return;S.busy=true;const submit=event.target.querySelector('button:not([type=button])');if(submit)submit.disabled=true;try{
      const form=event.target.id;
      if(form==='login-form'){let key=$('owner-key').value;try{const data=await api('login','POST',{}, {Authorization:'Bearer '+key});$('login-status').textContent='';openApp(data);}finally{key='';$('owner-key').value='';}}
      else if(form==='settings-form'){await api('settings','PUT',{public_origin:$('public-origin').value,version:S.overview.settings_version});toast(t('saved'));await load();}
      else if(form==='search-form'){S.search=$('query').value;S.cursor='';S.history=[];await load();}
      else if(form==='node-form'){const old=S.editNode;await api('nodes','POST',{id:$('node-id').value,label:$('node-label').value,origin:$('node-origin').value,key_ref:$('node-key-ref').value,country:$('node-country').value,connect_host:$('node-clean').value,fallbacks:$('node-fallbacks').value.split(/\n/).map(x=>x.trim()).filter(Boolean),enabled:!!old.enabled,version:old.version});closeModal();go('nodes');toast(t('saved'));}
      else if(form==='account-form'){const old=S.editAccount,body={name:$('account-name').value,notes:$('account-notes').value,total_bytes:Math.floor(Number($('account-total').value)*1073741824),daily_bytes:Math.floor(Number($('account-daily').value)*1073741824),conn_limit:Number($('account-connections').value),protocol:$('account-protocol').value,node_mode:$('account-mode').value,nodes:[...document.querySelectorAll('input[name=node]:checked')].map(x=>x.value),...(old?{expires_at:new Date($('account-expiry').value).getTime(),version:old.version}:{days:Number($('account-days').value),nonce:S.nonce})};const data=await api(old?'accounts/'+old.id:'accounts',old?'PUT':'POST',body);closeModal();go('accounts');await detail(data.account.id);toast(t('saved'));}
      else if(form==='action-form'){const action=S.action,body={...action,confirm:action.id};delete body.id;if(action.action==='renew'){body.days=Number($('renew-days').value);body.reset=$('renew-reset').checked;}await api('accounts/'+action.id+'/action','POST',body);closeModal();await load();await detail(action.id);toast(t('saved'));}
      else if(form==='profile-form'){const profile=JSON.parse($('profile-json').value);if(profile.id!==S.editProfile.profile.id)throw new Error('invalid_identifier');await api('profiles','PUT',{profile,version:S.editProfile.version});closeModal();await load();toast(t('saved'));}
    }catch(error){if(event.target.id==='login-form')$('login-status').textContent=errorText(error);else toast(errorText(error),true);}finally{S.busy=false;if(submit)submit.disabled=false;}});
    window.addEventListener('hashchange',()=>{if(S.session)go(location.hash.slice(1));});
    $('modal').addEventListener('cancel',()=>{S.action=null;});translate();api('session').then(openApp).catch(error=>{if(S.session)return;$('app').hidden=true;$('login').hidden=false;if(error.code!=='unauthorized')$('login-status').textContent=errorText(error);});
  })();
`;

async function subscriber(db,request,url,token) {
  if(!/^[a-f0-9]{64}$/.test(token))fail('not_found',404);
  const account=await db.first('SELECT a.*,COALESCE(u.charged,0) AS charged,COALESCE(u.up,0) AS up,COALESCE(u.down,0) AS down,COALESCE(d.charged,0) AS daily_charged FROM nx3_accounts a LEFT JOIN nx3_usage u ON u.account_id=a.id AND u.epoch=a.epoch LEFT JOIN nx3_daily d ON d.account_id=a.id AND d.epoch=a.epoch AND d.day=? WHERE a.token=?',dayKey(),token);
  if(!account)fail('not_found',404);
  if(account.status!=='active'||account.expires_at<=now())fail('subscription_inactive',403);
  const canonical=(await managerOrigin(db))+'/sub/'+token,format=url.searchParams.get('format');
  if(format==='qr')return new Response(qrPng(canonical),{headers:{...noStore,'Content-Type':'image/png'}});
  const nodes=await db.all("SELECT n.* FROM nx3_nodes n WHERE n.enabled=1 AND (?='all' OR EXISTS(SELECT 1 FROM nx3_members m WHERE m.account_id=? AND m.node_id=n.id)) ORDER BY n.id LIMIT 13",account.node_mode,account.id);
  if(nodes.length>MAX_NODES)fail('node_limit',503);
  if(!format&&(request.headers.get('accept')||'').includes('text/html')){
    const gb=bytes=>(bytes/GIB).toFixed(3),remaining=Math.max(0,account.total_bytes-account.charged),daily=Math.max(0,account.daily_bytes-account.daily_charged);
    return bootstrap('اشتراک / Subscription',`<h2>${html(account.name)}</h2>${account.activate_after>now()?'<p>مکث ایمنی پس از بازنشانی/تعویض هویت؛ تا / Safety pause until <code>'+html(new Date(account.activate_after).toISOString())+'</code></p>':''}<p>انقضا / Expiry: <code>${html(new Date(account.expires_at).toISOString())}</code></p><p>باقیمانده کل / Total remaining: <b>${gb(remaining)} GiB</b> · باقیمانده امروز UTC / Today remaining: <b>${gb(daily)} GiB</b></p><p>گزارش‌شده / Reported: ${gb(account.up+account.down)} GiB · رزرو یا گزارش‌نشده / Reserved or unreported: ${gb(Math.max(0,account.charged-account.up-account.down))} GiB.</p><p>یک سهمیه مشترک میان ${nodes.length} نود؛ نه سهمیه جدا برای هر نود. / One shared allowance across every node. Daily allowance resets at 00:00 UTC.</p><img alt="QR" width="240" src="${html(canonical+'?format=qr')}"><p><a href="${html(canonical)}">${html(canonical)}</a></p><p>${[['xray','Xray JSON'],['base64','Base64'],['raw','VLESS / Trojan'],['clash','Clash'],['sing-box','sing-box']].map(([key,label])=>`<a href="${html(canonical+'?format='+key)}">${html(label)}</a>`).join(' · ')}</p><p>برای حفظ تمام تنظیمات اپراتور، JSON کامل Xray توصیه می‌شود. قالب ناسازگار خطای 422 می‌دهد. این صفحه یا QR اثبات اتصال اینترنت ایران نیست. / Prefer full Xray JSON; incompatible formats fail explicitly. These links are bearer credentials; keep them private.</p>`);
  }
  if(!nodes.length)fail('no_enabled_nodes',503);
  const active=(await db.all('SELECT data,version FROM nx3_profiles ORDER BY id')).map(row=>({...validateProfile(parse(row.data)),version:row.version}));
  const variants=[];
  for(const node of nodes){
    const host=new URL(httpsOrigin(node.origin)).hostname;
    for(const protocol of account.protocol==='both'?['vless','trojan']:[account.protocol]){
      const base={protocol,id:account.uuid,server:node.connect_host||host,port:443,host,sni:host,path:'/connect',alpn:[]};
      for(const variant of aggregate([base],active))variants.push({...variant,label:node.label+' · '+variant.label});
    }
  }
  if(variants.length>MAX_NODES*12)fail('too_many_variants',503);
  const rendered=renderSubscription(variants,format||'base64');
  return new Response(rendered.body,{headers:{...noStore,'Content-Type':rendered.type,
    'Subscription-UserInfo':`upload=${account.up}; download=${Math.max(0,account.charged-account.up)}; total=${account.total_bytes}; expire=${Math.floor(account.expires_at/1000)}`,
    'X-NexiUP-Usage':'reserved-inclusive; reported and outstanding are separate in the portal',
    ...(rendered.warnings.length?{'X-NexiUP-Warnings':rendered.warnings.join(' ')}:{})}});
}
export default {
  async fetch(request,env,context) {
    try{
      env=env??{};const url=new URL(request.url);
      if(url.pathname==='/health')return json({component:'manager',version:VERSION,protocol:PROTOCOL,status:'alive',database_checked:false,tcp_module_loaded:false});
      if(url.pathname==='/favicon.ico')return new Response(null,{status:204,headers:noStore});
      if(['GET','HEAD'].includes(request.method)&&['/','/admin','/setup'].includes(url.pathname)){
        if(url.protocol==='http:'){url.protocol='https:';url.port='';return new Response(null,{status:308,headers:{...noStore,Location:url.href}});}
        return managerPage();
      }
      const db=managerDb(env);
      if(url.pathname.startsWith('/api/'))return await managerApi(db,env,request,url);
      if(url.pathname.startsWith('/mesh/v1/'))return await controlApi(db,env,request,url.pathname.slice('/mesh/v1/'.length));
      if(url.pathname.startsWith('/sub/')&&request.method==='GET')return await subscriber(db,request,url,url.pathname.slice(5));
      fail('not_found',404);
    }catch(error){return failure(error,env,'manager');}
  },
  async scheduled(event,env,context) {
    const work=(async()=>{try{await maintenance(managerDb(env??{}));}catch(error){failure(error,env,'manager');}})();
    try{if(context&&typeof context.waitUntil==='function')context.waitUntil(work);else await work;}catch{await work;}
  }
};

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
