// Optional cold-start checks for raw/bundled delivery artifacts. No preview wrapper.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
const manager=process.argv[2]?resolve(process.argv[2]):fileURLToPath(new URL('../manager-worker.js',import.meta.url));
const node=process.argv[3]?resolve(process.argv[3]):fileURLToPath(new URL('../node-worker.js',import.meta.url));
const owner=randomBytes(24).toString('hex');
for(const [component,scriptPath,bindings,error]of [['manager',manager,{OWNER_KEY:owner},'d1_binding_missing'],['manager',manager,{OWNER_KEY:owner,DB:'wrong-binding-type'},'d1_binding_invalid'],['node',node,{},null]]){
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'cold-boot',modules:true,scriptPath,bindings,compatibilityDate:'2026-10-20',compatibilityFlags:['global_fetch_strictly_public']}]}));
  try{
    for(const path of component==='manager'?['/','/admin','/setup','/health']:['/','/health']){const response=await mf.dispatchFetch('https://cold.example.test'+path);assert.equal(response.status,200);assert.equal(response.headers.get('X-NexiUP-Version'),'3.0.0');if(path==='/health'){const data=await response.json();assert.equal(data.component,component);if(component==='node')assert.equal(data.configured,false);}else await response.arrayBuffer();}
    if(error){const response=await mf.dispatchFetch('https://cold.example.test/api/login',{method:'POST',headers:{Authorization:'Bearer '+owner}});assert.equal(response.status,503);const data=await response.json();assert.equal(data.error,error);assert.match(data.request_id,/^[a-f0-9]{24}$/);assert.ok(!JSON.stringify(data).includes(owner));}
    console.log(component+' cold boot PASS / '+(error||'no configuration'));
  }finally{await mf.dispose();}
}
