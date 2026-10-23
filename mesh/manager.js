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
