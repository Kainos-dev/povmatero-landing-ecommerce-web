// Actual checkout modules, local server and fake backend. No external SDK/network.
const path=require('node:path'),assert=require('node:assert/strict');
async function run({chromium,root=path.resolve(__dirname,'..')}){
 const names=[],ok=(n,v)=>{assert.ok(v,n);names.push(n);};
 const server=await require('./serve.cjs')(root,0),base=`http://127.0.0.1:${server.address().port}`;let browser;
 const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
 const state={orders:new Map(),posts:[],mode:'ok',queriesDown:false,release:null};
 const cartKey=u=>`povmatero-yerbas-v1:u:${u}`;
 try{
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 await ctx.addInitScript(({A,key})=>{if(!localStorage.getItem('__seeded')){localStorage.setItem('__seeded','1');localStorage.setItem('sb-127-auth-token',JSON.stringify({user:{id:A}}));localStorage.setItem(key,JSON.stringify([{variant_id:1,qty:2}]));}localStorage.setItem('povmatero-no-track','1');},{A,key:cartKey(A)});
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==base)return route.abort();
  const js=body=>route.fulfill({contentType:'application/javascript',body}),json=body=>route.fulfill({json:body});
  if(url.pathname==='/js/lib/supabaseConfig.js')return js(`export const SUPABASE_URL='${base}/fake',SUPABASE_PUBLISHABLE_KEY='fake';`);
  if(url.pathname==='/js/lib/supabaseClient.js')return js(`
   const current=()=>{const s=JSON.parse(localStorage.getItem('sb-127-auth-token')||'null');return s?{...s,access_token:'fixture-'+s.user.id}:null};
   const profile={phone:'11 5555 1234',first_name:'Cliente',last_name:'Ficticio'};
   export const supabase={auth:{getSession:async()=>({data:{session:current()}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    from(t){const filters={};const b={select(){return b},eq(k,v){filters[k]=v;return b},order(){return b},limit(){return b},gte(){return b},async maybeSingle(){if(t==='orders'){const r=await fetch('/__query?'+new URLSearchParams(filters));const d=await r.json();return r.ok?{data:d}:{error:{message:'fixture offline'}}}return {data:profile}},then(resolve){return Promise.resolve({data:[]}).then(resolve)}};return b},
    async rpc(name,args){const r=await fetch('/__rpc/'+name,{method:'POST',body:JSON.stringify({args,user:current()?.user.id})});return {data:await r.json()}}};`);
  if(url.pathname==='/fake/rest/v1/storefront_catalog')return json([{product_id:1,product_slug:'fixture',product_name:'Canarias Ficticia',brand:'Canarias',variant_id:1,variant_name:'500gr',price:1000,stock:20,track_stock:true,product_sort:0,variant_sort:0,shelf_position:0,brand_position:0}]);
  if(url.pathname==='/__query'){
   if(state.queriesDown)return route.fulfill({status:500,json:{message:'offline'}});
   const r=[...state.orders.values()].find(o=>o.customer_id===url.searchParams.get('customer_id')&&o.client_key===url.searchParams.get('client_key'));
   return json(r?{...r,order_items:r.items}:null);
  }
  if(url.pathname.startsWith('/__rpc/')||url.pathname==='/fake/rest/v1/rpc/create_yerba_order'){
   const raw=JSON.parse(req.postData());
   const args=raw.args??raw,user=raw.user??req.headers().authorization?.replace('Bearer fixture-','');if(!url.pathname.endsWith('/create_yerba_order'))return json(true);
   state.posts.push({key:args.client_key,user,items:args.items});
   let o=state.orders.get(args.client_key),repeated=!!o;
   if(!o){o={id:state.orders.size+1,customer_id:user,client_key:args.client_key,public_code:'PV-'+String(state.orders.size+1).padStart(10,'0'),kind:'yerbas',status:'pendiente',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+12*3600000).toISOString(),total:args.items[0].quantity*1000,item_count:args.items[0].quantity,items:args.items.map(i=>({...i,product_name:'Yerba ficticia',variant_name:'500 g',line_total:i.quantity*1000}))};state.orders.set(args.client_key,o);}
   const mode=state.mode;state.mode='ok';if(mode==='lost'){state.queriesDown=true;return route.abort('failed');}
   if(mode==='delay')await new Promise(resolve=>state.release=resolve);
   return json({...o,repeated});
  }
  if(url.pathname==='/api/track')return route.fulfill({status:204});return route.continue();
 });
 const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const load=async p=>{await p.goto(base+'/yerbas');await p.waitForSelector('.y-variant');};
 const open=async p=>{if(await p.locator('#cartSheet.open').count())await p.locator('#cartSheet [data-close]').first().click();await p.click('#cartDock');await p.waitForSelector('#cartSheet.open [data-send]');};
 const putCart=async(p,user,qty)=>p.evaluate(({user,qty})=>{
  localStorage.setItem('sb-127-auth-token',JSON.stringify({user:{id:user}}));document.dispatchEvent(new Event('povmatero:signed-in'));
  const key='povmatero-yerbas-v1:u:'+user;localStorage.setItem(key,JSON.stringify([{variant_id:1,qty}]));localStorage.setItem(key+':revision',crypto.randomUUID());window.dispatchEvent(new StorageEvent('storage',{key}));
 },{user,qty});
 const waitPosts=async n=>{for(let i=0;i<100&&state.posts.length<n;i++)await new Promise(r=>setTimeout(r,10));assert.ok(state.posts.length>=n,'checkout request started');};
 await load(page);await open(page);state.mode='lost';await page.click('[data-send]');await page.waitForFunction(()=>document.querySelector('.y-msg')?.textContent.includes('No pudimos confirmar'));
 ok('Respuesta perdida deja un solo pedido',state.orders.size===1);
 await page.evaluate(()=>{const now=Date.now();Date.now=()=>now+7*3600000;});state.queriesDown=false;
 await page.click('[data-send]');await page.waitForSelector('.y-sent');
 ok('Reintento a 7 h conserva clave y pedido',state.orders.size===1&&state.posts.length===2&&state.posts[0].key===state.posts[1].key);
 ok('La recuperación no promete renovar la reserva',/no creamos otro ni renovamos/.test(await page.textContent('.y-sent')));
 await page.click('[data-close]');await putCart(page,A,2);await open(page);await page.click('[data-send]');await page.waitForSelector('.y-sent');
 ok('Segunda compra del mismo carrito usa nueva operación',state.orders.size===2&&state.posts[2].key!==state.posts[0].key);
 await page.click('[data-close]');await putCart(page,A,2);await open(page);state.mode='lost';await page.click('[data-send]');await page.waitForFunction(()=>document.querySelector('.y-msg')?.textContent.includes('No pudimos confirmar'));const postsBeforeReload=state.posts.length;state.queriesDown=false;
 await load(page);await page.waitForSelector('.y-sent');ok('Recarga recupera por client_key sin otro POST',state.posts.length===postsBeforeReload&&state.orders.size===3);
 await page.click('[data-close]');await putCart(page,A,2);await open(page);state.mode='delay';await page.evaluate(()=>document.querySelector('[data-send]').click());await waitPosts(postsBeforeReload+1);
 await putCart(page,B,5);state.release();state.release=null;await page.waitForTimeout(100);
 ok('Respuesta de A no vacía carrito de B',await page.evaluate(key=>JSON.parse(localStorage.getItem(key))[0].qty,cartKey(B))===5);
 ok('Respuesta de A no muestra su código a B',!await page.locator('.y-sent').count());
 await putCart(page,A,2);await open(page);state.mode='delay';const postBeforeEdit=state.posts.length;await page.evaluate(()=>document.querySelector('[data-send]').click());await waitPosts(postBeforeEdit+1);
 await putCart(page,A,3);state.release();state.release=null;await page.waitForTimeout(100);ok('Respuesta tardía conserva modificaciones posteriores del carrito',await page.evaluate(key=>JSON.parse(localStorage.getItem(key))[0].qty,cartKey(A))===3);
 // Two tabs, same shared cart: the second rereads it after acquiring Web Locks.
 await page.click('[data-close]');await putCart(page,A,2);const second=await ctx.newPage();await load(second);await open(page);await open(second);state.mode='delay';const postBeforeTabs=state.posts.length;
 await Promise.all([page.evaluate(()=>document.querySelector('[data-send]').click()),second.evaluate(()=>document.querySelector('[data-send]').click())]);await waitPosts(postBeforeTabs+1);await page.waitForTimeout(50);state.release();state.release=null;await page.waitForTimeout(200);
 ok('Dos pestañas simultáneas realizan un solo POST',state.posts.length===postBeforeTabs+1);
 ok('No hay errores de JavaScript en checkout',errors.length===0);
 await ctx.close();return{checks:names.length,failures:0,names};
 }finally{if(state.release)state.release();if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
module.exports={run};if(require.main===module){const {chromium}=require(require.resolve('playwright-core',{paths:[process.env.PW||__dirname]}));run({chromium}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
