// Browser test of actual storefront/panel modules. Everything external is blocked.
const path=require('node:path'),assert=require('node:assert/strict');
async function run({chromium,root=path.resolve(__dirname,'..')}){
 const names=[],ok=(n,v)=>{assert.ok(v,n);names.push(n);};
 const server=await require('./serve.cjs')(root,0),port=server.address().port,base=`http://127.0.0.1:${port}`;
 let browser;try{
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 for(const width of [390,1440]){
  const ctx=await browser.newContext({viewport:{width,height:900}});const external=[];
  await ctx.addInitScript(()=>{localStorage.setItem('sb-127-auth-token',JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111'}}));localStorage.setItem('povmatero-no-track','1');});
  await ctx.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==base){external.push(url.origin);return route.abort();}
   const js=body=>route.fulfill({contentType:'application/javascript',body});
   if(url.pathname==='/js/lib/supabaseConfig.js')return js(`export const SUPABASE_URL='${base}/fake',SUPABASE_PUBLISHABLE_KEY='fake';`);
   if(url.pathname==='/js/lib/supabaseClient.js')return js(`
    const session={user:{id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid'}};
    window.__calls=[];window.__alerts=localStorage.getItem('__legacy')?[{variant_id:1,email_consent_at:null}]:[];
    const profile={first_name:'Cliente',last_name:'Ficticio',phone:'11 5555 1234',email:'fixture@example.invalid'};
    export const supabase={auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
     from(t){const b={select(){return b},eq(){return b},order(){return b},limit(){return b},maybeSingle:async()=>({data:t==='admin_users'?{role:'owner'}:profile}),then(resolve){return Promise.resolve({data:t==='restock_requests'?window.__alerts:[]}).then(resolve)}};return b},
     async rpc(name,args){window.__calls.push({name,args});if(name==='request_restock_alert'){if(args.email_consent===true)window.__alerts=[{variant_id:args.variant_id,email_consent_at:new Date().toISOString()}];return {data:{id:1,status:'activa'}}}if(name==='cancel_restock_alert'){window.__alerts=[];return {data:true}}if(name==='admin_restock_alerts')return {data:[{id:1,due:true,variant_id:1,product_name:'Yerba ficticia',variant_name:'500 g',customer_name:'Cliente ficticio',created_at:new Date().toISOString()}]};return {data:[]}}};`);
   if(url.pathname==='/fake/rest/v1/storefront_catalog')return route.fulfill({json:[{product_id:1,product_slug:'fixture',product_name:'Canarias Ficticia',brand:'Canarias',variant_id:1,variant_name:'500gr',price:1000,track_stock:true,stock:0,product_sort:0,variant_sort:0,shelf_position:0,brand_position:0}]});
   if(url.pathname==='/test-panel.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
   if(url.pathname==='/api/track')return route.fulfill({status:204});
   return route.continue();
  });
  const page=await ctx.newPage();const errors=[],externalResponses=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('response',response=>{if(new URL(response.url()).origin!==base)externalResponses.push(response.url());});
  const open=async()=>{await page.goto(base+'/yerbas');await page.locator('.y-variant[data-variant="1"]').first().click();await page.waitForSelector('#productSheet.open [data-notify-consent]');};
  await open();
  ok(`${width}: explica correo, no reserva y cancelación`,/correo/.test(await page.textContent('#productSheet'))&&/No reserva stock/.test(await page.textContent('#productSheet'))&&/cancelarlo/.test(await page.textContent('#productSheet')));
  ok(`${width}: casilla desmarcada`,!await page.isChecked('#productSheet [data-notify-consent]'));
  await page.click('#productSheet [data-notify]');
  ok(`${width}: sin aceptar no hay RPC`,(await page.evaluate(()=>window.__calls.filter(c=>c.name==='request_restock_alert').length))===0);
  await page.check('#productSheet [data-notify-consent]');await page.click('#productSheet [data-notify]');await page.waitForSelector('#productSheet .y-notify.is-on');
  ok(`${width}: consentimiento true explícito en RPC`,await page.evaluate(()=>window.__calls.find(c=>c.name==='request_restock_alert')?.args.email_consent===true));
  await page.click('#productSheet [data-notify-cancel]');await page.waitForSelector('#productSheet [data-notify-consent]');
  ok(`${width}: puede cancelar y nueva casilla sigue desmarcada`,!await page.isChecked('#productSheet [data-notify-consent]'));
  await page.evaluate(()=>localStorage.setItem('__legacy','yes'));await open();
  ok(`${width}: histórica requiere aceptación nueva`,/aviso anterior necesita/.test(await page.textContent('#productSheet'))&&!await page.isChecked('#productSheet [data-notify-consent]'));
  await page.click('#productSheet [data-notify]');ok(`${width}: histórica no se renueva sin aceptar`,await page.evaluate(()=>window.__calls.every(c=>c.name!=='request_restock_alert')));
  await page.check('#productSheet [data-notify-consent]');await page.click('#productSheet [data-notify]');await page.waitForSelector('#productSheet .y-notify.is-on');
  ok(`${width}: histórica se renueva con consentimiento true`,await page.evaluate(()=>window.__calls.find(c=>c.name==='request_restock_alert')?.args.email_consent===true));
  await page.goto(base+'/test-panel.html');await page.evaluate(async()=>{const m=await import('/admin/js/views/restockAlerts.js');await m.renderRestockAlerts(document.body);});await page.waitForSelector('.alert-row');
  ok(`${width}: panel sin botón manual revocado`,!await page.getByRole('button',{name:/Marcar avisado/i}).count()&&!await page.evaluate(()=>window.__calls.some(c=>c.name==='admin_mark_restock_notified')));
  ok(`${width}: sin errores JS`,errors.length===0);
  ok(`${width}: cero respuestas externas; intentos externos bloqueados`,externalResponses.length===0);
  await ctx.close();
 }
 return {checks:names.length,failures:0,names};
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
module.exports={run};
if(require.main===module){const {chromium}=require(require.resolve('playwright-core',{paths:[process.env.PW||__dirname]}));run({chromium}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
