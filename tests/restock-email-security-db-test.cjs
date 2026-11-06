// Real PostgreSQL on loopback. Disposable database; no HTTP/provider access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function run({Client,root=path.resolve(__dirname,'..'),port=55448}){
 const config={host:'127.0.0.1',port,user:'postgres',connectionTimeoutMillis:5000};
 const database=`povmatero_email_test_${Date.now()}`,control=new Client({...config,database:'postgres'});let db;
 const names=[],ok=(name,v)=>{assert.ok(v,name);names.push(name);};
 const canon=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
 const equal=(n,a,b)=>ok(n,canon(a)===canon(b));
 const read=f=>fs.readFileSync(path.join(root,f),'utf8');
 const checks=f=>read('supabase/checks/'+f).split(/;\s*\n/).map(s=>s.replace(/^\s*--.*$/gm,'').trim()).filter(Boolean);
 await control.connect();try{
 await control.query(`create database ${database} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`);
 db=new Client({...config,database});await db.connect();const q=(s,p)=>db.query(s,p),one=async(s,p)=>(await q(s,p)).rows[0];
 for(const [role,suffix]of[['anon',''],['authenticated',''],['service_role',' bypassrls']])if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await control.query(`create role ${role} nologin${suffix}`);
 await q(read('tests/db-test.cjs').match(/const STUB = `([\s\S]*?)`;/)[1].replace(/create role [^;]+;/g,''));
 const files=fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
 for(const f of files.filter(f=>f<'20261117'))await q(read('supabase/migrations/'+f));
 const invoke=async(role,claims,sql,params=[])=>{
  if(!['postgres','anon','authenticated','service_role'].includes(role))throw Error('Invalid test role');
  const c=new Client({...config,database});await c.connect();try{await c.query('begin');await c.query(`set local role ${role}`);await c.query("select set_config('request.jwt.claims',$1,true)",[claims===undefined?'':JSON.stringify(claims)]);const r=await c.query(sql,params);await c.query('commit');return r.rows[0]?.r;}catch(e){await c.query('rollback');throw e;}finally{await c.end();}
 };
 const server=(s,p)=>invoke('service_role',{role:'service_role'},s,p),customer=(u,s,p)=>invoke('authenticated',{role:'authenticated',sub:u},s,p);
 const denied=async(n,fn,code='42501')=>{let blocked=false;try{await fn();}catch(e){blocked=e.code===code;}ok(n,blocked);};
 const users=Array.from({length:14},(_,i)=>`33333333-3333-4333-8333-${String(i+1).padStart(12,'0')}`);
 for(let i=0;i<users.length;i++)await q('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[users[i],`fixture${i}@example.invalid`,JSON.stringify({first_name:'Cliente',last_name:'Ficticio',phone:'11 5555 1234'})]);
 const category=(await one("select id from public.categories where slug='yerbas'")).id;
 const product=Number((await one("insert into public.products(category_id,slug,name,is_active) values($1,'email-fixture','Yerba ficticia',true) returning id",[category])).id);
 let number=0;const variant=async()=>Number((await one('insert into public.product_variants(product_id,name,price) values($1,$2,1000) returning id',[product,`Presentación ${++number}`])).id);
 const oldV=await variant();for(let i=0;i<4;i++)await q("insert into public.restock_requests(product_id,variant_id,user_id,email,status,notified_at,cancelled_at) values($1,$2,$3,$4,$5,case when $5='avisada' then now() end,case when $5='cancelada' then now() end)",[product,oldV,users[i],`fixture${i}@example.invalid`,['activa','avisada','cancelada','activa'][i]]);
 const runChecks=async file=>{const result=[];for(const s of checks(file))result.push((await q(s)).rows);return result;};
 const pre=await runChecks('20261117_antes_email.sql');ok('Preflight 17: todos true',Object.values(pre[0][0]).every(v=>v===true));
 await q(read('supabase/migrations/20261117000000_restock_email.sql'));
 const post=await runChecks('20261117_codigos_email.sql');ok('Posterior 17: todos true',Object.values(post[0][0]).every(v=>v===true));equal('Datos históricos: huellas completas conservadas',pre[2],post[3]);equal('Solicitudes históricas idénticas salvo columnas nuevas',pre[3],post[4].map(({email_consent_at,...r})=>r));ok('Históricas sin consentimiento',post[4].every(r=>r.email_consent_at===null));
 const add=async(v,n=1)=>q("insert into public.inventory_movements(variant_id,movement_type,quantity,reason) values($1,'entrada',$2,'fixture')",[v,n]);
 const consent=async(u,v,accept=true)=>customer(u,'select public.request_restock_alert($1,$2) r',[v,accept]);
 const fresh=async(u=users[4])=>{const v=await variant();const r=await consent(u,v);return {...r,variant:v,user:u,...await one('select unsubscribe_token token from public.restock_requests where id=$1',[r.id])};};
 const claim=()=>server("select public.restock_email_claim('avisos@povmatero.com',10) r");
 const check=j=>server('select public.restock_email_check($1,$2) r',[j.id,j.token]);
 const report=(j,outcome='sent')=>server('select public.restock_email_report($1,$2,$3,$4) r',[j.id,j.token,outcome,'fake-resend']);
 const unsubscribe=r=>server('select public.restock_email_unsubscribe($1) r',[r.token]);
 const cancelled=async r=>{const s=await one('select status,notified_at,cancelled_at from public.restock_requests where id=$1',[r.id]);return s.status==='cancelada'&&s.notified_at===null&&!!s.cancelled_at;};
 const rpcCases=[['claim',"select public.restock_email_claim('avisos@povmatero.com',1) r",[]],['check','select public.restock_email_check($1,$2) r',[1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']],['report',"select public.restock_email_report($1,$2,'sent') r",[1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']],['unsubscribe','select public.restock_email_unsubscribe($1) r',['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]];
 for(const role of ['anon','authenticated']){
  for(const [n,s,p]of rpcCases)await denied(`${role}: ACL bloquea ${n} incluso con claim service_role`,()=>invoke(role,{role:'service_role'},s,p));
  for(const [n,s]of[['select','select * from private.restock_email_jobs'],['insert','insert into private.restock_email_jobs default values'],['update','update private.restock_email_jobs set state=state'],['delete','delete from private.restock_email_jobs']])await denied(`${role}: ${n} directo bloqueado`,()=>invoke(role,{role},s));
 }
 for(const claims of [undefined,null,{}, {role:null},{role:''},{role:'authenticated'},{role:'anon'},{role:'unexpected'},{role:'postgres'},{role:['service_role']}])for(const [n,s,p]of rpcCases)await denied(`Guarda ${n} rechaza ${JSON.stringify(claims)}`,()=>invoke('service_role',claims,s,p));
 for(const [n,s,p]of rpcCases)await denied(`Propietario sin contexto: ${n} bloqueado`,()=>invoke('postgres',undefined,s,p));
 await denied('Remitente NULL rechazado',()=>server('select public.restock_email_claim(null,1) r'),'22023');
 const legacyV=await variant();const legacy=await customer(users[4],'select public.request_restock_alert($1) r',[legacyV]);
 ok('Cliente antiguo de un parámetro no concede consentimiento',(await one('select email_consent_at from public.restock_requests where id=$1',[legacy.id])).email_consent_at===null);
 await add(legacyV);ok('No envía sin consentimiento aunque haya stock',(await claim()).length===0);
 await consent(users[4],legacyV,false);ok('false explícito tampoco concede consentimiento',(await one('select email_consent_at from public.restock_requests where id=$1',[legacy.id])).email_consent_at===null);
 await consent(users[4],legacyV,true);let jobs=await claim();ok('Aceptación explícita habilita solo esa solicitud',jobs.length===1&&jobs[0].id===legacy.id);await report(jobs[0]);
 let r=await fresh();ok('Consentimiento sin stock no genera correo',(await claim()).length===0);await add(r.variant);let j=(await claim())[0];ok('Stock habilita un trabajo bajo RLS',j.id===r.id&&await check(j));
 await unsubscribe(r);ok('Cancelación previa impide el envío',!await check(j));await report(j);ok('Respuesta tardía no marca cancelada como avisada',await cancelled(r));ok('Cancelada no vuelve a reclamarse',(await claim()).length===0);
 r=await fresh();await add(r.variant);j=(await claim())[0];await report(j);await unsubscribe(r);ok('Cancelación posterior al acuse también deja cancelada',await cancelled(r));
 for(let i=0;i<6;i++){
  r=await fresh();await add(r.variant);j=(await claim())[0];
  await Promise.all([report(j),i%2?customer(r.user,'select public.cancel_restock_alert($1) r',[r.variant]):unsubscribe(r)]);
  ok(`Carrera cancelación/acuse ${i+1}: cancelada sin notified_at`,await cancelled(r));
 }
 r=await fresh();await add(r.variant);j=(await claim())[0];await report(j,'retry');ok('Backoff impide reintento inmediato',(await claim()).length===0);
 await q('update private.restock_email_jobs set next_attempt_at=now() where request_id=$1',[r.id]);let retry=(await claim())[0];equal('Reintento congela destinatario/remitente/contenido',retry.payload,j.payload);ok('Reintento rota token',retry.token!==j.token);ok('Worker anterior no confirma otro intento',!await report(j));
 await q("update private.restock_email_jobs set lease_until=now()-interval '1 second' where request_id=$1",[r.id]);ok('Respuesta con lease vencido rechazada',!await report(retry));let recovered=(await claim())[0];ok('Lease recuperado rota token',recovered.token!==retry.token);await report(recovered);ok('Confirmación duplicada no se aplica',!await report(recovered));
 r=await fresh();await add(r.variant);j=(await claim())[0];await q("update private.restock_email_jobs set first_attempt_at=now()-interval '21 hours',lease_until=now()+interval '1 minute' where request_id=$1",[r.id]);ok('Fuera de ventana: check y report bloqueados',!await check(j)&&!await report(j));await claim();ok('Ventana de 20 h expirada termina el trabajo',(await one('select state,last_error from private.restock_email_jobs where request_id=$1',[r.id])).last_error==='retry_window_expired');
 r=await fresh();await add(r.variant);j=(await claim())[0];await q("update private.restock_email_jobs set attempts=8,lease_until=now()-interval '1 second' where request_id=$1",[r.id]);await claim();ok('Octavo lease perdido termina como failed',(await one('select state,last_error from private.restock_email_jobs where request_id=$1',[r.id])).last_error==='attempt_limit_exhausted');
 const v=await variant();const subscriptions=await Promise.all(users.slice(0,12).map(u=>consent(u,v)));ok('12 consentimientos concurrentes válidos',new Set(subscriptions.map(x=>x.id)).size===12);await add(v);const workers=await Promise.all(Array.from({length:5},claim));jobs=workers.flat();ok('5 workers reclaman 12 trabajos una sola vez',jobs.length===12&&new Set(jobs.map(j=>j.id)).size===12);const acks=await Promise.all(Array.from({length:3},async()=>{let n=0;for(const job of jobs)if(await report(job))n++;return n;}));ok('Acuses concurrentes se aplican una vez',acks.reduce((a,b)=>a+b,0)===12);
 r=await fresh();await add(r.variant);j=(await claim())[0];const order=await customer(users[13],'select public.create_yerba_order($1::jsonb,null,null) r',[JSON.stringify([{variant_id:r.variant,quantity:1}])]);ok('Reserva de la última unidad bloquea check',!await check(j));await report(j,'retry');await q('update private.restock_email_jobs set next_attempt_at=now() where request_id=$1',[r.id]);ok('No se reintenta sin disponibilidad',(await claim()).length===0);await q("update public.orders set expires_at=now()-interval '1 second' where id=$1",[order.id]);j=(await claim())[0];ok('Vencimiento de reserva habilita sin mover stock',j.id===r.id&&await check(j));await report(j);
 r=await fresh();await add(r.variant);await q("update auth.users set email='changed@example.invalid' where id=$1",[r.user]);ok('Cambio de email suspende envío consentido',(await claim()).length===0);
 await denied('Marcado manual revocado incluso a administrador',()=>customer(users[0],'select public.admin_mark_restock_notified($1::bigint[]) r',[[r.id]]));
 ok('Sin servicios externos configurados',(await one("select to_regnamespace('net') is null and to_regnamespace('vault') is null ok")).ok);
 const final=await runChecks('20261117_codigos_email.sql');ok('Controles finales siguen pasando',Object.values(final[0][0]).every(v=>v===true));
 return {engine:await one('select version() version'),checks:names.length,failures:0,names,pre,post,final};
 }finally{if(db)await db.end();await control.query(`drop database if exists ${database}`);await control.end();}
}
module.exports={run};
if(require.main===module){const {Client}=require(require.resolve('pg',{paths:[process.env.PW||__dirname]}));run({Client,root:path.resolve(process.argv[2]||path.join(__dirname,'..')),port:Number(process.argv[3]||55448)}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
