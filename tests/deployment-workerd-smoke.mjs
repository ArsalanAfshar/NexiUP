// Optional deployed-entrypoint matrix. Uses the production module directly, not
// preview.mjs, no automatic login, no production secrets and no external network.
// Pass optional source/bundle paths as CLI arguments to test both install artifacts.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { Miniflare, convertV4MiniflareOptions } = await import(process.env.MINIFLARE_MODULE || 'miniflare');
const secret=()=>randomBytes(24).toString('hex');
const bindings={ROLE:'all',MASTER_KEY:secret(),SETUP_KEY:secret(),WEB_ADMIN_KEY:secret(),CALLBACK_SECRET:secret(),WEBHOOK_SECRET:secret(),ADMIN_IDS:'901',BOT_TOKEN:'12345:synthetic_token_only'};
const origin='https://deployment.example.test';
const expected=(await readFile(new URL('../worker.js',import.meta.url),'utf8')).match(/const VERSION = '([^']+)'/)[1]; // Legacy artifact, independent of the Mesh release version.
const sources=process.argv.slice(2).length?process.argv.slice(2).map(p=>resolve(p)):[fileURLToPath(new URL('../worker.js',import.meta.url))];
const options=scriptPath=>({name:'deployment-check',modules:true,scriptPath,compatibilityDate:'2026-10-20',compatibilityFlags:['global_fetch_strictly_public'],bindings,
  outboundService:()=>{throw new Error('Deployment preflight must not contact external services');}});
const instance=worker=>new Miniflare(convertV4MiniflareOptions({workers:[worker]}));
const post=(mf,action,key=bindings.SETUP_KEY,extra={})=>mf.dispatchFetch(origin+'/setup',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...extra},body:JSON.stringify({action})});
async function checkShell(mf){
  for(const path of ['/','/health','/admin','/setup']){
    const response=await mf.dispatchFetch(origin+path);assert.equal(response.status,200,path);assert.equal(response.headers.get('X-NexiUP-Version'),expected);
    if(path==='/health'){const data=await response.json();assert.equal(data.status,'alive');assert.equal(data.database_checked,false);assert.equal(data.version,expected);}
    else await response.arrayBuffer();
  }
  const redirect=await mf.dispatchFetch('http://deployment.example.test/setup',{redirect:'manual'});assert.equal(redirect.status,308);
}
function faultSource(source){
  // Test-only fault injection around the unchanged application handler. This is
  // never saved over worker.js or deployed. The native D1 cases below are separate.
  const entry='__nexiupTestApplication';assert.ok(!source.includes(entry));
  if(source.includes('export default {'))source=source.replace('export default {','const '+entry+' = {');
  else{
    const re=/\bexport\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\};/;assert.match(source,re);
    source=source.replace(re,(_match,name)=>'const '+entry+' = '+name+';');
  }
  return source+`
    export default { async fetch(request, env, ctx) {
      const patched = { ...env };
      if (env.FAULT_MODE === 'getter') Object.defineProperty(patched, 'DB', { get() { throw new Error('SYNTHETIC_PRIVATE_BINDING'); } });
      else {
        const rejection = env.FAULT_MODE === 'undefined' ? undefined : null;
        const read = () => env.FAULT_MODE === 'pending' ? new Promise(() => {}) : Promise.reject(rejection);
        patched.DB = { prepare() { return { bind() { return { first: read, all: read, run: () => Promise.reject(rejection) }; } }; }, batch() { return Promise.reject(rejection); } };
      }
      return ${entry}.fetch(request, patched, ctx);
    } };
  `;
}
for(const scriptPath of sources){
  const label=scriptPath.includes('/.work/')?'bundle':'source';
  for(const [name,DB,error] of [['missing',undefined,'d1_binding_missing'],['wrong-type','not-a-d1-binding','d1_binding_invalid']]){
    const mf=instance({...options(scriptPath),bindings:{...bindings,...(DB===undefined?{}:{DB})}});
    try{
      await checkShell(mf);
      const response=await post(mf,'migrate');assert.equal(response.status,503);const data=await response.json();assert.equal(data.error,error);assert.match(data.request_id,/^[a-f0-9]{24}$/);
      const diagnostic=await post(mf,'diagnostics',bindings.WEB_ADMIN_KEY);assert.equal(diagnostic.status,503);assert.equal((await diagnostic.json()).database.status,error);
    }finally{await mf.dispose();}
    console.log(label,name+' binding: bootstrap stays available; protected operations return structured 503');
  }
  for(const role of ['all','hub','node']){
    const config={...bindings,ROLE:role},owner=role==='node'?config.MASTER_KEY:config.SETUP_KEY;
    const mf=instance({...options(scriptPath),bindings:config,d1Databases:['DB']});
    try{
      await checkShell(mf);const db=await mf.getD1Database('DB');
      const count=async()=>Number((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='schema_version' OR name LIKE 'nx_%'").first()).n);
      assert.equal(await count(),0);
      let response=await post(mf,'diagnostics','wrong');assert.equal(response.status,401);assert.equal(await count(),0);
      response=await post(mf,'diagnostics',owner,{Origin:'https://other.example.test'});assert.equal(response.status,403);assert.equal(await count(),0);
      response=await post(mf,'diagnostics',owner);assert.equal(response.status,503);let data=await response.json();assert.equal(data.database.status,'ok');assert.equal(data.schema.status,'migration_required');assert.equal(await count(),0);
      // Real owner login must finish all five groups AND final seeding; the
      // startup/preflight checks do not perform any of that work on their own.
      let cookie='';
      for(let i=0;i<12;i++){
        response=await mf.dispatchFetch(origin+'/admin/web-api/login',{method:'POST',headers:{Authorization:'Bearer '+bindings.WEB_ADMIN_KEY}});data=await response.json();
        if(response.status===202){assert.equal(data.migration_required,true);continue;}
        assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.role,role);assert.ok(data.csrf);cookie=response.headers.get('Set-Cookie').split(';')[0];break;
      }
      assert.ok(cookie,'authenticated login must complete');
      response=await mf.dispatchFetch(origin+'/admin/web-api/overview',{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal((await response.json()).role,role);
      const auditBefore=(await db.prepare('SELECT COUNT(*) AS n FROM nx_audit').first()).n;
      response=await post(mf,'diagnostics',owner);assert.equal(response.status,200);data=await response.json();assert.equal(data.ready,true);assert.equal(data.read_only,true);assert.equal(data.schema.version,5);assert.ok(data.statements<=4);assert.equal(data.external_connectivity_tested,false);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM nx_audit').first()).n,auditBefore);
      response=await post(mf,'diagnostics',bindings.WEB_ADMIN_KEY);assert.equal(response.status,200);
      if(role!=='hub'){
        response=await mf.dispatchFetch(origin+'/sync/api/users',{method:'POST',headers:{Authorization:'Bearer '+bindings.MASTER_KEY,'Content-Type':'application/json'},body:JSON.stringify({name:'native_'+randomBytes(8).toString('hex'),trafficLimit:1,dailyLimit:1,expiryDays:1})});assert.equal(response.status,201);assert.equal((await response.json()).success,true);
      }else{
        response=await mf.dispatchFetch(origin+'/admin/web-api/node-users',{headers:{Cookie:cookie}});assert.equal(response.status,403);
      }
    }finally{await mf.dispose();}
    console.log(label,role+': fresh native D1, read-only preflight, authenticated migrations/login, role-scoped API PASS');
  }
  const injected=faultSource(await readFile(scriptPath,'utf8'));
  for(const [mode,error] of [['getter','d1_binding_unavailable'],['null','d1_unavailable'],['undefined','d1_unavailable'],['pending','d1_read_timeout']]){
    const mf=instance({...options(scriptPath),script:injected,bindings:{...bindings,FAULT_MODE:mode}});
    try{
      await checkShell(mf);const started=Date.now();
      const response=await post(mf,mode==='pending'?'diagnostics':'migrate');assert.equal(response.status,503);const data=await response.json();
      assert.equal(mode==='pending'?data.database.status:data.error,error);assert.ok(data.request_id);assert.ok(!JSON.stringify(data).includes('SYNTHETIC_PRIVATE_BINDING'));
      if(mode==='pending'){assert.ok(Date.now()-started<15000);assert.equal(data.ready,false);}
    }finally{await mf.dispose();}
    console.log(label,'synthetic fault '+mode+': bounded response, no uncaught entrypoint exception');
  }
}
console.log('Native deployment matrix PASS. These are local workerd checks, not a deployment or a reproduction of an account-specific Cloudflare incident.');
