// Real PostgreSQL, loopback only. Creates/drops a dedicated database; no external services.
// PW=/path/to/dependencies node tests/random-codes-security-db-test.cjs [repo] [port]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run({ Client, root = path.resolve(__dirname,'..'), port = 55448 }) {
  const config = { host:'127.0.0.1', port, user:'postgres', connectionTimeoutMillis:5000 };
  const database = `povmatero_random_test_${Date.now()}`;
  const control = new Client({ ...config, database:'postgres' });
  let db;
  const checks = [];
  const ok = (name,value) => { assert.ok(value,name); checks.push(name); };
  const canonical = x => JSON.stringify(x,(_,v) => v && typeof v==='object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
  const equal = (name,a,b) => ok(name,canonical(a)===canonical(b));
  const read = file => fs.readFileSync(path.join(root,file),'utf8');
  const migration = file => read('supabase/migrations/'+file);
  const queries = file => read('supabase/checks/'+file).split(/;\s*\n/)
    .map(s=>s.replace(/^\s*--.*$/gm,'').trim()).filter(Boolean);
  await control.connect();
  try {
    await control.query(`create database ${database} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`);
    db = new Client({ ...config,database }); await db.connect();
    const q = (sql,params) => db.query(sql,params);
    const one = async(sql,params)=>(await q(sql,params)).rows[0];
    for (const [role,suffix] of [['anon',''],['authenticated',''],['service_role',' bypassrls']])
      if (!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)
        await control.query(`create role ${role} nologin${suffix}`);
    await q(read('tests/db-test.cjs').match(/const STUB = `([\s\S]*?)`;/)[1].replace(/create role [^;]+;/g,''));
    const files=fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
    for (const file of files.filter(f=>f<'20261114')) await q(migration(file));
    const invoke = async(role,claims,sql,params=[])=>{
      if (!['postgres','authenticated','anon'].includes(role)) throw new Error('Unsafe test role');
      const client=new Client({...config,database}); await client.connect();
      try {
        await client.query('begin');await client.query(`set local role ${role}`);
        await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
        const result=await client.query(sql,params);await client.query('commit');return result.rows[0]?.r;
      } catch(e){await client.query('rollback');throw e;} finally{await client.end();}
    };
    const users=Array.from({length:8},(_,i)=>`22222222-2222-4222-8222-${String(i+1).padStart(12,'0')}`);
    const admin=users[7];
    const call=(user,sql,params)=>invoke('authenticated',{sub:user,role:'authenticated'},sql,params);
    const denied=async(name,fn,code='42501')=>{let blocked=false;try{await fn();}catch(e){blocked=e.code===code;}ok(name,blocked);};
    const names=[['Ñandú','Íñiguez'],['Ana','Arce'],['Antonella','Acevedo'],['Beto','Gómez'],['Carla','Díaz'],['',''],['Otro','Cliente'],['Admin','Local']];
    for(let i=0;i<users.length;i++)await q('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[users[i],`fixture${i}@example.invalid`,JSON.stringify({first_name:names[i][0],last_name:names[i][1],phone:'11 5555 1234'})]);
    await q("insert into public.admin_users(user_id,role) values($1,'owner')",[admin]);
    const category=(await one("select id from public.categories where slug='yerbas'")).id;
    const product=Number((await one("insert into public.products(category_id,slug,name,is_active) values($1,'random-fixture','Yerba ficticia',true) returning id",[category])).id);
    const variants=[];
    for(let i=0;i<3;i++){
      const id=Number((await one('insert into public.product_variants(product_id,name,price) values($1,$2,$3) returning id',[product,`${i+1} kg`,1000*(i+1)])).id);variants.push(id);
      await q("insert into public.inventory_movements(variant_id,movement_type,quantity,reason) values($1,'entrada',100,'fixture local')",[id]);
    }
    const lines=(count=1)=>JSON.stringify(variants.slice(0,count).map(variant_id=>({variant_id,quantity:1})));
    const historical=[];
    const states=['pendiente','pendiente','confirmado','preparando','listo','entregado','cancelado'];
    const counts=[3,2,2,2,2,1,1];
    for(let i=0;i<7;i++){
      const order=await call(users[i%3],'select public.create_yerba_order($1::jsonb,null) r',[lines(counts[i])]);historical.push(order.id);
      if(['preparando','entregado'].includes(states[i]))await call(admin,'select public.admin_set_order_status($1,$2) r',[order.id,states[i]==='preparando'?'confirmado':'listo']);
      if(states[i]!=='pendiente')await call(admin,'select public.admin_set_order_status($1,$2) r',[order.id,states[i]]);
      await q("update public.orders set created_at=now()-make_interval(hours=>$2::int),expires_at=now()-make_interval(hours=>$2::int)+interval '72 hours' where id=$1",[order.id,i===1?80:10+i]);
    }
    const storeLines=JSON.stringify([{product_id:product,variant:'1 kg',quantity:1},{product_id:product,variant:'2 kg',quantity:1}]);
    historical.push((await call(users[0],'select public.create_order($1::jsonb) r',[storeLines])).id);
    const sale=await call(admin,"select public.admin_create_sale($1::jsonb,null,'Venta ficticia',null,null) r",[lines()]);historical.push(sale.id);
    await q(migration('20261114000000_order_codes_12h.sql'));
    await q(migration('20261115000000_admin_push.sql'));
    // Historical Push payloads only; no subscriptions, workers or networking.
    await q("insert into private.push_events(event_key,kind,payload) select 'order:'||id,'pedido',jsonb_build_object('body','Referencia '||public_code,'url','/admin/#/pedidos/'||id) from public.orders where kind in ('yerbas','tienda')");
    const snapshot=async()=>{
      const result={};
      for(const table of ['orders','order_items','inventory_movements','product_variants','order_events','restock_requests'])result[table]=(await q(`select to_jsonb(t) r from public.${table} t order by id`)).rows.map(r=>r.r);
      result.counters=(await q('select to_jsonb(c) r from private.order_counters c order by customer_id')).rows.map(r=>r.r);
      result.push=(await q('select to_jsonb(e) r from private.push_events e order by id')).rows.map(r=>r.r);
      return result;
    };
    const before=await snapshot();
    ok('Fixture histórica: exactamente 9 pedidos y 16 líneas',before.orders.length===9&&before.order_items.length===16);
    const runChecks=async file=>{const rows=[];for(const sql of queries(file))rows.push((await q(sql)).rows);return rows;};
    const pre=await runChecks('20261116_antes_codigos_aleatorios.sql');
    ok('Control previo 16: todos los indicadores true',Object.values(pre[0][0]).every(v=>v===true));
    ok('Control previo 16: sin dependientes OID',pre[1].length===0);
    await q('begin');await q("create view public.rename_dependency_fixture as select public.create_order('[]'::jsonb) result");
    ok('Control previo detecta una dependencia OID real',!(await q(queries('20261116_antes_codigos_aleatorios.sql')[0])).rows[0].sin_dependientes_oid);
    await q('rollback');
    const oldOid=(await one("select 'public.create_order(jsonb)'::regprocedure::oid oid")).oid;
    await q(migration('20261116000000_random_public_codes.sql'));
    const after=await snapshot();
    equal('9 históricos: todos los campos conservados salvo códigos públicos',after.orders.map(({public_code,legacy_public_code,...o})=>o),before.orders.map(({public_code,...o})=>o));
    ok('9 históricos: referencia anterior exacta, incluido NULL en venta sin cliente',after.orders.every(o=>o.legacy_public_code===before.orders.find(b=>b.id===o.id).public_code));
    for(const table of ['order_items','inventory_movements','product_variants','order_events','restock_requests','counters'])equal(`16 conserva contenido exacto de ${table}`,after[table],before[table]);
    equal('Push conserva rutas y metadatos, solo reemplaza etiquetas',after.push,before.push.map(e=>{const o=after.orders.find(o=>'order:'+o.id===e.event_key);return o?.legacy_public_code?{...e,payload:{...e.payload,body:e.payload.body.split(o.legacy_public_code).join(o.public_code)}}:e;}));
    ok('RENAME conserva OID original y wrapper tiene OID nuevo',(await one("select 'public.create_order_before_public_code(jsonb)'::regprocedure::oid old_oid,'public.create_order(jsonb)'::regprocedure::oid new_oid")).old_oid===oldOid&&(await one("select 'public.create_order(jsonb)'::regprocedure::oid oid")).oid!==oldOid);
    const post=await runChecks('20261116_despues_codigos_aleatorios.sql');
    ok('Control posterior 16: todos los indicadores true',Object.values(post[0][0]).every(v=>v===true));
    equal('Línea base completa: conteos y huellas idénticos',post[2],pre[2]);
    equal('Referencias y huellas por cada ID histórico',post[3].map(({codigo_nuevo,...o})=>o),pre[3]);
    for(const role of ['anon','authenticated']){
      for(const [name,sql,params]of[
        ['SELECT','select * from private.public_order_codes',[]],
        ['INSERT',"insert into private.public_order_codes values('PV-AAAAAAAAAA')",[]],
        ['UPDATE','update private.public_order_codes set code=code',[]],
        ['DELETE','delete from private.public_order_codes',[]],
        ['reserva','select private.reserve_public_order_code() r',[]],
        ['RPC anterior','select public.create_order_before_public_code($1::jsonb) r',[storeLines]]
      ])await denied(`${role}: acceso directo denegado a ${name}`,()=>invoke(role,{role,sub:users[3]},sql,params));
    }
    await denied('anon: wrapper de tienda denegado',()=>invoke('anon',{role:'anon'},'select public.create_order($1::jsonb) r',[storeLines]));
    await denied('Sin sesión: wrapper sigue exigiendo login',()=>invoke('postgres',{},'select public.create_order($1::jsonb) r',[storeLines]));
    const store=await call(users[3],'select public.create_order($1::jsonb) r',[storeLines]);
    const yorder=(user,key=null)=>call(user,'select public.create_yerba_order($1::jsonb,null,$2::uuid) r',[lines(),key]);
    const yerba=await yorder(users[3]);
    ok('Tienda y yerbas devuelven códigos PV distintos',/^PV-[A-F0-9]{10}$/.test(store.public_code)&&/^PV-[A-F0-9]{10}$/.test(yerba.public_code)&&store.public_code!==yerba.public_code);
    ok('Yerbas mantienen reserva de 12 horas',(await one("select expires_at-created_at=interval '12 hours' ok from public.orders where id=$1",[yerba.id])).ok);
    const newRow=await one('select customer_seq,legacy_public_code from public.orders where id=$1',[store.id]);ok('Pedidos nuevos sin secuencia ni referencia histórica',newRow.customer_seq===null&&newRow.legacy_public_code===null);
    for(const column of ['public_code','legacy_public_code','customer_seq'])await denied(`Inmutabilidad de ${column}`,()=>q(`update public.orders set ${column}=$2 where id=$1`,[yerba.id,column==='customer_seq'?1:'ZZ-999']),'23514');
    const retryKey='cccccccc-1111-4111-8111-cccccccccccc';
    const retries=await Promise.all(Array.from({length:4},()=>yorder(users[4],retryKey)));
    ok('4 reintentos concurrentes: un pedido y código',new Set(retries.map(r=>r.id)).size===1&&new Set(retries.map(r=>r.public_code)).size===1&&retries.filter(r=>r.repeated).length===3);
    const retry=await yorder(users[4],retryKey);ok('Reintento secuencial conserva código',retry.repeated===true&&retry.id===retries[0].id&&retry.public_code===retries[0].public_code);
    const retryBaseline=await one('select count(*)::int n from public.orders');
    const retryStock=await one('select stock from public.product_variants where id=$1',[variants[0]]);
    for(const hours of [7,12,13,48]){
      await q("update public.orders set created_at=now()-make_interval(hours=>$2::int),expires_at=now()-make_interval(hours=>$2::int)+interval '12 hours' where id=$1",[retry.id,hours]);
      const beforeRetry=await one('select expires_at::text expiry from public.orders where id=$1',[retry.id]);
      const late=await yorder(users[4],retryKey);
      ok(`Reintento a ${hours} h devuelve pedido original sin renovar reserva`,late.id===retry.id&&late.repeated===true&&(await one('select expires_at::text expiry from public.orders where id=$1',[retry.id])).expiry===beforeRetry.expiry);
    }
    equal('Reintentos tardíos no crean pedidos',await one('select count(*)::int n from public.orders'),retryBaseline);
    equal('Reintentos tardíos no descuentan stock físico',await one('select stock from public.product_variants where id=$1',[variants[0]]),retryStock);
    const legitimate=await yorder(users[4],'dddddddd-1111-4111-8111-dddddddddddd');
    ok('Nueva operación del mismo cliente permite segunda compra',legitimate.id!==retry.id&&legitimate.public_code!==retry.public_code);
    await call(admin,"select public.admin_set_order_status($1,'listo') r",[legitimate.id]);
    const readyStock=await one('select stock from public.product_variants where id=$1',[variants[0]]);
    const readyMoves=await one('select count(*)::int n from public.inventory_movements where order_id=$1',[legitimate.id]);
    const readyRetries=await Promise.all(Array.from({length:4},()=>yorder(users[4],'dddddddd-1111-4111-8111-dddddddddddd')));
    ok('4 reintentos concurrentes de pedido listo devuelven el original',readyRetries.every(o=>o.id===legitimate.id&&o.status==='listo'&&o.repeated));
    equal('Reintento de listo no descuenta stock otra vez',await one('select stock from public.product_variants where id=$1',[variants[0]]),readyStock);
    equal('Reintento de listo no duplica movimientos',await one('select count(*)::int n from public.inventory_movements where order_id=$1',[legitimate.id]),readyMoves);
    await denied('Clave ajena rechazada',()=>yorder(users[5],retryKey),'23514');
    const concurrent=await Promise.all(Array.from({length:12},()=>call(users[5],'select public.create_order($1::jsonb) r',[storeLines])));
    ok('12 pedidos de tienda concurrentes: códigos distintos',new Set(concurrent.map(r=>r.public_code)).size===12);
    const linked=await call(admin,'select public.admin_link_order_customer($1,$2) r',[sale.id,users[6]]);
    ok('Vincular venta conserva código PV',linked.public_code===after.orders.find(o=>o.id===sale.id).public_code);
    await call(admin,"select public.admin_set_order_status($1,'listo') r",[yerba.id]);
    await call(admin,"select public.admin_set_order_status($1,'listo') r",[yerba.id]);
    await call(admin,"select public.admin_set_order_status($1,'cancelado') r",[yerba.id]);
    ok('Estados siguen funcionando sin customer_seq; stock se revierte una vez',(await one('select coalesce(sum(quantity),0)::int net,count(*)::int n from public.inventory_movements where order_id=$1',[yerba.id])).net===0&&(await one('select count(*)::int n from public.inventory_movements where order_id=$1',[yerba.id])).n===2);
    equal('Contadores históricos nunca se incrementan', (await snapshot()).counters,before.counters);
    // Deterministic collisions replace the generator only inside this disposable DB.
    const generator=(await one("select pg_get_functiondef('private.random_public_order_code()'::regprocedure) def")).def;
    const collisionCode=after.orders[0].public_code;
    await q('create sequence private.collision_fixture');
    await q(`create or replace function private.random_public_order_code() returns text language sql volatile set search_path='' as $$select case when nextval('private.collision_fixture')=1 then '${collisionCode}' else 'PV-0000000001' end$$`);
    const collided=await call(users[6],'select public.create_order($1::jsonb) r',[storeLines]);ok('Colisión con código existente reintenta y reserva otro',collided.public_code==='PV-0000000001');
    await q("create or replace function private.random_public_order_code() returns text language sql volatile set search_path='' as $$select 'PV-0000000001'::text$$");
    const beforeFailure=await snapshot();const registryBefore=(await q('select code from private.public_order_codes order by code')).rows;
    await denied('32 colisiones agotan límite y devuelven 40001',()=>call(users[6],'select public.create_order($1::jsonb) r',[storeLines]),'40001');
    equal('Colisiones agotadas no dejan pedido, líneas, eventos ni movimientos',await snapshot(),beforeFailure);
    equal('Colisiones agotadas no modifican registro',(await q('select code from private.public_order_codes order by code')).rows,registryBefore);
    await q(generator);
    await q(`create or replace function private.random_public_order_code() returns text language plpgsql volatile set search_path='' as $$begin
      if coalesce(current_setting('pov.random_collision',true),'')<>'on' then perform set_config('pov.random_collision','on',true);return 'PV-CCCCCCCCCC';end if;
      return 'PV-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));end$$`);
    const collisions=await Promise.all(Array.from({length:8},()=>call(users[6],'select public.create_order($1::jsonb) r',[storeLines])));
    ok('8 colisiones concurrentes resueltas con unicidad',new Set(collisions.map(r=>r.public_code)).size===8&&collisions.filter(r=>r.public_code==='PV-CCCCCCCCCC').length===1);
    await q(generator);
    const before17=await snapshot();await q(migration('20261117000000_restock_email.sql'));
    const after17=await snapshot();equal('17 conserva pedidos, fechas y códigos',after17.orders,before17.orders);
    equal('17 conserva contadores',after17.counters,before.counters);
    const final=await runChecks('20261117_codigos_email.sql');ok('Control final 17: todos true',Object.values(final[0][0]).every(v=>v===true));
    ok('17 no crea trabajos email',(await one('select count(*)::int n from private.restock_email_jobs')).n===0);
    ok('Sin servicios externos ni dispositivos activados',(await one("select to_regnamespace('net') is null and to_regnamespace('vault') is null and not exists(select 1 from public.admin_push_subscriptions) ok")).ok);
    ok('Consistencia final: stock físico igual a movimientos',(await one('select bool_and(v.stock=coalesce(m.qty,0)) ok from public.product_variants v left join (select variant_id,sum(quantity) qty from public.inventory_movements group by 1) m on m.variant_id=v.id')).ok);
    const final16=await runChecks('20261116_despues_codigos_aleatorios.sql');ok('Control 16 también pasa con 17 aplicada',Object.values(final16[0][0]).every(v=>v===true));
    return {engine:await one('select version() version'),checks:checks.length,failures:0,names:checks,fixture:{orders:9,items:16},pre,post,final};
  }finally{if(db)await db.end();await control.query(`drop database if exists ${database}`);await control.end();}
}
module.exports={run};
if(require.main===module){const {Client}=require(require.resolve('pg',{paths:[process.env.PW||__dirname]}));run({Client,root:path.resolve(process.argv[2]||path.join(__dirname,'..')),port:Number(process.argv[3]||55448)}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
