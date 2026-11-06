// Preload: node -r ./tests/offline-browser.cjs tests/<browser-test>.cjs <repo> <tmp-output>
// No external browser networking; catalog fixtures replace legacy Route.fetch calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const dep=process.env.PW;if(!dep)throw Error('PW must point to the test dependency directory');
const network=require(path.join(dep,'node_modules/playwright-core/lib/client/network.js'));
const {Browser}=require(path.join(dep,'node_modules/playwright-core/lib/client/browser.js'));
const {BrowserType}=require(path.join(dep,'node_modules/playwright-core/lib/client/browserType.js'));
const cacheDir=process.env.BROWSER_SDK_DIR||path.join(os.tmpdir(),'povmatero-browser-sdk-2.117.3');
const map=JSON.parse(fs.readFileSync(path.join(cacheDir,'map.json'),'utf8').replace(/^\uFEFF/,''));
const sdk=Object.fromEntries(Object.entries(map).map(([url,file])=>[url,fs.readFileSync(file,'utf8')]));
const fontDir=process.env.BROWSER_FONT_DIR||path.join(os.tmpdir(),'povmatero-browser-font');
const fontCss=fs.existsSync(path.join(fontDir,'inter.css'))?fs.readFileSync(path.join(fontDir,'inter.css'),'utf8'):null;
const fontUrls=new Set(fontCss?.match(/https:\/\/fonts\.gstatic\.com\/s\/inter\/[^)\s]+/g)||[]);
const state=require('./mock-sb.cjs').catalogState();
const catalog=state.variants.flatMap(v=>{const p=state.products.find(p=>p.id===v.product_id);return p?.is_active&&p.category_id===5?[{product_id:p.id,product_slug:p.slug,product_name:p.name,description:p.description,brand:p.brand,category_slug:'yerbas',category_name:'Yerbas',variant_id:v.id,variant_name:v.name,price:v.price,stock:v.stock,track_stock:true,product_sort:0,variant_sort:v.sort_order,cover_image:null,shelf_image:null,variant_shelf_image:null,shelf_position:0,brand_position:0}]:[];});
const storefront=[...catalog,...state.variants.flatMap(v=>{const p=state.products.find(p=>p.id===v.product_id),c=state.categories.find(c=>c.id===p?.category_id);return p?.is_active&&p.category_id!==5?[{product_id:p.id,product_slug:p.slug,product_name:p.name,description:p.description,category_slug:c.slug,category_name:c.name,variant_id:v.id,variant_name:v.name,price:v.price,stock:v.stock,track_stock:true,product_sort:0,variant_sort:v.sort_order,cover_image:null}]:[];})];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6kwAAAAASUVORK5CYII=','base64');
const local=url=>['localhost','127.0.0.1'].includes(url.hostname);
const previousContinue=network.Route.prototype.continue,previousFetch=network.Route.prototype.fetch;
network.Route.prototype.continue=async function(options){
 const req=this.request(),url=new URL(req.url());if(local(url))return previousContinue.call(this,options);
 if(url.hostname==='cdn.jsdelivr.net'&&sdk[url.pathname])return this.fulfill({contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:sdk[url.pathname]});
 if(url.hostname==='fonts.googleapis.com'&&fontCss)return this.fulfill({contentType:'text/css',body:fontCss});
 if(fontUrls.has(url.href))return this.fulfill({contentType:'font/ttf',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(fontDir,path.basename(url.pathname)))});
 if(req.method()==='GET'&&url.hostname.endsWith('.supabase.co')){
  if(url.pathname==='/rest/v1/storefront_catalog')return this.fulfill({json:url.searchParams.get('category_slug')==='eq.yerbas'?catalog:storefront});
  if(url.pathname==='/rest/v1/categories')return this.fulfill({json:state.categories});
  if(url.pathname==='/rest/v1/storefront_gallery')return this.fulfill({json:[]});
 }
 if(req.resourceType()==='image')return this.fulfill({contentType:'image/png',body:png});return this.abort();
};
network.Route.prototype.fetch=async function(options){
 const url=new URL(options?.url||this.request().url());
 if(url.hostname.endsWith('.supabase.co')&&url.pathname==='/rest/v1/storefront_catalog')return{json:async()=>catalog,text:async()=>JSON.stringify(catalog),status:()=>200,ok:()=>true,headers:()=>({'content-type':'application/json'})};
 if(!local(url))throw Error('External Route.fetch blocked by offline-browser');return previousFetch.call(this,options);
};
const attach=async ctx=>{await ctx.route('**/*',route=>route.continue());return ctx;};
const previousContext=Browser.prototype.newContext;
Browser.prototype.newContext=async function(options){return attach(await previousContext.call(this,options));};
const previousPersistent=BrowserType.prototype.launchPersistentContext;
BrowserType.prototype.launchPersistentContext=async function(dir,options){return attach(await previousPersistent.call(this,dir,options));};
