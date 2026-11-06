// Fake keys and fetch only. Never contacts a push service or Supabase.
const path=require('node:path'),fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
async function run({root=path.resolve(__dirname,'..')}={}){
 const lib=require(path.join(root,'api/_lib/webpush.js')),handler=require(path.join(root,'api/push-send.js')),config=require(path.join(root,'api/push-config.js'));
 const names=[],ok=(n,v)=>{assert.ok(v,n);names.push(n);};
 const ecdh=crypto.createECDH('prime256v1');ecdh.generateKeys();
 const env={PUSH_ENABLED:'true',VAPID_PUBLIC_KEY:ecdh.getPublicKey().toString('base64url'),VAPID_PRIVATE_KEY:ecdh.getPrivateKey().toString('base64url'),VAPID_SUBJECT:'mailto:fixture@example.invalid',SUPABASE_SECRET_KEY:'fake',PUSH_WEBHOOK_SECRET:'x'.repeat(32)};
 const vapid=lib.vapidKeys(env),res=()=>({statusCode:0,setHeader(){},end(){}});
 for(const flag of [undefined,'false',false,'FALSE','TRUE','1','']){
  const off={...env,PUSH_ENABLED:flag};let calls=0;const fetchImpl=async()=>{calls++;throw Error('Forbidden');};
  ok(`PUSH_ENABLED=${String(flag)}: claves no habilitan`,lib.vapidKeys(off)===null);
  const r=res();config({method:'GET'},r,{env:off});ok(`Flag ${String(flag)}: configuración pública deshabilitada`,r.statusCode===503);
  const s=res();await handler({method:'POST',headers:{authorization:`Bearer ${env.PUSH_WEBHOOK_SECRET}`}},s,{env:off,fetchImpl});
  ok(`Flag ${String(flag)}: endpoint no reclama ni envía`,s.statusCode===503&&calls===0);
  ok(`Flag ${String(flag)}: worker directo no reclama ni envía`,(await lib.dispatch({supabaseUrl:'https://fake.invalid',secretKey:'fake',vapid,env:off,fetchImpl})).disabled===true&&calls===0);
 }
 for(const key of ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT'])ok(`Flag true con ${key} ausente sigue bloqueado`,lib.vapidKeys({...env,[key]:''})===null);
 let timed=false;const started=Date.now();try{await lib.dispatch({supabaseUrl:'https://fake.invalid',secretKey:'fake',vapid,env,rpcTimeoutMs:20,sendTimeoutMs:20,budgetMs:500,fetchImpl:()=>new Promise(()=>{})});}catch(e){timed=e.name==='AbortError';}ok('RPC que ignora abort no queda colgada',timed&&Date.now()-started<1000);
 timed=false;try{await lib.dispatch({supabaseUrl:'https://fake.invalid',secretKey:'fake',vapid,env,rpcTimeoutMs:20,budgetMs:500,fetchImpl:async()=>({ok:true,text:()=>new Promise(()=>{})})});}catch(e){timed=e.name==='AbortError';}ok('Timeout cubre también el cuerpo de la RPC',timed);
 const receiver=crypto.createECDH('prime256v1');receiver.generateKeys();
 const item=i=>({id:i,event_key:'order:'+i,endpoint:'https://fcm.googleapis.com/fcm/send/LOCAL_'+i,p256dh:receiver.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url'),payload:{title:'Fixture',body:'Local'}});
 let queue=[item(1),item(2),item(3)],reported=[],requested=[];
 const timeoutFetch=async(url,options)=>{
  if(url.endsWith('/push_claim')){requested.push(JSON.parse(options.body).p_limit);const rows=queue;queue=[];return{ok:true,text:async()=>JSON.stringify(rows)}}
  if(url.endsWith('/push_report')){reported.push(...JSON.parse(options.body).results);return{ok:true,text:async()=>'3'}}
  return new Promise(()=>{});
 };
 const totals=await lib.dispatch({supabaseUrl:'https://fake.invalid',secretKey:'fake',vapid,env,concurrency:100,batch:200,rpcTimeoutMs:20,sendTimeoutMs:20,budgetMs:500,fetchImpl:timeoutFetch});
 ok('Proveedores colgados se informan como reintento',totals.reintentar===3&&reported.length===3&&reported.every(r=>r.outcome==='reintentar'));
 ok('Claim nunca supera una ola de seis dispositivos',requested.every(n=>n<=6));
 let calls=0;await lib.dispatch({supabaseUrl:'https://fake.invalid',secretKey:'fake',vapid,env,budgetMs:0,fetchImpl:async()=>{calls++;throw Error('Forbidden')}});ok('Presupuesto agotado no reclama trabajos',calls===0);
 queue=Array.from({length:20},(_,i)=>item(i));let active=0,maxActive=0;
 await lib.dispatch({supabaseUrl:'https://fake.invalid',secretKey:'fake',vapid,env,batch:200,concurrency:100,fetchImpl:async(url,options)=>{
  if(url.endsWith('/push_claim')){const rows=queue.splice(0,JSON.parse(options.body).p_limit);return{ok:true,text:async()=>JSON.stringify(rows)}}
  if(url.endsWith('/push_report'))return{ok:true,text:async()=>'1'};
  active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setTimeout(r,5));active--;return{status:201};
 }});ok('Concurrencia real de proveedores limitada a seis',maxActive<=6&&queue.length===0);
 const source=fs.readFileSync(path.join(root,'admin/js/api/push.js'),'utf8').replace(/^import .*;\r?\n/m,'').replace(/export /g,'');let prompts=0,registrations=0;
 const box={fetch:async()=>({status:503}),Notification:{requestPermission(){prompts++;}},navigator:{serviceWorker:{register(){registrations++;}}},URL,window:{},supabase:{}};
 vm.runInNewContext(source+'\nthis.enable=enablePush;',box);let disabled=false;try{await box.enable();}catch(e){disabled=e.hint==='not_configured';}ok('Frontend deshabilitado no pide permiso ni registra suscripción',disabled&&prompts===0&&registrations===0);
 return{checks:names.length,failures:0,names};
}
module.exports={run};if(require.main===module)run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
