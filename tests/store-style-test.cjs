// Offline browser regression: real store modules, fictional catalog, no remote writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PW+'/node_modules/playwright-core');
const serve=require('./serve.cjs');
const ROOT=path.resolve(__dirname,'..'),OUT=process.env.STYLE_TEST_OUT||path.join(ROOT,'.release-local/store-style');
const baseline=process.argv.includes('--baseline'),record={};let checks=0;
const {execFileSync}=require('node:child_process');
const {PNG}=require(require.resolve('pngjs',{paths:[path.dirname(process.execPath),process.env.PW]}));
const cssFiles=['css/components/productCard.css','css/layout/header.css','css/pages/product.css','css/responsive/responsive.css'];
// The pre-change CSS is read from history, never checked out over local files.
const originalCss=baseline?new Map(cssFiles.map(file=>['/'+file,execFileSync('git',['-c',`safe.directory=${ROOT}`,'show',`93cef99:${file}`],{cwd:ROOT,encoding:'utf8'})])):null;
function shadowLayers(value){return value.split(/,(?![^(]*\))/).map(layer=>{
 const color=layer.match(/rgba?\(([^)]+)\)/)?.[1].split(',').map(Number)||[];
 const lengths=layer.replace(/rgba?\([^)]+\)/,'').trim().split(/\s+/).map(parseFloat);
 return {alpha:color.length===4?color[3]:1,y:lengths[1]||0,blur:lengths[2]||0,spread:lengths[3]||0};
}).filter(layer=>layer.blur>0);}
const shadowStrength=value=>shadowLayers(value).reduce((sum,layer)=>sum+layer.alpha,0);
async function sideLuma(page,card){
 const r=await card.boundingBox(),clip={x:Math.floor(r.x-12),y:Math.floor(r.y+r.height*.5),width:10,height:20};
 const png=PNG.sync.read(await page.screenshot({clip}));const x=Math.round(r.x-clip.x-5);let sum=0;
 for(let y=0;y<png.height;y++){const i=(y*png.width+x)*4;sum+=.2126*png.data[i]+.7152*png.data[i+1]+.0722*png.data[i+2];}
 return sum/png.height;
}
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const rows=Array.from({length:12},(_,i)=>({product_id:i+1,product_slug:'fixture-'+(i+1),product_name:i<10?'Mate ficticio '+(i+1):'Yerba ficticia '+(i+1),
 description:'Producto de prueba local',category_slug:i<10?'mates':'yerbas',category_name:i<10?'Mates':'Yerbas',brand:i<10?null:'Ficticia',
 variant_id:i+101,variant_name:i<10?'Único':'500gr',price:5000+i*100,stock:8,track_stock:true,
 product_sort:i,variant_sort:0,cover_image:'/__style-image/'+i+'.svg',variant_image:null,shelf_image:null,variant_shelf_image:null}));
async function main(){
 if(!baseline)execFileSync(process.execPath,['-r',path.join(__dirname,'offline-browser.cjs'),__filename,'--baseline'],{env:process.env,stdio:'pipe'});
 fs.mkdirSync(OUT,{recursive:true});const server=await serve(ROOT,0),base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  for(const width of [320,360,390,768,1024,1440,1920]){
   const touch=width<769,ctx=await browser.newContext({viewport:{width,height:1000},isMobile:width<640,hasTouch:touch});
   const errors=[],writes=[];
   if(baseline)await ctx.route('**/*.css',r=>{const source=originalCss.get(new URL(r.request().url()).pathname);return source?r.fulfill({contentType:'text/css',body:source}):r.continue();});
   await ctx.addInitScript(()=>{localStorage.setItem('povmatero-no-track','1');Math.random=()=>0.5;});
   await ctx.route('**/api/track',r=>r.fulfill({status:204}));
   await ctx.route('https://gubrehbalkfvzwsndbcv.supabase.co/**',async r=>{
    const req=r.request(),url=new URL(req.url());if(req.method()!=='GET'){writes.push(req.method());return r.abort();}
    let data=[];
    if(url.pathname.endsWith('/storefront_catalog'))data=rows.filter(x=>!url.searchParams.get('category_slug')||url.searchParams.get('category_slug')==='eq.'+x.category_slug);
    if(url.pathname.endsWith('/categories'))data=[{slug:'mates',sort_order:1},{slug:'yerbas',sort_order:2}];
    if(url.pathname.endsWith('/product_images'))data=rows.flatMap(x=>[0,1].map(i=>({product_id:x.product_id,src:'/__style-image/'+x.product_id+'-'+i+'.svg',is_cover:i===0,sort_order:i})));
    return r.fulfill({json:data});
   });
   await ctx.route('**/__style-image/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#ddd1bd"/><circle cx="300" cy="200" r="110" fill="#6b5948"/></svg>'}));
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base);await page.locator('.product-grid .card-name').first().waitFor();await page.waitForTimeout(900);
   await page.waitForFunction(()=>{const intro=document.getElementById('preloader');return !intro||getComputedStyle(intro).display==='none'||Number(getComputedStyle(intro).opacity)<0.01;},null,{timeout:8000});
   // The storefront normally links yerbas to its separate gondola. Exercise the
   // shared card factory explicitly to verify its excluded variant as well.
   await page.evaluate(async()=>{const {createProductCard}=await import('/js/components/catalog.js');
    document.querySelector('.product-grid').append(createProductCard({id:11,slug:'fixture-11',name:'Yerba ficticia',category:'yerbas',image:'/__style-image/11.svg',price:5000,variants:[{name:'500gr',price:5000}]}));});
   const card=page.locator('.product-grid .product-card:not(.product-card--yerba)').first();
   const style=await card.evaluate(el=>({shadow:getComputedStyle(el).boxShadow,radius:getComputedStyle(el).borderRadius}));
   const yerba=await page.locator('.product-grid .product-card--yerba').first().evaluate(el=>({shadow:getComputedStyle(el).boxShadow,radius:getComputedStyle(el).borderRadius}));
   if(!baseline){ok(style.shadow.includes('rgb(55, 39, 29)'),width+': permanent original brown');ok(style.radius==='20px',width+': rounded card');ok(shadowLayers(style.shadow).length===2,width+': layered resting shadow');}
   await card.scrollIntoViewIfNeeded();
   style.sideLuma5=await sideLuma(page,card);
   if(!touch){await card.hover();await page.waitForTimeout(550);ok(await card.evaluate(el=>el.classList.contains('is-lifted')),width+': mouse lift');
    if(!baseline)ok(shadowStrength(await card.evaluate(el=>getComputedStyle(el).boxShadow))>shadowStrength(style.shadow),width+': stronger hover shadow');
    await page.mouse.move(1,1);await page.waitForTimeout(550);
   }else ok(!(await card.evaluate(el=>el.classList.contains('is-lifted'))),width+': no sticky touch lift');
   await page.keyboard.press('Tab');await card.locator('.card-name a').focus();ok(await card.evaluate(el=>getComputedStyle(el).outlineStyle!=='none'),width+': keyboard focus');
   await page.locator('.catalog-section').evaluate(el=>window.scrollTo(0,el.offsetTop-80));await page.waitForTimeout(100);
   await page.screenshot({path:path.join(OUT,`${baseline?'before':'after'}-catalog-${width}.png`)});
   await page.goto(base+'/producto/fixture-1');await page.locator('.pdp .modal-title').waitFor();await page.waitForTimeout(900);
   const metrics=await page.evaluate(()=>{
    const rect=sel=>{const e=document.querySelector(sel),r=e.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width,height:r.height};};
    const header=document.querySelector('.header-inner'),h=getComputedStyle(header),hr=header.getBoundingClientRect();
    const track=document.querySelector('.pdp-related-track'),t=getComputedStyle(track),c=track.querySelector('.product-card');
    const image=document.querySelector('.pdp .modal-stage');
    return{headerLeft:hr.left+parseFloat(h.paddingLeft),headerRight:hr.right-parseFloat(h.paddingRight),detail:rect('.pdp-detail'),
     track:rect('.pdp-related-track'),gap:t.gap,cardWidth:c.getBoundingClientRect().width,cardBasis:getComputedStyle(c).flexBasis,
     image:rect('.pdp .modal-stage'),panel:rect('.pdp .modal-info'),imageFit:getComputedStyle(image.querySelector('img')).objectFit,
     overflow:document.documentElement.scrollWidth-innerWidth};
   });
   if(!baseline){ok(Math.abs(metrics.headerLeft-metrics.detail.x)<1&&Math.abs(metrics.headerRight-metrics.detail.right)<1,width+': detail aligned with navbar content');}
   if(!baseline){
    const layers=shadowLayers(style.shadow),below=Math.max(...layers.map(s=>s.y+s.blur+s.spread)),above=Math.max(4,...layers.map(s=>s.blur+s.spread-s.y));
    ok(await page.locator('.pdp-related-track .product-card:not(.product-card--yerba)').first().evaluate((el,{below,above})=>{
     const card=el.getBoundingClientRect(),track=el.parentElement.getBoundingClientRect();
     return card.top-track.top>=above&&track.bottom-card.bottom>=below;
    },{below,above}),width+': carousel has vertical clearance for shadow/focus');
   }
   if(!baseline&&!touch){
    await page.evaluate(()=>{const card=[...document.querySelectorAll('.pdp-related-track .product-card:not(.product-card--yerba)')].find(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;});if(card)card.dataset.shadowProbe='true';});
    const related=page.locator('[data-shadow-probe="true"]');await related.hover();await page.waitForTimeout(550);
    const hovered=await related.evaluate(el=>({shadow:getComputedStyle(el).boxShadow,top:el.getBoundingClientRect().top-el.parentElement.getBoundingClientRect().top,bottom:el.parentElement.getBoundingClientRect().bottom-el.getBoundingClientRect().bottom,lifted:el.classList.contains('is-lifted')}));
    const layers=shadowLayers(hovered.shadow);
    ok(hovered.lifted&&hovered.top>=Math.max(...layers.map(s=>s.blur+s.spread-s.y))&&hovered.bottom>=Math.max(...layers.map(s=>s.y+s.blur+s.spread)),width+': carousel hover shadow is not vertically clipped');
    await page.mouse.move(1,1);await page.waitForTimeout(550);
   }
   ok(metrics.overflow<=1,width+': no horizontal overflow');ok(metrics.imageFit==='contain',width+': photo not cropped');
   if(width>768)ok(Math.abs(metrics.image.width/metrics.panel.width-1.3)<0.02,width+': preserved photo/panel ratio');
   const thumbs=page.locator('.pdp .modal-thumb');ok(await thumbs.count()>=2,width+': gallery retained');
   await thumbs.nth(1).click();ok(await thumbs.nth(1).getAttribute('aria-pressed')==='true',width+': gallery changes photo');
   await page.locator('.pdp [data-role="add"]').click();await page.locator('.cart-item').first().waitFor();
   await page.locator('#cartBtn').click();await page.waitForTimeout(450);
   ok(await page.locator('.cart-item').count()===1,width+': cart add');
   await page.locator('.cart-item-remove').click();ok(await page.locator('.cart-item').count()===0,width+': cart remove');
   await page.locator('#cartClose').click();await page.waitForTimeout(450);
   ok(await page.locator('#cartPanel').evaluate(el=>!el.classList.contains('open')&&el.getBoundingClientRect().left>=innerWidth-1),width+': cart closes fully');
   await page.screenshot({path:path.join(OUT,`${baseline?'before':'after'}-product-${width}.png`),fullPage:true});
   record[width]={metrics,yerba,style};
   if(!baseline){const previous=JSON.parse(fs.readFileSync(path.join(OUT,'baseline.json'),'utf8'))[width];
    ok(Math.abs(previous.metrics.track.width-metrics.track.width)<1&&Math.abs(previous.metrics.track.x-metrics.track.x)<1,width+': carousel width/position unchanged');
    ok(previous.metrics.gap===metrics.gap&&previous.metrics.cardBasis===metrics.cardBasis&&Math.abs(previous.metrics.cardWidth-metrics.cardWidth)<1,width+': carousel spacing/distribution unchanged');
    ok(style.sideLuma5<=previous.style.sideLuma5-8,width+': rendered side shadow is visibly darker than published version');
    ok(Math.abs(previous.metrics.detail.width-metrics.detail.width)<1&&Math.abs(previous.metrics.detail.x-metrics.detail.x)<1,width+': product layout unchanged');
    assert.deepEqual(yerba,previous.yerba);checks++;
   }
   if(!baseline&&!touch){
    await page.emulateMedia({reducedMotion:'reduce'});
    const related=page.locator('[data-shadow-probe="true"]');await related.hover();
    ok(await page.locator('.product-card:not(.product-card--yerba)').evaluateAll(cards=>cards.every(el=>getComputedStyle(el).transform==='none'&&getComputedStyle(el).transitionDuration==='0s')),width+': reduced motion stops card/neighbor transforms and transitions');
    await page.emulateMedia({reducedMotion:'no-preference'});await page.mouse.move(1,1);
   }
   ok(errors.length===0,width+': no JS errors '+errors.join(';'));ok(writes.length===0,width+': no remote writes');
   await ctx.close();
  }
  fs.writeFileSync(path.join(OUT,baseline?'baseline.json':'after.json'),JSON.stringify(record,null,2));
  console.log(JSON.stringify({mode:baseline?'baseline':'after',checks,failures:0,output:OUT}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
