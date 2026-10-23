import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import manager,{sha224,PERMIT_MS,MAX_GRANT} from '../manager-worker.js';
import nodeWorker,{NodeMeter} from '../node-worker.js';
import {meshFixture,create,requireAdmin,managerOrigin,id} from './mesh-helpers.mjs';
class FakeSocket extends EventEmitter {
  constructor(){super();this.binaryType='blob';}
  accept(){assert.equal(this.binaryType,'arraybuffer','binaryType must be set BEFORE accept');}
  addEventListener(event,callback){this.on(event,callback);}
  send(bytes){if(this.closed)throw new Error('closed');const raw=bytes instanceof Uint8Array?bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength):bytes;this.peer.emit('message',{data:typeof raw==='string'||this.peer.binaryType==='arraybuffer'?raw:new Blob([raw])});}
  close(){if(this.closed)return;this.closed=true;this.peer.closed=true;this.emit('close',{});this.peer.emit('close',{});}
}
function setupFakes(t,x,{echo=true}={}) {
  const requests=[],connections=[];
  t.mock.method(globalThis,'fetch',async(input,init={})=>{
    const request=input instanceof Request?input:new Request(String(input),init);requests.push({path:new URL(request.url).pathname,body:await request.clone().json()});
    assert.equal(new URL(request.url).origin,managerOrigin);assert.equal(init.redirect,'manual');
    return manager.fetch(request,x.env,{});
  });
  const NativeResponse=globalThis.Response;t.mock.method(globalThis,'Response',class extends NativeResponse{
    constructor(body,init={}){super(body,init.status===101?{...init,status:200}:init);if(init.status===101){Object.defineProperty(this,'status',{value:101});this.webSocket=init.webSocket;}}
  });
  const prior=globalThis.WebSocketPair;globalThis.WebSocketPair=class{constructor(){const a=new FakeSocket(),b=new FakeSocket();a.binaryType='arraybuffer';a.peer=b;b.peer=a;this[0]=a;this[1]=b;}};
  globalThis.__testConnect=address=>{let controller,closed=false;const socket={opened:Promise.resolve(),closed:Promise.resolve(),readable:new ReadableStream({start(c){controller=c;}}),writable:new WritableStream({write(bytes){if(echo&&!closed)controller.enqueue(bytes);}}),close(){if(!closed){closed=true;controller.close();}return Promise.resolve();}};connections.push({address,socket});return socket;};
  t.after(()=>{if(prior)globalThis.WebSocketPair=prior;else delete globalThis.WebSocketPair;delete globalThis.__testConnect;});
  return {requests,connections};
}
export function tunnelHeader(uuid,protocol,payload='hello') {
  const host=new TextEncoder().encode('destination.example.test'),bytes=typeof payload==='string'?new TextEncoder().encode(payload):payload;
  if(protocol==='trojan')return new Uint8Array([...new TextEncoder().encode(sha224(uuid)),13,10,1,3,host.length,...host,1,187,13,10,...bytes]);
  const identity=Uint8Array.from(uuid.replaceAll('-','').match(/../g),x=>parseInt(x,16));return new Uint8Array([0,...identity,0,1,1,187,2,host.length,...host,...bytes]);
}
async function until(predicate,max=1000){const end=Date.now()+max;while(!predicate()){if(Date.now()>end)throw new Error('Condition did not settle');await new Promise(resolve=>setTimeout(resolve,5));}}
for(const protocol of ['vless','trojan'])test('Mesh '+protocol+' node relays only after central admission; packet frames cause zero D1 writes',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x),network=setupFakes(t,x),pending=[];
  const res=await nodeWorker.fetch(new Request(x.nodes[0].origin+'/connect',{headers:{Upgrade:'websocket'}}),x.nodes[0].env,{waitUntil(p){pending.push(p);}});assert.equal(res.status,101);const ws=res.webSocket;t.after(()=>ws.close());
  let received=once(ws,'message');ws.send(tunnelHeader(a.uuid,protocol,'hello'));let [event]=await received;assert.equal(new TextDecoder().decode(new Uint8Array(event.data).slice(protocol==='vless'?2:0)),'hello');
  assert.equal(network.connections.length,1);const baseline=x.DB.writes;
  for(let i=0;i<15;i++){received=once(ws,'message');ws.send(new TextEncoder().encode('again'));[event]=await received;assert.equal(new TextDecoder().decode(new Uint8Array(event.data)),'again');}
  assert.equal(x.DB.writes,baseline);assert.equal(network.requests.filter(r=>r.path.endsWith('/open')).length,1);assert.equal(network.requests.filter(r=>r.path.endsWith('/grant')).length,0);
  ws.close();await Promise.allSettled(pending);await until(()=>x.DB.row('SELECT charged FROM nx3_usage WHERE account_id=?',a.id)?.charged===160);
  const row=x.DB.row('SELECT charged,up,down FROM nx3_usage WHERE account_id=?',a.id);assert.deepEqual({...row},{charged:160,up:80,down:80});assert.deepEqual(network.connections[0].address,{hostname:'destination.example.test',port:443});
});
test('an invalid account, disabled node, expired account and unsupported UDP never open TCP',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x),network=setupFakes(t,x),pending=[];
  const cases=[tunnelHeader(crypto.randomUUID(),'vless'),(()=>{const b=tunnelHeader(a.uuid,'vless');b[18]=2;return b;})()];
  for(const bytes of cases){const res=await nodeWorker.fetch(new Request(x.nodes[0].origin+'/connect',{headers:{Upgrade:'websocket'}}),x.nodes[0].env,{waitUntil(p){pending.push(p);}});const ws=res.webSocket,closed=once(ws,'close');ws.send(bytes);await closed;}
  x.DB.exec('UPDATE nx3_accounts SET expires_at=? WHERE id=?',Date.now()-1,a.id);
  let res=await nodeWorker.fetch(new Request(x.nodes[0].origin+'/connect',{headers:{Upgrade:'websocket'}}),x.nodes[0].env,{waitUntil(p){pending.push(p);}});let closed=once(res.webSocket,'close');res.webSocket.send(tunnelHeader(a.uuid,'vless'));await closed;
  assert.equal(network.connections.length,0);await Promise.allSettled(pending);
});
test('byte limit slices the final response rather than forwarding a whole over-budget frame',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x,{total_bytes:8,daily_bytes:8}),network=setupFakes(t,x),pending=[];
  const res=await nodeWorker.fetch(new Request(x.nodes[0].origin+'/connect',{headers:{Upgrade:'websocket'}}),x.nodes[0].env,{waitUntil(p){pending.push(p);}}),ws=res.webSocket,parts=[];
  ws.on('message',event=>parts.push(new Uint8Array(event.data)));const closed=once(ws,'close');ws.send(tunnelHeader(a.uuid,'vless','hello'));await closed;await Promise.allSettled(pending);
  assert.equal(network.connections.length,1);assert.equal(new TextDecoder().decode(parts[0].slice(2)),'hel');
  const row=x.DB.row('SELECT charged,up,down FROM nx3_usage WHERE account_id=?',a.id);assert.deepEqual({...row},{charged:8,up:5,down:3});
});
test('meter serializes simultaneous upload/download consumption and admits no byte beyond reserved credit',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x,{total_bytes:100,daily_bytes:100}),network=setupFakes(t,x);
  const meter=new NodeMeter({id:x.nodes[0].id,key:x.nodes[0].key,manager:managerOrigin},'vless',a.uuid);await meter.open();
  const result=await Promise.allSettled(Array.from({length:40},(_,i)=>meter.take(7,i%2?'down':'up')));
  assert.equal(result.filter(r=>r.status==='fulfilled').reduce((sum,r)=>sum+r.value,0),100);assert.equal(meter.lease.up+meter.lease.down,100);assert.equal(x.DB.row('SELECT charged FROM nx3_usage WHERE account_id=?',a.id).charged,100);await meter.finish();assert.equal(network.connections.length,0);
});
test('pause refresh fails closed, and an expired permit cannot spend cached credit',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x);setupFakes(t,x);
  const meter=new NodeMeter({id:x.nodes[0].id,key:x.nodes[0].key,manager:managerOrigin},'vless',a.uuid);await meter.open();
  x.DB.exec("UPDATE nx3_accounts SET status='paused' WHERE id=?",a.id);await assert.rejects(meter.pulse(),error=>error.code==='account_unavailable');meter.permit=performance.now()-1;await assert.rejects(meter.take(1,'up'),error=>error.code==='connection_expired');await meter.finish();assert.equal(x.DB.row('SELECT charged FROM nx3_usage WHERE account_id=?',a.id).charged,0);
});
test('clock/round-trip conservatism never extends the 30-second authorization window',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x);setupFakes(t,x);const meter=new NodeMeter({id:x.nodes[0].id,key:x.nodes[0].key,manager:managerOrigin},'vless',a.uuid);
  const start=performance.now();await meter.open();assert.ok(meter.permit-start<=PERMIT_MS);assert.ok(meter.permit>performance.now());
  const before=performance.now();meter.apply({elapsed:9000,data:{connection_id:meter.connectionId,account_id:a.id,server_time:100000,permit_until:130000,hard_until:999999999,fallbacks:[]}});assert.ok(meter.permit-before<=21000);await meter.finish();
});
test('manager outage cannot manufacture credits or authorize a TCP connection',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x),network=setupFakes(t,x),pending=[];
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('PRIVATE_NETWORK_URL');});
  const response=await nodeWorker.fetch(new Request(x.nodes[0].origin+'/connect',{headers:{Upgrade:'websocket'}}),x.nodes[0].env,{waitUntil(p){pending.push(p);}});const closed=once(response.webSocket,'close');response.webSocket.send(tunnelHeader(a.uuid,'vless'));await closed;await Promise.allSettled(pending);assert.equal(network.connections.length,0);assert.equal(x.DB.row('SELECT COUNT(*) AS n FROM nx3_leases').n,0);
});
test('lost grant response remains conservatively charged, never refunded from a guess',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x);setupFakes(t,x);
  t.mock.method(globalThis,'fetch',async(input,init)=>{const request=new Request(String(input),init),response=await manager.fetch(request,x.env,{});if(new URL(request.url).pathname.endsWith('/open'))throw new Error('synthetic response lost AFTER commit');return response;});
  const meter=new NodeMeter({id:x.nodes[0].id,key:x.nodes[0].key,manager:managerOrigin},'vless',a.uuid);await assert.rejects(meter.open(),error=>error.code==='manager_unavailable');await meter.finish();const row=x.DB.row('SELECT charged,up,down FROM nx3_usage WHERE account_id=?',a.id);assert.equal(row.charged,65536);assert.equal(row.up+row.down,0);assert.equal(x.DB.row('SELECT closed FROM nx3_connections WHERE id=?',meter.connectionId).closed,1);
});
test('client-provided relay overrides cannot replace admin-configured fallback destinations',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x);x.DB.exec('UPDATE nx3_nodes SET fallbacks=? WHERE id=?',JSON.stringify([{host:'relay.example.test',port:8443}]),x.nodes[0].id);const network=setupFakes(t,x),echo=globalThis.__testConnect,attempts=[],pending=[];
  globalThis.__testConnect=address=>{attempts.push(address);if(attempts.length===1)return {opened:Promise.reject(new Error('synthetic direct failure')),closed:Promise.resolve(),close(){}};return echo(address);};
  const response=await nodeWorker.fetch(new Request(x.nodes[0].origin+'/connect?proxyip=untrusted.example.test',{headers:{Upgrade:'websocket'}}),x.nodes[0].env,{waitUntil(p){pending.push(p);}}),ws=response.webSocket;const received=once(ws,'message');ws.send(tunnelHeader(a.uuid,'vless'));await received;ws.close();await Promise.allSettled(pending);assert.deepEqual(attempts,[{hostname:'destination.example.test',port:443},{hostname:'relay.example.test',port:8443}]);assert.equal(network.connections.length,1);
});
test('invalid early data returns before accepting a WebSocket or allocating a central connection',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const network=setupFakes(t,x);const res=await nodeWorker.fetch(new Request(x.nodes[0].origin+'/connect',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'%'}}),x.nodes[0].env,{});assert.equal(res.status,400);assert.equal(network.connections.length,0);assert.equal(network.requests.length,0);
});

test('post-upgrade diagnostics are opt-in and never emit a credential, destination or raw remote error',async t=>{
  const x=await meshFixture();t.after(()=>x.close());const a=await create(x);setupFakes(t,x);const logs=[],pending=[];
  t.mock.method(console,'error',value=>logs.push(value));t.mock.method(globalThis,'fetch',async()=>{throw new Error('PRIVATE_FAILURE_AND_URL');});
  const run=async(enabled)=>{const response=await nodeWorker.fetch(new Request(x.nodes[0].origin+'/connect?private=PRIVATE_QUERY',{headers:{Upgrade:'websocket'}}),{...x.nodes[0].env,NEXIUP_DIAGNOSTICS:enabled?'true':'false'},{waitUntil(p){pending.push(p);}});const closed=once(response.webSocket,'close');response.webSocket.send(tunnelHeader(a.uuid,'vless'));await closed;};
  await run(false);assert.equal(logs.length,0);await run(true);assert.equal(logs.length,1);const event=JSON.parse(logs[0]);assert.equal(event.event,'nexiup_mesh_tunnel_error');assert.equal(event.code,'manager_unavailable');assert.ok(!logs[0].includes('PRIVATE'));assert.ok(!logs[0].includes(a.uuid));assert.ok(!logs[0].includes(x.nodes[0].key));await Promise.allSettled(pending);
});
