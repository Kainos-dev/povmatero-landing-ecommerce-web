// No real networking or environment credentials. All configuration/providers are fake.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
async function run({root=path.resolve(__dirname,'..')}={}){
 const lib=require(path.join(root,'api/_lib/restock-email.js')),handler=require(path.join(root,'api/restock-send.js')),unsubscribe=require(path.join(root,'api/restock-unsubscribe.js'));
 const names=[],ok=(n,v)=>{assert.ok(v,n);names.push(n);};
 const env={RESTOCK_EMAIL_ENABLED:'true',RESEND_API_KEY:'fake-provider',SUPABASE_SECRET_KEY:'fake-local',SUPABASE_URL:'https://db.example.invalid',RESTOCK_EMAIL_FROM:'avisos@povmatero.com',CRON_SECRET:'x'.repeat(32)};
 const job={id:7,token:'11111111-1111-4111-8111-111111111111',payload:{from:env.RESTOCK_EMAIL_FROM,to:'fixture@example.invalid',subject:'Local',text:'Local'}};
 const response=(status,data)=>({ok:status>=200&&status<300,status,json:async()=>data,text:async()=>JSON.stringify(data)});
 const res=()=>({statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}});
 for(const flag of ['false',undefined,'FALSE','1','']){
  let calls=0;const deps={env:{...env,RESTOCK_EMAIL_ENABLED:flag},fetchImpl:async()=>{calls++;throw Error('Forbidden network');}};
  ok(`Flag ${String(flag)}: dispatch deshabilitado`,(await lib.dispatch(deps)).disabled===true&&calls===0);
  for(const method of ['GET','POST']){const r=res();await handler({method,headers:{authorization:`Bearer ${env.CRON_SECRET}`}},r,deps);ok(`Flag ${String(flag)}: endpoint manual ${method} no reclama ni envía`,r.statusCode===503&&calls===0);}
 }
 for(const [method,auth,status]of[['GET','wrong',401],['POST','wrong',401],['DELETE','',405]]){const r=res();await handler({method,headers:{authorization:auth}},r,{env,fetchImpl:async()=>{throw Error('Forbidden');}});ok(`Endpoint ${method} rechaza autorización/método`,r.statusCode===status);}
 const keys=[];
 for(const mode of ['ok','timeout','rate','server','bad','cancel','late','report-lost']){
  const calls=[];let provider=0,cancelled=false;
  const fetchImpl=async(url,opts)=>{
   calls.push({url,body:JSON.parse(opts.body)});
   if(url.endsWith('/restock_email_claim'))return response(200,[job]);
   if(url.endsWith('/restock_email_check'))return response(200,mode!=='cancel');
   if(url.endsWith('/restock_email_report')){if(mode==='report-lost')throw Error('fake report lost');return response(200,mode!=='late');}
   assert.equal(url,'https://api.resend.com/emails');provider++;keys.push(opts.headers['Idempotency-Key']);assert.equal(JSON.stringify(JSON.parse(opts.body)),JSON.stringify(job.payload));
   if(mode==='timeout')throw Error('fake timeout');if(mode==='late')cancelled=true;
   return response(mode==='rate'?429:mode==='server'?503:mode==='bad'?422:200,{id:'fake-provider-id'});
  };
  if(mode==='report-lost'){let rejected=false;try{await lib.dispatch({env,fetchImpl});}catch{rejected=true;}ok('Acuse perdido provoca error y permite recuperación por lease',rejected);}
  else{
   const result=await lib.dispatch({env,fetchImpl});ok(`${mode}: cantidad de llamadas al proveedor`,provider===(mode==='cancel'?0:1));
   const reported=calls.find(c=>c.url.endsWith('/restock_email_report'));
   if(mode!=='cancel')ok(`${mode}: informa resultado esperado`,reported.body.p_outcome===(['ok','late'].includes(mode)?'sent':mode==='bad'?'failed':'retry'));
   else ok('Cancelación o falta de stock en check impide contactar Resend',result.skipped===1&&!reported);
   if(mode==='late')ok('Aceptación tardía se informa sin volver a solicitar/reactivar',cancelled&&calls.filter(c=>c.url.endsWith('/restock_email_claim')).length===1);
  }
 }
 ok('Todos los reintentos usan misma clave de idempotencia',keys.length>1&&keys.every(k=>k==='restock-request/7'));
 let calls=0;const deps={env,fetchImpl:async()=>{calls++;return response(200,true);}};
 let r=res();await unsubscribe({method:'GET',query:{token:job.token}},r,deps);ok('GET de escáner no cancela; presenta formulario POST',r.statusCode===200&&calls===0&&/form method="post"/.test(r.body));
 r=res();await unsubscribe({method:'POST',query:{token:job.token}},r,{...deps,env:{...env,RESTOCK_EMAIL_ENABLED:'false'}});ok('Bajas siguen funcionando con envíos deshabilitados',r.statusCode===200&&calls===1);
 r=res();await unsubscribe({method:'POST',query:{token:'<script>'}},r,deps);ok('Token inválido rechazado sin RPC',r.statusCode===400&&calls===1);
 // Execute the actual cron source in a VM whose environment, fetch and Push are fake.
 const cronCalls=[],sandbox={module:{exports:{}},process:{env:{...env,RESTOCK_EMAIL_ENABLED:'false'}},console:{log(){},error(){}},AbortController,setTimeout,clearTimeout,
  require(name){assert.equal(name,'./_lib/webpush.js');return {vapidKeys:()=>null,dispatch:()=>{throw Error('Push disabled');}};},
  fetch:async(url,opts)=>{cronCalls.push({url,opts});assert.ok(url.endsWith('/run_order_maintenance'));return response(200,{cancelados:[],entregados:[]});}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'api/cron-pedidos.js'),'utf8'),sandbox,{filename:'cron-pedidos.js'});
 r=res();await sandbox.module.exports({method:'GET',headers:{authorization:`Bearer ${env.CRON_SECRET}`}},r);ok('Cron con flag false solo ejecuta mantenimiento: cero envíos o claims email',r.statusCode===200&&cronCalls.length===1&&cronCalls.every(c=>c.url.endsWith('/run_order_maintenance')));
 return {checks:names.length,failures:0,names};
}
module.exports={run};if(require.main===module)run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
