// DEVELOPMENT ONLY. An original UI preview backed by real local workerd + D1.
// Synthetic records, disposable keys, no production data. Never deploy this proxy.
// PREVIEW_AUTO_LOGIN=1 bypasses login ONLY in this local Node wrapper, not in worker.js.
// Network-capable diagnostic routes are explicitly disabled; no fake live successes.
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { Miniflare, convertV4MiniflareOptions } = await import(process.env.MINIFLARE_MODULE || 'miniflare');

export async function createPreview({ port = 8787, autoLogin = false, tls = null } = {}) {
  const secret=()=>randomBytes(24).toString('hex');
  const bindings={ROLE:'all',ADMIN_IDS:'901',SETUP_KEY:secret(),MASTER_KEY:secret(),WEB_ADMIN_KEY:secret(),CALLBACK_SECRET:secret(),WEBHOOK_SECRET:secret(),NODE_KEY_US:secret(),NODE_KEY_TEST:secret()};
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'nexiup-preview',modules:true,scriptPath:new URL('../worker.js',import.meta.url).pathname,compatibilityDate:'2026-10-20',compatibilityFlags:['global_fetch_strictly_public'],d1Databases:['DB'],bindings,outboundService:()=>Response.json({error:'preview_network_disabled'},{status:503})}]}));
  for(let i=0;i<12;i++){
    const res=await mf.dispatchFetch('https://preview.example.test/setup',{method:'POST',headers:{Authorization:'Bearer '+bindings.SETUP_KEY,'Content-Type':'application/json'},body:JSON.stringify({action:'migrate'})});
    const d=await res.json();if(!res.ok)throw new Error(d.error);if(d.ready)break;if(i===11)throw new Error('Migration did not complete');
  }
  const db=await mf.getD1Database('DB');
  const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
  const at=Date.now(),DAY=86400000;
  await run("UPDATE nx_settings SET value=json_set(value,'$.main_url','https://preview.example.test','$.currency','تومان') WHERE key='bot'");
  const names=['آراد رضایی','سارا محمدی','کیان مرادی','زهرا احمدی','پارسا کریمی','نیلوفر نادری','مانی رحیمی','هانا امیری'];
  for(let i=0;i<names.length;i++)await run('INSERT INTO nx_users(id,name,username,lang,terms_at,balance,created_at,last_at) VALUES(?,?,?,?,?,?,?,?)',101+i,names[i],'preview_user_'+(i+1),'fa',at,150000*(i%3),at-(i+1)*DAY,at-i*3600000);
  const plans=[['essential','پایه',20,150000],['plus','پلاس',40,290000],['pro','حرفه‌ای',70,440000]].map(([id,name,total_gb,price])=>({id,name,total_gb,price,description:'دادهٔ نمایشی؛ پلن واقعی نیست',days:30,daily_gb:2,conn_limit:2,locations:['de','us'],enabled:true,reset_usage:false,max_configs:4}));
  for(const p of plans)await run('INSERT INTO nx_catalog(kind,id,data,enabled) VALUES(?,?,?,1)','plans',p.id,JSON.stringify(p));
  await run('INSERT INTO nx_catalog(kind,id,data,enabled) VALUES(?,?,?,0)','payments','demo',JSON.stringify({id:'demo',name:'پرداخت نمونه',details:'دادهٔ نمایشی؛ اطلاعات پرداخت واقعی نیست',instructions:'',enabled:false}));
  for(const n of [{id:'germany',label:'نود اصلی · آلمان',code:'de',purpose:'sales',local:1,key:''},{id:'united-states',label:'نود آمریکا',code:'us',purpose:'sales',local:0,key:'NODE_KEY_US'},{id:'test-node',label:'نود تست مستقل',code:'de',purpose:'test',local:0,key:'NODE_KEY_TEST'}])await run('INSERT INTO nx_nodes(id,code,label,base_url,api_route,api_key_ref,max_users,enabled,purpose,adapter,local,created_at) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)',n.id,n.code,n.label,'https://'+n.id+'.example.test','sync',n.key,30,n.purpose,'nexiup',n.local,at-10*DAY);
  for(let i=0;i<7;i++){
    const p=plans[i%3];await run('INSERT INTO nx_orders(id,user_id,plan_id,kind,location,snapshot,total,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)','demo_sale_'+i,101+i,p.id,'sale',i%2?'us':'de',JSON.stringify(p),p.price,'done',at-(6-i)*DAY,at+DAY);
  }
  for(let i=0;i<3;i++)await run('INSERT INTO nx_orders(id,user_id,plan_id,kind,location,snapshot,total,status,receipt,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)','pending_demo_'+i,101+i,plans[i].id,'sale','de',JSON.stringify(plans[i]),plans[i].price,'pending',JSON.stringify({type:'reference',note:'رسید نمونه برای نمایش رابط. هیچ پرداخت واقعی انجام نشده.'}),at-i*3600000,at+DAY);
  for(let i=0;i<8;i++){
    const id=randomUUID(),data={name:'preview_account_'+String(i+1).padStart(2,'0')+'_'+randomBytes(8).toString('hex'),trafficLimit:plans[i%3].total_gb,dailyLimit:2,expiryMs:at+(i+10)*DAY,notes:'Synthetic preview only',connLimit:2,maxConfigs:4,proxyIp:'',cleanIp:'',userNodes:'',userPanelUrl:'',userMode:'',userPorts:'',isPaused:i===6};
    await run('INSERT INTO nx_panel_users(id,name,data,created_at) VALUES(?,?,?,?)',id,data.name,JSON.stringify(data),at-i*DAY);
    await run('INSERT INTO nx_panel_usage(id,epoch,up,down,day,day_up,day_down) VALUES(?,0,?,?,?,?,?)',id,(i+1)*10000000,(i+1)*900000000,new Date(at).toISOString().slice(0,10),5000000,120000000);
    await run('INSERT INTO nx_subs(id,token,user_id,node_id,remote_id,name,limits,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)','demo_sub_'+i,randomBytes(16).toString('hex'),101+i,i%2?'united-states':'germany',id,data.name,JSON.stringify(plans[i%3]),i===6?'paused':'active',data.expiryMs,at-i*DAY);
  }
  const countries=['DE','US','NL','FI','GB','FR','SE','CA','JP','SG','AU','TR','AE','IN','CH','NO','CZ','PL','AT','IT'];
  for(let i=0;i<40;i++)await run('INSERT INTO nx_proxy_catalog(id,host,port,country,label,city,source,imported_at) VALUES(?,?,?,?,?,?,?,?)','198.51.100.'+(i+1)+':443','198.51.100.'+(i+1),443,countries[i%countries.length],'TEST-NET · نمونهٔ نمایشی','','synthetic_preview',at);
  for(const [i,action,target] of [[0,'preview_initialized','synthetic_data'],[1,'catalog_saved','plans:plus'],[2,'node_saved','germany'],[3,'proxy_import_finished','synthetic_fixture'],[4,'profile_validated','hamrah']])await run('INSERT INTO nx_audit(actor,action,target,detail,created_at) VALUES(?,?,?,?,?)','preview',action,target,'{}',at-i*720000);
  const handle=async(req,res)=>{
    try{
      const host=String(req.headers['x-forwarded-host']||req.headers.host||'localhost:'+port).split(',')[0].trim();
      const url=new URL(req.url,'https://'+host);if(url.pathname==='/')url.pathname='/admin';
      // Browsers never reach real catalog/checker/node services from this preview.
      if(['/admin/web-api/proxy/probe','/admin/web-api/proxy/sync','/admin/web-api/nodes/health','/admin/web-api/receipt','/webhook'].includes(url.pathname)||url.pathname.endsWith('/api/proxy-check')){
        res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'preview_network_disabled'}));return;
      }
      const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>1200000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const headers=new Headers();for(const [name,value]of Object.entries(req.headers)){if(value!==undefined&&!['host','connection','content-length','transfer-encoding'].includes(name))headers.set(name,Array.isArray(value)?value.join(', '):value);}
      // Model HTTPS at the Worker behind the dev proxy. Do not allow arbitrary origins.
      if(headers.get('origin')==='http://'+host)headers.set('origin','https://'+host);
      if(autoLogin&&url.pathname.startsWith('/admin/web-api/'))headers.set('Authorization','Bearer '+bindings.WEB_ADMIN_KEY);
      const result=await mf.dispatchFetch(url.toString(),{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
      const outputHeaders=Object.fromEntries(result.headers);
      // Allow Arena's iframe ONLY in this disposable dev wrapper. Production stays DENY.
      if(outputHeaders['content-security-policy'])outputHeaders['content-security-policy']=outputHeaders['content-security-policy'].replace("frame-ancestors 'none'",'frame-ancestors *');
      delete outputHeaders['x-frame-options'];
      let bytes=Buffer.from(await result.arrayBuffer());
      if(['/admin/web-api/session','/admin/web-api/login'].includes(url.pathname)&&result.ok){const data=JSON.parse(bytes.toString());bytes=Buffer.from(JSON.stringify({...data,preview:true,auto_login:autoLogin}));}
      delete outputHeaders['content-length'];res.writeHead(result.status,outputHeaders);res.end(bytes);
    }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'preview_internal_error'}));}
  };
  const server=tls?httpsServer(tls,handle):httpServer(handle);server.on('upgrade',(_req,socket)=>socket.destroy());
  await new Promise(resolve=>server.listen(port,'0.0.0.0',resolve));
  return {mf,db,server,bindings,close:async()=>{await new Promise(resolve=>server.close(resolve));await mf.dispose();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const preview=await createPreview({port:Number(process.env.PORT||8787),autoLogin:process.env.PREVIEW_AUTO_LOGIN==='1'});
  console.log('NexiUP development preview: synthetic data, live networking disabled.');
  console.log('Listening on 0.0.0.0:'+Number(process.env.PORT||8787));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await preview.close();process.exit(0);});
}
