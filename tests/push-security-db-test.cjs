// Invoked by order-code-locale-db-test.cjs at the 20261115 stage.
// Fake local subscriptions only. No HTTP, pg_net, Vault, VAPID or browser APIs.
module.exports = async function testPushSecurity({ Client, config, database, db, users, admin, call, product, emptyVariant, ok, equal }) {
  const q = (sql, params) => db.query(sql, params);
  const one = async (sql, params) => (await q(sql, params)).rows[0];
  const invoke = async (role, claims, sql, params = []) => {
    if (!['postgres','service_role','anon','authenticated'].includes(role)) throw new Error('Unexpected SQL test role');
    const client = new Client({ ...config, database });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await client.query("select set_config('request.jwt.claims',$1,true)", [claims === undefined ? '' : JSON.stringify(claims)]);
      const result = await client.query(sql, params);
      await client.query('commit');
      return result.rows[0]?.r;
    } catch (e) { await client.query('rollback'); throw e; }
    finally { await client.end(); }
  };
  const service = (sql, params) => invoke('service_role', { role: 'service_role' }, sql, params);
  const denied = async (name, fn) => {
    let blocked = false;
    try { await fn(); } catch (e) { blocked = e.code === '42501'; }
    ok(name, blocked);
  };
  const queue = async () => ({
    events: (await q('select to_jsonb(t) r from private.push_events t order by id')).rows,
    deliveries: (await q('select to_jsonb(t) r from private.push_deliveries t order by id')).rows
  });
  const business = async () => {
    const snapshot = {};
    for (const t of ['orders','order_items','inventory_movements','product_variants','order_events','restock_requests'])
      snapshot[t] = (await q(`select to_jsonb(t) r from public.${t} t order by id`)).rows;
    return snapshot;
  };
  ok('Push: pg_net y Vault ausentes; sin capacidad de envío externo', (await one("select to_regnamespace('net') is null and to_regnamespace('vault') is null ok")).ok);
  for (const table of ['private.push_events','private.push_deliveries']) {
    ok(`${table}: RLS sin FORCE ni políticas`, (await one('select c.relrowsecurity and not c.relforcerowsecurity and not exists(select 1 from pg_policy p where p.polrelid=c.oid) ok from pg_class c where c.oid=$1::regclass', [table])).ok);
    for (const role of ['anon','authenticated']) {
      ok(`${role}: sin privilegios de tabla/columna en ${table}`, (await one("select not has_table_privilege($1,$2,'select,insert,update,delete,truncate,references,trigger') and not has_any_column_privilege($1,$2,'select,insert,update,references') ok", [role, table])).ok);
      for (const [verb, sql] of [
        ['SELECT', `select * from ${table}`],
        ['INSERT', `insert into ${table} default values`],
        ['UPDATE', `update ${table} set created_at=created_at`],
        ['DELETE', `delete from ${table}`]
      ]) await denied(`${role}: ${verb} directo denegado en ${table}`, () => invoke(role, { role }, sql));
    }
  }
  for (const role of ['anon','authenticated']) {
    for (const signature of ['private.push_order_created()','private.queue_restock_push(bigint[])','private.push_restock_from_movement()','private.push_restock_from_order()','private.push_kick()','private.money_text(numeric)','private.valid_push_endpoint(text)'])
      ok(`${role}: sin EXECUTE en ${signature}`, (await one("select not has_function_privilege($1,$2,'execute') ok", [role, signature])).ok);
    for (const [name, sql] of [['claim','select public.push_claim(1) r'],['report',"select public.push_report('[]'::jsonb) r"]])
      await denied(`${role}: ACL impide ${name} aun con claim service_role`, () => invoke(role, { role: 'service_role' }, sql));
  }
  const beforeDenied = await queue();
  const badClaims = [undefined, null, {}, { role: null }, { role: '' }, { role: 'anon' }, { role: 'authenticated' }, { role: 'postgres' }, { role: 'unexpected' }, { role: 'SERVICE_ROLE' }, { role: ['service_role'] }, { role: 123 }];
  for (const claims of badClaims) for (const [name, sql] of [['claim','select public.push_claim(1) r'],['report',"select public.push_report('[]'::jsonb) r"]])
    await denied(`service_role SQL: ${name} rechaza contexto ${JSON.stringify(claims)}`, () => invoke('service_role', claims, sql));
  for (const [name, sql] of [['claim','select public.push_claim(1) r'],['report',"select public.push_report('[]'::jsonb) r"]])
    await denied(`Propietario sin contexto: ${name} denegado por guarda interna`, () => invoke('postgres', undefined, sql));
  equal('Contextos rechazados no alteran la cola', await queue(), beforeDenied);

  // Four fictional devices across two admins; no actual subscription is activated.
  await q("insert into public.admin_users(user_id,role) values($1,'admin')", [users[6]]);
  const subscriptions = [];
  for (let i = 0; i < 4; i++) subscriptions.push(Number((await one(
    'insert into public.admin_push_subscriptions(user_id,endpoint,p256dh,auth_secret,label,created_at) values($1,$2,$3,$4,$5,now()-interval \'1 day\') returning id',
    [i < 3 ? admin : users[6], `https://fcm.googleapis.com/fcm/send/LOCAL_FAKE_DEVICE_${i}`, 'B' + 'x'.repeat(86), 'a'.repeat(22), 'local fixture'])).id));
  ok('RLS: admin ve solo sus 3 dispositivos', (await call(admin, 'select count(*)::int r from public.admin_push_subscriptions')).valueOf() === 3);
  ok('RLS: segundo admin ve solo su dispositivo', await call(users[6], 'select count(*)::int r from public.admin_push_subscriptions') === 1);
  ok('RLS: cliente no ve dispositivos', await call(users[1], 'select count(*)::int r from public.admin_push_subscriptions') === 0);
  for (const role of ['anon','authenticated']) {
    await denied(`${role}: no puede leer claves de suscripciones`, () => invoke(role, { role, sub: admin }, 'select p256dh,auth_secret from public.admin_push_subscriptions'));
    for (const sql of ['insert into public.admin_push_subscriptions default values','update public.admin_push_subscriptions set label=label','delete from public.admin_push_subscriptions'])
      await denied(`${role}: escritura directa de suscripciones denegada (${sql.split(' ')[0]})`, () => invoke(role, { role, sub: admin }, sql));
  }
  const orders = [];
  for (let i = 0; i < 6; i++) orders.push(await call(users[1], 'select public.create_order($1::jsonb) r', [JSON.stringify([{ product_id: product, variant: '500 g', quantity: 1 }])]));
  const events = (await q("select event_key,payload from private.push_events where kind='pedido'")).rows;
  ok('Trigger bajo RLS: un evento por pedido con datos completos', orders.every(o => events.some(e => e.event_key === 'order:' + o.id && e.payload.body.includes('1 producto'))));
  const stableBusiness = await business();
  const workers = await Promise.all(Array.from({ length: 5 }, () => service('select public.push_claim(7) r')));
  const claimed = [...workers.flat(), ...await service('select public.push_claim(200) r')];
  ok('5 workers: 24 entregas (6 pedidos × 4 dispositivos)', claimed.length === 24);
  ok('5 workers: ninguna entrega reclamada dos veces', new Set(claimed.map(r => r.id)).size === claimed.length);
  ok('Lease vigente excluye nuevos reclamos', (await service('select public.push_claim(200) r')).length === 0);
  const reports = await Promise.all(Array.from({ length: 3 }, () => service('select public.push_report($1::jsonb) r', [JSON.stringify(claimed.map(r => ({ id: r.id, outcome: 'enviado' })))])));
  ok('3 reports concurrentes: cada confirmación se aplica una vez', reports.reduce((a,b) => a+b, 0) === 24);
  ok('Entregas enviadas no se reclaman de nuevo', (await service('select public.push_claim(200) r')).length === 0);
  equal('Claim/report no modifican pedidos, reservas, inventario ni avisos email', await business(), stableBusiness);
  await q('delete from public.admin_push_subscriptions where id=any($1)', [subscriptions.slice(1)]);
  const addEvent = async key => q("insert into private.push_events(event_key,kind,payload) values($1,'prueba',$2)", [key, JSON.stringify({ title: 'Prueba local', body: 'Sin envío', url: '/admin/', ttl: 600 })]);
  await addEvent('security:retry');
  const first = (await service('select public.push_claim(10) r'))[0];
  ok('SECURITY DEFINER: crea entrega bajo RLS', !!first?.id && first.attempt === 1);
  await service('select public.push_report($1::jsonb) r', [JSON.stringify([{ id: first.id, outcome: 'reintentar', error: '503 ficticio' }])]);
  ok('Reintento espera backoff', (await service('select public.push_claim(10) r')).length === 0);
  await q('update private.push_deliveries set next_attempt_at=now() where id=$1', [first.id]);
  const second = (await service('select public.push_claim(10) r'))[0];
  ok('Reintento conserva ID e incrementa intento', second.id === first.id && second.attempt === 2);
  await q("update private.push_deliveries set lease_until=now()-interval '1 second' where id=$1", [first.id]);
  const recovered = (await service('select public.push_claim(10) r'))[0];
  ok('Lease vencido se recupera como intento 3', recovered.id === first.id && recovered.attempt === 3);
  for (let attempt = 3; attempt <= 5; attempt++) {
    await service('select public.push_report($1::jsonb) r', [JSON.stringify([{ id: first.id, outcome: 'reintentar' }])]);
    if (attempt < 5) {
      await q('update private.push_deliveries set next_attempt_at=now() where id=$1', [first.id]);
      ok(`Reclamo de intento ${attempt+1}`, (await service('select public.push_claim(10) r'))[0].attempt === attempt + 1);
    }
  }
  ok('Quinto intento fallido termina sin más reintentos', (await one('select status from private.push_deliveries where id=$1', [first.id])).status === 'fallido' && (await service('select public.push_claim(10) r')).length === 0);
  await addEvent('security:gone');
  const gone = (await service('select public.push_claim(10) r'))[0];
  await service('select public.push_report($1::jsonb) r', [JSON.stringify([{ id: gone.id, outcome: 'vencida', error: '410 ficticio' }])]);
  ok('410: desactiva dispositivo sin alterar el pedido', (await one('select disabled_at is not null ok from public.admin_push_subscriptions where id=$1', [subscriptions[0]])).ok);
  await q('update public.admin_push_subscriptions set disabled_at=null where id=$1', [subscriptions[0]]);
  await addEvent('security:expired');
  const expired = (await service('select public.push_claim(10) r'))[0];
  await q("update private.push_deliveries set created_at=now()-interval '25 hours' where id=$1", [expired.id]);
  await service('select public.push_claim(10) r');
  ok('Entrega de más de 24 horas se descarta', (await one('select status from private.push_deliveries where id=$1', [expired.id])).status === 'descartado');
  // Restock trigger + idempotent event insertion under RLS, no client email.
  await q("insert into public.inventory_movements(variant_id,movement_type,quantity,reason) values($1,'entrada',1,'fixture reposición')", [emptyVariant]);
  ok('Trigger de reposición escribe bajo RLS', (await one("select count(*)::int n from private.push_events where event_key like 'restock:'||$1::text||':%'", [emptyVariant])).n === 1);
  ok('Reposición repetida no duplica evento', (await one('select private.queue_restock_push(array[$1::bigint]) n', [emptyVariant])).n === 0);
  await q('delete from public.admin_push_subscriptions where id=any($1)', [subscriptions]);
};
