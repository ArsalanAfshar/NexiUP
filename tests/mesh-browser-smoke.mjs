// Optional browser integration. Real local HTTPS/workerd/D1, no auto-login.
// The test proxy maps ONLY this browser origin to the disposable native manager.
// It does not modify CSP, relax authentication or use any production credentials.
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createMeshHarness} from './mesh-native-harness.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
await mkdir('.work',{recursive:true});const directory=await mkdtemp('.work/mesh-browser-');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{stdio:'ignore'});
const h=await createMeshHarness();let base,browser;
const server=createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},async(req,res)=>{
  try{
    const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>131072){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length','transfer-encoding'].includes(key))headers.set(key,Array.isArray(value)?value.join(', '):value);
    if(headers.get('origin')===base)headers.set('origin',h.origins.manager);
    const response=await h.mf.dispatchFetch(h.origins.manager+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
    const outgoing=Object.fromEntries(response.headers);delete outgoing['content-length'];res.writeHead(response.status,outgoing);res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"test_proxy_failure"}');}
});
await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));base='https://127.0.0.1:'+server.address().port;
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox','--no-zygote','--disable-dev-shm-usage','--disable-background-networking']});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1080}}),page=await context.newPage(),errors=[],outside=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!/Failed to load resource/.test(message.text()))errors.push(message.text());});
  page.on('request',request=>{const url=new URL(request.url());if(url.protocol==='https:'&&url.origin!==base)outside.push(url.origin);});
  await page.goto(base+'/');await page.waitForSelector('#login:not([hidden])');await page.evaluate(()=>document.fonts.ready);assert.ok(await page.evaluate(()=>document.fonts.check('12px Vazirmatn','فارسی')));
  await page.fill('#owner-key',h.owner);await page.click('[data-act="diagnostics"]');await page.waitForFunction(()=>document.getElementById('diagnostic-report').textContent.includes('read_only'));
  const diagnostic=JSON.parse(await page.locator('#diagnostic-report').textContent());assert.equal(diagnostic.read_only,true);assert.equal(diagnostic.ready,false);assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'nx3_%'").first()).n,0);
  await page.screenshot({path:'.work/mesh-login.png',fullPage:true,animations:'disabled'});
  await page.fill('#owner-key',h.owner);await page.click('#login-button');await page.waitForSelector('.hero');assert.equal(await page.inputValue('#owner-key'),'');assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  const cookie=(await context.cookies()).find(c=>c.name==='__Host-nexiup-mesh');assert.ok(cookie?.httpOnly&&cookie.secure);assert.equal(cookie.sameSite,'Strict');
  let response=await context.request.put(base+'/api/settings',{data:{public_origin:h.origins.manager,version:1},headers:{Origin:base}});assert.equal(response.status(),403);
  const nav=async(view,selector)=>{await page.click('[data-act="navigate"][data-view="'+view+'"]');await page.waitForSelector(selector);};
  await nav('settings','#public-origin');await page.fill('#public-origin',h.origins.manager);await page.click('#settings-form button');await page.waitForFunction(async()=>{const d=await fetch('/api/overview').then(r=>r.json());return d.public_origin==='https://manager.example.test';});
  await nav('nodes','[data-act="new-node"]');
  for(const [index,name] of ['node1','node2'].entries()){
    await page.locator('#actions [data-act="new-node"]').click();await page.fill('#node-id',name);await page.fill('#node-label',index?'نود دو · آزمایشی':'نود یک · آزمایشی');await page.fill('#node-origin',h.origins[name]);await page.fill('#node-key-ref',index?'NODE_KEY_TWO':'NODE_KEY_ONE');await page.fill('#node-country',index?'US':'DE');await page.click('#node-form button.primary');await page.waitForFunction(()=>!document.getElementById('modal').open);
    await page.waitForSelector('[data-act="test-node"][data-id="'+name+'"]');await page.click('[data-act="test-node"][data-id="'+name+'"]');
    await page.waitForFunction(node=>[...document.querySelectorAll('.node-card')].some(card=>card.querySelector('[data-act="test-node"][data-id="'+node+'"]')&&card.textContent.includes('API تست‌شده')),name);
    await page.click('[data-act="toggle-node"][data-id="'+name+'"]');await page.waitForFunction(node=>document.querySelector('[data-act="toggle-node"][data-id="'+node+'"]')?.textContent==='غیرفعال',name);
  }
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM nx3_nodes WHERE enabled=1 AND verified_at>0').first()).n,2);
  await page.screenshot({path:'.work/mesh-nodes.png',fullPage:true,animations:'disabled'});
  await nav('accounts','[data-act="new-account"]');await page.locator('#actions [data-act="new-account"]').click();await page.fill('#account-name','<img src=x onerror="window.__meshXss=1">');await page.selectOption('#account-protocol','both');await page.fill('#account-total','5');await page.fill('#account-daily','1');await page.fill('#account-days','30');await page.fill('#account-notes','Synthetic browser fixture, not a real customer');await page.click('#account-form button.primary');
  await page.waitForSelector('#subscription-link');assert.ok((await page.locator('#modal-title').textContent()).includes('<img'));assert.equal(await page.locator('#modal-title img').count(),0);assert.equal(await page.evaluate(()=>window.__meshXss),undefined);
  await page.waitForFunction(()=>document.querySelector('.qr-wrap img')?.naturalWidth>0);
  let account=await h.db.prepare('SELECT * FROM nx3_accounts').first();const originalUuid=account.uuid,originalToken=account.token,originalExpiry=account.expires_at;
  assert.equal(account.node_mode,'all');assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM nx3_accounts').first()).n,1);
  response=await context.request.get(base+'/sub/'+account.token+'?format=xray');assert.equal(response.status(),200);assert.equal((await response.json()).length,12);
  await page.screenshot({path:'.work/mesh-subscription.png',fullPage:true,animations:'disabled'});
  await page.click('[data-act="account-action"][data-action="renew"]');await page.fill('#renew-days','10');assert.equal(await page.isChecked('#renew-reset'),false);await page.click('#action-form button.primary');await page.waitForSelector('#subscription-link');
  account=await h.db.prepare('SELECT * FROM nx3_accounts').first();assert.equal(account.expires_at,originalExpiry+10*86400000);assert.equal(account.epoch,1);assert.equal(account.uuid,originalUuid);assert.equal(account.token,originalToken);
  await page.click('[data-act="account-action"][data-action="pause"]');await page.click('#action-form button.primary');await page.waitForSelector('[data-act="account-action"][data-action="resume"]');assert.equal((await h.db.prepare('SELECT status FROM nx3_accounts').first()).status,'paused');
  await page.waitForFunction(()=>document.querySelector('.qr-wrap img')?.naturalWidth>0); // Owner QR remains available for an inactive account.
  await page.click('[data-act="account-action"][data-action="resume"]');await page.click('#action-form button.primary');await page.waitForSelector('[data-act="account-action"][data-action="pause"]');
  await page.click('[data-act="edit-current"]');await page.selectOption('#account-mode','selected');await page.check('input[name="node"][value="node1"]');await page.click('#account-form button.primary');await page.waitForSelector('#subscription-link');
  account=await h.db.prepare('SELECT * FROM nx3_accounts').first();assert.equal(account.node_mode,'selected');assert.equal(account.uuid,originalUuid);response=await context.request.get(base+'/sub/'+account.token+'?format=xray');assert.equal((await response.json()).length,6);
  await page.click('#modal [data-act="close"]');await page.waitForSelector('tbody tr');assert.equal(await page.locator('tbody img').count(),0);
  await nav('profiles','.profile-grid');const hamrah=(await h.db.prepare("SELECT data FROM nx3_profiles WHERE id='hamrah'").first()).data;
  await page.click('[data-act="edit-profile"][data-id="irancell"]');const profile=JSON.parse(await page.inputValue('#profile-json'));profile.label='ویرایش آزمایشی مرورگر';await page.fill('#profile-json',JSON.stringify(profile,null,2));await page.click('#profile-form button.primary');await page.waitForFunction(()=>!document.getElementById('modal').open);
  assert.equal((await h.db.prepare("SELECT data FROM nx3_profiles WHERE id='hamrah'").first()).data,hamrah);await page.waitForSelector('[data-act="rollback-profile"][data-id="irancell"]:not([disabled])');await page.click('[data-act="rollback-profile"][data-id="irancell"]');await page.waitForFunction(async()=>{const d=await fetch('/api/profiles').then(r=>r.json());return d.items.find(x=>x.profile.id==='irancell').version===3;});
  await nav('overview','.hero');await page.screenshot({path:'.work/mesh-overview.png',fullPage:true,animations:'disabled'});
  await page.click('#language-button');await page.waitForFunction(()=>document.documentElement.lang==='en'&&document.getElementById('title').textContent==='Overview');assert.equal(await page.locator('html').getAttribute('dir'),'ltr');
  await page.click('#language-button');await page.waitForFunction(()=>document.documentElement.lang==='fa');await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.work/mesh-mobile.png',fullPage:true,animations:'disabled'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);assert.equal(await page.locator('#sidebar').evaluate(el=>getComputedStyle(el).visibility),'hidden');await page.click('.menu-icon');await page.click('[data-act="navigate"][data-view="guide"]');await page.waitForSelector('.steps');assert.equal(await page.locator('#sidebar').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  await page.setViewportSize({width:1440,height:1080});await page.click('[data-act="logout"]');await page.waitForSelector('#login:not([hidden])');assert.equal((await context.cookies()).filter(c=>c.name==='__Host-nexiup-mesh').length,0);assert.equal((await context.request.get(base+'/api/overview')).status(),401);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log('Mesh browser PASS: fresh read-only preflight, real secure login/CSRF/logout, origin setup, two bidirectionally tested/enabled nodes, account on all/selected nodes, XSS escaping, actual QR, renewal preserving UUID/usage, pause/resume, isolated profile save/rollback, FA/EN and 390px mobile.');
  console.log('No external assets, automatic login, iframe/CSP relaxations or production credentials.');
}catch(error){const page=browser?.contexts()[0]?.pages()[0];if(page){console.log('Safe browser state:',await page.evaluate(()=>({diagnostic:document.getElementById('diagnostic-report')?.textContent,login:document.getElementById('login-status')?.textContent,appHidden:document.getElementById('app')?.hidden})));await page.screenshot({path:'.work/mesh-browser-failure.png',fullPage:true});}throw error;}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await h.close();await rm(directory,{recursive:true,force:true});}
