import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import worker, { panelCreate, sha224, GIB } from '../worker.js';
import { fixture } from './helpers.mjs';

class Socket extends EventEmitter {
  accept() {}
  addEventListener(type, cb) { this.on(type, cb); }
  send(data) { this.peer.emit('message', { data: data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset+data.byteLength) : data }); }
  close() { if(this.closed)return;this.closed=true;this.emit('close',{});this.peer.closed=true;this.peer.emit('close',{}); }
}
function cloudflareFakes(t) {
  t.mock.method(globalThis,'Response',class extends Response {
    constructor(body,init={}) {const upgrade=init.status===101;super(body,upgrade?{...init,status:200}:init);if(upgrade){Object.defineProperty(this,'status',{value:101});this.webSocket=init.webSocket;}}
  });
  const previous=globalThis.WebSocketPair;
  globalThis.WebSocketPair=class {constructor(){const a=new Socket(),b=new Socket();a.peer=b;b.peer=a;this[0]=a;this[1]=b;}};
  t.after(()=>{if(previous)globalThis.WebSocketPair=previous;else delete globalThis.WebSocketPair;delete globalThis.__testConnect;});
  const connections=[];
  globalThis.__testConnect=address=>{
    let ctrl,closed=false;
    const socket={opened:Promise.resolve(),readable:new ReadableStream({start(c){ctrl=c;}}),writable:new WritableStream({write(data){if(!closed)ctrl.enqueue(data);}}),close(){if(closed)return;closed=true;ctrl.close();}};
    connections.push({address,socket});return socket;
  };
  return connections;
}
function header(id,protocol,payload=new TextEncoder().encode('hello')) {
  const host=new TextEncoder().encode('example.test');
  if(protocol==='trojan')return new Uint8Array([...new TextEncoder().encode(sha224(id)),13,10,1,3,host.length,...host,1,187,13,10,...payload]);
  const uuid=Uint8Array.from(id.replaceAll('-','').match(/../g),x=>parseInt(x,16));
  return new Uint8Array([0,...uuid,0,1,1,187,2,host.length,...host,...payload]);
}
for(const protocol of ['vless','trojan'])test(`real tunnel handler relays ${protocol} with stream fakes; zero per-frame D1 writes`,async t=>{
  const x=await fixture();t.after(()=>x.DB.close());
  if(protocol==='trojan'){const p=JSON.parse(x.DB.row("SELECT value FROM nx_settings WHERE key='panel'").value);p.protocol='trojan';x.DB.exec("UPDATE nx_settings SET value=? WHERE key='panel'",JSON.stringify(p));}
  const u=await panelCreate(x.r(),{name:'tunnel',trafficLimit:1,dailyLimit:1,expiryDays:1,connLimit:2},'tunnel-key');
  const connections=cloudflareFakes(t),tasks=[];
  const response=await worker.fetch(new Request('https://node.example.test/sync/ws',{headers:{Upgrade:'websocket'}}),x.env,{waitUntil(p){tasks.push(p);}});
  assert.equal(response.status,101);const ws=response.webSocket;t.after(()=>ws.close());const baseline=x.DB.writes;
  let received=once(ws,'message');ws.send(header(u.id,protocol));let [{data}]=await received;
  const first=new Uint8Array(data);assert.equal(new TextDecoder().decode(first.slice(protocol==='vless'?2:0)),'hello');
  received=once(ws,'message');ws.send(new TextEncoder().encode('again'));[{data}]=await received;assert.equal(new TextDecoder().decode(data),'again');
  assert.equal(x.DB.writes,baseline);assert.deepEqual(connections[0].address,{hostname:'example.test',port:443});
  ws.close();await Promise.allSettled(tasks);await new Promise(resolve=>setImmediate(resolve));
  const usage=x.DB.row('SELECT up,down FROM nx_panel_usage WHERE id=?',u.id);assert.equal(usage.up,10);assert.equal(usage.down,10);
});

test('unauthenticated tunnel cannot open an upstream TCP socket',async t=>{
  const x=await fixture();t.after(()=>x.DB.close());const connections=cloudflareFakes(t);
  const response=await worker.fetch(new Request('https://node.example.test/sync/ws',{headers:{Upgrade:'websocket'}}),x.env,{waitUntil(){}});
  const ws=response.webSocket;const closed=once(ws,'close');ws.send(header(crypto.randomUUID(),'vless'));await closed;assert.equal(connections.length,0);
});

test('paused node rejects upgrade without opening sockets',async t=>{
  const x=await fixture();t.after(()=>x.DB.close());const connections=cloudflareFakes(t);
  const p=JSON.parse(x.DB.row("SELECT value FROM nx_settings WHERE key='panel'").value);p.paused=true;x.DB.exec("UPDATE nx_settings SET value=? WHERE key='panel'",JSON.stringify(p));
  const res=await worker.fetch(new Request('https://node.example.test/sync/ws',{headers:{Upgrade:'websocket'}}),x.env,{});assert.equal(res.status,503);assert.equal(connections.length,0);
});

test('malformed early data returns before creating lifetime/flush timers',async t=>{
  const x=await fixture();t.after(()=>x.DB.close());const connections=cloudflareFakes(t);
  const original=globalThis.setInterval,intervals=[];t.mock.method(globalThis,'setInterval',(...args)=>{const id=original(...args);intervals.push(id);return id;});t.after(()=>intervals.forEach(clearInterval));
  const response=await worker.fetch(new Request('https://node.example.test/sync/ws',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'%'}}),x.env,{waitUntil(){}});
  assert.equal(response.status,400);assert.equal(intervals.length,0);assert.equal(connections.length,0);
});
