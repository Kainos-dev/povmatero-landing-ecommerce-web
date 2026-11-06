const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
async function run({dir,root=path.resolve(__dirname,'..')}){
 const site=path.join(dir,'site'),manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8')),names=[];
 const ok=(name,value)=>{assert.ok(value,name);names.push(name);};
 for(const f of manifest.files)assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(site,f.path))).digest('hex'),f.sha256,'Hash '+f.path);
 ok('Todos los hashes del artefacto coinciden',manifest.files.length>200);
 ok('No incluye SQL, tests, .env, credenciales ni informes',manifest.files.every(f=>!/(^|\/)(supabase|tests|\.git|\.vercel|\.env[^/]*|\.release-local)(\/|$)|\.(md|sql|pem|key)$/i.test(f.path)));
 const critical=['js/yerbas/main.js','js/yerbas/api.js','js/yerbas/basket.js','js/yerbas/orderAttempts.js','js/lib/customerAuth.js','js/components/cart.js','js/components/accountPage.js','admin/js/api/orders.js','admin/js/api/stockTools.js','admin/js/views/orders.js','admin/js/views/orderDetail.js','admin/js/views/restockAlerts.js','api/restock-unsubscribe.js','api/cron-pedidos.js','vercel.json'];
 for(const f of critical)assert.deepEqual(await fs.readFile(path.join(site,f)),await fs.readFile(path.join(root,f)),'Critical compatibility: '+f);
 ok('Pedidos, códigos, reservas, idempotencia, consentimiento y cron conservados',true);
 const html=await fs.readFile(path.join(site,'admin/index.html'),'utf8'),router=await fs.readFile(path.join(site,'admin/js/router.js'),'utf8');
 ok('Rescate no ofrece integración opcional Push/PWA',!html.includes('#/notificaciones')&&!html.includes('rel="manifest"')&&!router.includes('renderNotifications'));
 const webpush=require(path.join(site,'api/_lib/webpush.js')),email=require(path.join(site,'api/_lib/restock-email.js')),sendPush=require(path.join(site,'api/push-send.js')),sendEmail=require(path.join(site,'api/restock-send.js')),config=require(path.join(site,'api/push-config.js'));
 const ecdh=crypto.createECDH('prime256v1');ecdh.generateKeys();
 const full={PUSH_ENABLED:'true',RESTOCK_EMAIL_ENABLED:'true',VAPID_PUBLIC_KEY:ecdh.getPublicKey().toString('base64url'),VAPID_PRIVATE_KEY:ecdh.getPrivateKey().toString('base64url'),VAPID_SUBJECT:'mailto:fixture@example.invalid',PUSH_WEBHOOK_SECRET:'x'.repeat(32),CRON_SECRET:'y'.repeat(32),SUPABASE_SECRET_KEY:'fake',RESEND_API_KEY:'fake',RESTOCK_EMAIL_FROM:'avisos@povmatero.com'};
 let calls=0;const deps={env:full,fetchImpl:async()=>{calls++;throw Error('No network permitted');}},res=()=>({statusCode:0,setHeader(){},end(){}});
 ok('Push bloqueado incluso con configuración completa y flag true',!webpush.pushEnabled(full)&&webpush.vapidKeys(full)===null&&(await webpush.dispatch({env:full,secretKey:'fake',vapid:{},fetchImpl:deps.fetchImpl})).disabled===true);
 ok('Email bloqueado incluso con configuración completa y flag true',(await email.dispatch(deps)).disabled===true);
 for(const [name,handler,method]of[['push-send',sendPush,'POST'],['push-config',config,'GET'],['restock-send',sendEmail,'GET'],['restock-send-post',sendEmail,'POST']]){const r=res();await handler({method,headers:{authorization:'Bearer '+(name.startsWith('push')?full.PUSH_WEBHOOK_SECRET:full.CRON_SECRET)}},r,deps);ok(name+' deshabilitado',r.statusCode===503);}
 ok('Cero claims o envíos externos',calls===0);
 return{checks:names.length,failures:0,names,filesVerified:manifest.files.length};
}
module.exports={run};if(require.main===module)run({dir:path.resolve(process.argv[2])}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
