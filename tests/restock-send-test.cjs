const assert=require('node:assert/strict');
const lib=require('../api/_lib/restock-email.js');
const handler=require('../api/restock-send.js');
const unsub=require('../api/restock-unsubscribe.js');
global.fetch=()=>{throw new Error('Real network forbidden');};
const env={RESTOCK_EMAIL_ENABLED:'true',RESEND_API_KEY:'fake',SUPABASE_SECRET_KEY:'fake',RESTOCK_EMAIL_FROM:'avisos@povmatero.com',CRON_SECRET:'x'.repeat(32)};
const job={id:7,token:'11111111-1111-4111-8111-111111111111',payload:{from:env.RESTOCK_EMAIL_FROM,to:'customer@example.invalid',subject:'Test',text:'Test'}};
const response=(status,data)=>({ok:status>=200&&status<300,status,json:async()=>data});
const res=()=>({statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}});
(async()=>{
 assert.deepEqual(await lib.dispatch({env:{}}),{disabled:true});
 assert.ok(!lib.configured({...env,RESTOCK_EMAIL_FROM:'person@example.com'}));
 assert.equal(lib.safeEqual('é','x'),false);
 assert.equal(lib.safeEqual('secret','secret'),true);
 let stagingUrl;
 await lib.rpc('restock_email_check',{}, {env:{...env,SUPABASE_URL:'https://staging.example.invalid/'},fetchImpl:async url=>{stagingUrl=url;return response(200,false);}});
 assert.equal(stagingUrl,'https://staging.example.invalid/rest/v1/rpc/restock_email_check');
 for(const mode of ['ok','timeout','rate','bad','cancel','report-lost']) {
  const seen=[]; let provider=0;
  const fetchImpl=async(url,opts)=>{
   seen.push({url,opts});
   if(url.endsWith('/restock_email_claim'))return response(200,[job]);
   if(url.endsWith('/restock_email_check'))return response(200,mode!=='cancel');
   if(url.endsWith('/restock_email_report')) {if(mode==='report-lost')throw Error('local loss'); return response(200,true);}
   assert.equal(url,'https://api.resend.com/emails'); provider++;
   assert.equal(opts.headers['Idempotency-Key'],'restock-request/7');
   assert.deepEqual(JSON.parse(opts.body),job.payload);
   if(mode==='timeout')throw Error('timeout');
   return response(mode==='bad'?422:mode==='rate'?429:200,{id:'provider-fake'});
  };
  if(mode==='report-lost') await assert.rejects(lib.dispatch({env,fetchImpl}));
  else {
   const result=await lib.dispatch({env,fetchImpl});
   assert.equal(provider,mode==='cancel'?0:1);
   if(mode!=='cancel') {
    const report=JSON.parse(seen.find(x=>x.url.endsWith('/restock_email_report')).opts.body);
    assert.equal(report.p_outcome,mode==='ok'?'sent':mode==='bad'?'failed':'retry');
   } else assert.equal(result.skipped,1);
  }
 }
 for(const [method,auth,expected] of [['GET','wrong',401],['DELETE','',405]]) {
  const r=res(); await handler({method,headers:{authorization:auth}},r,{env});assert.equal(r.statusCode,expected);
 }
 let r=res(); await handler({method:'GET',headers:{}},r,{env:{}}); assert.equal(r.statusCode,503);
 let calls=0;
 const deps={env,fetchImpl:async()=>{calls++;return response(200,true);}};
 r=res();await unsub({method:'GET',query:{token:job.token}},r,deps);assert.equal(calls,0);assert.equal(r.statusCode,200);assert.match(r.body,/form method="post"/);
 r=res();await unsub({method:'POST',query:{token:job.token}},r,deps);assert.equal(calls,1);assert.equal(r.statusCode,200);
 r=res();await unsub({method:'POST',query:{token:'<script>'}},r,deps);assert.equal(r.statusCode,400);
 console.log('Email worker and unsubscribe: all simulated checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
