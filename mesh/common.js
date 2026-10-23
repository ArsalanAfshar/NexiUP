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
