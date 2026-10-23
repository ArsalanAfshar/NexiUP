// Optional native integration. Run raw files, then optional Wrangler bundles.
// Real workerd/D1 + real WebSockets + local TCP echo. Only the TCP destination is
// mapped to loopback by a clearly test-only source adapter; no public-network claim.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {createMeshHarness,header,waitFor} from './mesh-native-harness.mjs';
const nonce=()=>randomBytes(16).toString('hex');
const options=process.argv.length>2?{managerPath:resolve(process.argv[2]),nodePath:resolve(process.argv[3])}:{};
const h=await createMeshHarness({...options,echo:true});
async function ok(path,options){const result=await h.api(path,options);assert.ok(result.response.ok,JSON.stringify(result.data));return result;}
function recordBody(node,enabled){return{id:node.id,label:node.label,origin:node.origin,key_ref:node.key_ref,country:node.country,connect_host:node.connect_host,fallbacks:JSON.parse(node.fallbacks),enabled,version:node.version};}
async function connection(node,identity,protocol,payload,expected,closeAtResult=true){
  const response=await h.workers[node].fetch(h.origins[node]+'/connect',{headers:{Upgrade:'websocket'}});assert.equal(response.status,101);const ws=response.webSocket;assert.ok(ws);ws.binaryType='arraybuffer';ws.accept();
  const chunks=[];let size=0,closed=false;
  const done=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.close();reject(new Error('Native WebSocket timed out: '+node+' '+protocol+' expected='+expected+' size='+size+' closed='+closed));},10000);
    ws.addEventListener('message',event=>{const chunk=new Uint8Array(event.data);chunks.push(chunk);size+=chunk.length;if(size>=expected+(protocol==='vless'?2:0)){clearTimeout(timer);if(closeAtResult)ws.close();resolve(undefined);}});
    ws.addEventListener('close',()=>{closed=true;clearTimeout(timer);if(!expected)resolve(undefined);else if(size<expected+(protocol==='vless'?2:0))reject(new Error('Native tunnel closed before expected bytes'));});
    ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Native WebSocket error'));});
  });
  ws.send(header(identity,protocol,payload));await done;
  const combined=Buffer.concat(chunks.map(x=>Buffer.from(x)));return{ws,text:combined.subarray(protocol==='vless'?2:0).toString(),get closed(){return closed;}};
}
try{
  for(const name of ['manager','node1','node2']){const res=await h.workers[name].fetch(h.origins[name]+'/health');assert.equal(res.status,200);const data=await res.json();assert.equal(data.version,'3.0.0');assert.equal(data.component,name==='manager'?'manager':'node');}
  const before=await h.api('diagnostics',{method:'POST',body:{}});assert.equal(before.response.status,503);assert.equal(before.data.read_only,true);assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'nx3_%'").first()).n,0);
  const login=await ok('login',{method:'POST',body:{}});assert.ok(login.response.headers.get('Set-Cookie').includes('HttpOnly'));assert.ok(login.data.csrf);
  await ok('settings',{method:'PUT',body:{public_origin:h.origins.manager,version:1}});
  for(const [index,name]of ['node1','node2'].entries()){
    await ok('nodes',{method:'POST',body:{id:name,label:'Synthetic native '+name,origin:h.origins[name],key_ref:index===0?'NODE_KEY_ONE':'NODE_KEY_TWO',country:'ZZ',connect_host:'',fallbacks:[],enabled:false,version:0}});
    const probe=await ok('nodes/'+name+'/test',{method:'POST',body:{}});assert.equal(probe.data.ok,true);assert.equal(probe.data.api_round_trip_verified,true);assert.equal(probe.data.proxy_exit_verified,false);
    const node=(await ok('nodes')).data.items.find(x=>x.id===name);assert.ok(node.verified_at);await ok('nodes',{method:'POST',body:recordBody(node,true)});
  }
  const created=await ok('accounts',{method:'POST',body:{name:'Native shared fixture',notes:'Synthetic, local TCP echo only',days:1,total_bytes:100,daily_bytes:20,conn_limit:4,protocol:'both',node_mode:'all',nodes:[],nonce:nonce()}}),account=created.data.account;
  let res=await h.workers.manager.fetch(account.subscription_url+'?format=xray');assert.equal(res.status,200);const variants=await res.json();assert.equal(variants.length,12);assert.equal(new Set(variants.map(v=>v.outbounds[0].streamSettings.wsSettings.headers.Host)).size,2);
  for(const variant of variants){const out=variant.outbounds[0];assert.equal(out.protocol==='vless'?out.settings.vnext[0].users[0].id:out.settings.servers[0].password,account.uuid);}
  res=await h.workers.manager.fetch(account.subscription_url+'?format=qr');assert.equal(res.status,200);assert.equal(new Uint8Array(await res.arrayBuffer())[0],137);
  const first=await connection('node1',account.uuid,'vless','abc',3);assert.equal(first.text,'abc');
  await waitFor(async()=>{const row=await h.db.prepare('SELECT charged FROM nx3_usage WHERE account_id=?').bind(account.id).first();return row?.charged===6;});
  const second=await connection('node2',account.uuid,'trojan','defghijk',6,false);assert.equal(second.text,'defghi');await waitFor(()=>second.closed);
  await waitFor(async()=>{const row=await h.db.prepare('SELECT up+down AS reported FROM nx3_usage WHERE account_id=?').bind(account.id).first();return row?.reported===20;});
  const used=await h.db.prepare('SELECT charged,up,down FROM nx3_usage WHERE account_id=?').bind(account.id).first();assert.deepEqual(used,{charged:20,up:11,down:9});
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM nx3_node_usage WHERE account_id=?').bind(account.id).first()).n,2);
  const socketCount=h.tcpConnections;await connection('node1',account.uuid,'vless','blocked',0);assert.equal(h.tcpConnections,socketCount,'exhausted account must not open upstream TCP');
  const renewed=await ok('accounts/'+account.id+'/action',{method:'POST',body:{action:'renew',version:account.version,nonce:nonce(),days:1,reset:false}});assert.equal(renewed.data.account.charged,20);assert.equal(renewed.data.account.expires_at,account.expires_at+86400000);
  const diag=await ok('diagnostics',{method:'POST',body:{}});assert.equal(diag.data.ready,true);assert.equal(diag.data.statements,4);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM nx3_probes').first()).n,0);
  console.log('Mesh native PASS: manager + two standalone nodes, bidirectional observed challenges, real D1 owner auth, one shared UUID/subscription, 12 variants, local PNG.');
  console.log('Native WebSocket/TCP PASS: VLESS node 1 admitted 6 bytes; Trojan node 2 admitted exactly 14 more; shared daily limit 20 stopped the final frame and denied new TCP.');
  console.log('No public proxy, ISP, hosted account or production throughput was tested. TCP destination was a sandbox echo server, not an Internet endpoint.');
}catch(error){console.log('Safe native debug counts:',{tcp:h.tcpConnections,connections:await h.db.prepare('SELECT COUNT(*) AS n FROM nx3_connections').first(),leases:await h.db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(up),0) AS up,COALESCE(SUM(down),0) AS down FROM nx3_leases').first()});throw error;}finally{await h.close();}
