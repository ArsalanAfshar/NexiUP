// DEVELOPMENT / TEST ONLY. Disposable keys, real local workerd/D1, two API nodes.
// No production account, no Nahan, no auto-login, no public proxy or ISP claim.
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
const secret=()=>randomBytes(24).toString('hex');
export async function createMeshHarness({managerPath=fileURLToPath(new URL('../manager-worker.js',import.meta.url)),nodePath=fileURLToPath(new URL('../node-worker.js',import.meta.url)),echo=false}={}) {
  const origins={manager:'https://manager.example.test',node1:'https://node1.example.test',node2:'https://node2.example.test'};
  const owner=secret(),keys={node1:secret(),node2:secret()},bindings={OWNER_KEY:owner,NODE_KEY_ONE:keys.node1,NODE_KEY_TWO:keys.node2};
  let server,connections=0,nodeScript;
  if(echo){
    const sockets=new Set();server=net.createServer(socket=>{connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.pipe(socket);});
    await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
    const source=await readFile(nodePath,'utf8'),needle='return sockets.connect(address);';
    if(!source.includes(needle))throw new Error('Test-only socket mapping boundary missing');
    // ONLY TCP destination mapping is instrumented. Header validation, public-host
    // checks, owner/node auth, global ledger, WebSocket and metering remain real.
    nodeScript=source.replace(needle,`return sockets.connect({hostname:'127.0.0.1',port:${server.address().port}});`);
    server.forceClose=()=>{for(const socket of sockets)socket.destroy();};
  }
  const outbound=async(request,instance)=>{
    const match=Object.entries(origins).find(([,origin])=>origin===new URL(request.url).origin);
    if(!match)throw new Error('Unexpected public network request in Mesh test');
    const target=await instance.getWorker(match[0]);
    return target.fetch(request.url,{method:request.method,headers:request.headers,...(!['GET','HEAD'].includes(request.method)?{body:await request.arrayBuffer()}: {})});
  };
  const common={modules:true,compatibilityDate:'2026-10-20',compatibilityFlags:['global_fetch_strictly_public'],outboundService:outbound};
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[
    {...common,name:'manager',scriptPath:managerPath,d1Databases:{DB:'mesh-manager'},bindings},
    ...['node1','node2'].map(id=>({...common,name:id,scriptPath:nodePath,...(nodeScript?{script:nodeScript}:{}),bindings:{NODE_ID:id,NODE_KEY:keys[id],MANAGER_URL:origins.manager}}))
  ]}));
  const workers={manager:await mf.getWorker('manager'),node1:await mf.getWorker('node1'),node2:await mf.getWorker('node2')};
  const db=await mf.getD1Database('DB','manager');
  const api=async(path,{method='GET',body,key=owner,headers={}}={})=>{
    const response=await workers.manager.fetch(origins.manager+'/api/'+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();return {response,data};
  };
  return {mf,workers,db,origins,owner,keys,api,bindings,get tcpConnections(){return connections;},async close(){await mf.dispose();if(server){server.forceClose();await new Promise(resolve=>server.close(resolve));}}};
}
export function header(uuid,protocol,payload) {
  const host=new TextEncoder().encode('public-fixture.example.test'),bytes=new TextEncoder().encode(payload);
  if(protocol==='trojan')return Uint8Array.from([...new TextEncoder().encode(createHash('sha224').update(uuid).digest('hex')),13,10,1,3,host.length,...host,1,187,13,10,...bytes]);
  const credential=Uint8Array.from(uuid.replaceAll('-','').match(/../g),x=>parseInt(x,16));return Uint8Array.from([0,...credential,0,1,1,187,2,host.length,...host,...bytes]);
}
export async function waitFor(predicate,timeout=6000) {
  const end=Date.now()+timeout;
  for(;;){if(await predicate())return;if(Date.now()>=end)throw new Error('Native condition did not settle');await new Promise(resolve=>setTimeout(resolve,25));}
}
