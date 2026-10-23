import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import manager from '../manager-worker.js';
import { FakeD1 } from './helpers.mjs';
export const managerOrigin='https://manager.example.test';
export const secret=()=>randomBytes(24).toString('hex');
export const id=()=>randomBytes(16).toString('hex');
export function ownerRequest(path,env,{method='GET',body,headers={},owner=true}={}){
  return new Request(managerOrigin+'/api/'+path,{method,headers:{...(owner?{Authorization:'Bearer '+env.OWNER_KEY}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
export async function admin(x,path,options={}){
  const response=await manager.fetch(ownerRequest(path,x.env,options),x.env,{});return {response,data:await response.json()};
}
export async function requireAdmin(x,path,options={}){const result=await admin(x,path,options);assert.ok(result.response.ok,JSON.stringify(result.data));return result.data;}
export async function meshFixture(nodes=2){
  const DB=new FakeD1(),env={DB,OWNER_KEY:secret()},x={DB,env,nodes:[],close:()=>DB.close()};
  await requireAdmin(x,'login',{method:'POST',body:{}});
  await requireAdmin(x,'settings',{method:'PUT',body:{public_origin:managerOrigin,version:1}});
  for(let i=0;i<nodes;i++){
    const name='node'+(i+1),ref='NODE_KEY_'+(i+1);env[ref]=secret();
    const n={id:name,label:'Synthetic node '+(i+1),origin:'https://'+name+'.example.test',key_ref:ref,country:'ZZ',connect_host:'',fallbacks:[],enabled:false,version:0};
    await requireAdmin(x,'nodes',{method:'POST',body:n});
    // UNIT fixture only. Actual bidirectional pairing is exercised in native/browser tests.
    DB.exec("UPDATE nx3_nodes SET enabled=1,verified_at=?,last_status='unit_fixture',version=2 WHERE id=?",Date.now(),name);
    x.nodes.push({id:name,origin:n.origin,key:env[ref],env:{NODE_ID:name,NODE_KEY:env[ref],MANAGER_URL:managerOrigin}});
  }
  return x;
}
export async function create(x,overrides={}){
  return (await requireAdmin(x,'accounts',{method:'POST',body:{name:'Synthetic_'+id().slice(0,8),days:1,notes:'Synthetic fixture; no production customer',total_bytes:1048576,daily_bytes:1048576,conn_limit:4,protocol:'both',node_mode:'all',nodes:[],nonce:id(),...overrides}})).account;
}
export async function control(x,index,action,body,extra={}){
  const node=x.nodes[index],request=new Request(managerOrigin+'/mesh/v1/'+action,{method:'POST',headers:{Authorization:'Bearer '+node.key,'X-NexiUP-Node':node.id,...extra},body:JSON.stringify(body)});
  const response=await manager.fetch(request,x.env,{});return {response,data:await response.json()};
}
export async function open(x,index,account,extra={}){
  const body={connection_id:id(),lease_id:id(),identity:account.uuid,protocol:'vless',...extra};return {...await control(x,index,'open',body),body};
}
export async function close(x,index,opened,up,down){return control(x,index,'close',{connection_id:opened.body.connection_id,report:{lease_id:opened.data.lease.id,up,down}});}
