// Real PostgreSQL regression test. Only loopback; creates and drops its own database.
// PW=/path/to/dependencies node tests/order-code-locale-db-test.cjs [repo] [port]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run({ Client, root = path.resolve(__dirname, '..'), port = 55448 }) {
  const config = { host: '127.0.0.1', port, user: 'postgres', connectionTimeoutMillis: 5000 };
  const database = `povmatero_locale_test_${Date.now()}`;
  const control = new Client({ ...config, database: 'postgres' });
  let db;
  const checks = [];
  const ok = (name, value) => { assert.ok(value, name); checks.push(name); };
  // Compare JSON content across JS realms, too (e.g. node_repl).
  const canonical = value => JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  const equal = (name, a, b) => ok(name, canonical(a) === canonical(b));
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const migration = name => read(`supabase/migrations/${name}`);
  const splitChecks = name => read(`supabase/checks/${name}`).split(/;\s*\n/)
    .map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  await control.connect();
  try {
    // Fresh database, C locale: reproduces the original normalization failure.
    await control.query(`create database ${database} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`);
    db = new Client({ ...config, database });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const one = async (sql, params) => (await q(sql, params)).rows[0];
    // Roles are cluster-wide; the schema stub is restricted to the new database.
    for (const [role, suffix] of [['anon', ''], ['authenticated', ''], ['service_role', ' bypassrls']]) {
      if (!(await control.query('select 1 from pg_roles where rolname=$1', [role])).rowCount)
        await control.query(`create role ${role} nologin${suffix}`);
    }
    const stub = read('tests/db-test.cjs').match(/const STUB = `([\s\S]*?)`;/)[1]
      .replace(/create role [^;]+;/g, '');
    await q(stub);
    const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
    for (const f of files.filter(f => f < '20261114')) await q(migration(f));
    const call = async (user, sql, params = []) => {
      const client = new Client({ ...config, database });
      await client.connect();
      try {
        await client.query('begin');
        await client.query('set local role authenticated');
        await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
        const result = await client.query(sql, params);
        await client.query('commit');
        return result.rows[0]?.r;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally { await client.end(); }
    };
    const users = Array.from({ length: 8 }, (_, i) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`);
    const names = [['Ñandú','Íñiguez'],['Ana','Pérez'],['Antonella','Arce'],['',''],['Agustín','Acevedo'],['Beto','Gómez'],['Carlos','Díaz'],['Admin','Local']];
    for (let i = 0; i < users.length; i++) await q(
      'insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',
      [users[i], `fixture${i}@example.invalid`, JSON.stringify({ first_name: names[i][0], last_name: names[i][1], phone: '11 5555 1234' })]);
    const admin = users[7];
    await q("insert into public.admin_users(user_id,role) values($1,'owner')", [admin]);
    const category = (await one("select id from public.categories where slug='yerbas'")).id;
    const product = Number((await one("insert into public.products(category_id,slug,name,is_active) values($1,'locale-fixture','Yerba ficticia',true) returning id", [category])).id);
    const variant = Number((await one("insert into public.product_variants(product_id,name,price) values($1,'500 g',1000) returning id", [product])).id);
    const emptyVariant = Number((await one("insert into public.product_variants(product_id,name,price) values($1,'1 kg',2000) returning id", [product])).id);
    await q("insert into public.inventory_movements(variant_id,movement_type,quantity,reason) values($1,'entrada',100,'fixture local')", [variant]);
    const lines = (v = variant) => JSON.stringify([{ variant_id: v, quantity: 1 }]);
    const oldOrder = await call(users[0], 'select public.create_yerba_order($1::jsonb,null) r', [lines()]);
    await q("update public.orders set created_at=now()-interval '20 hours',expires_at=now()+interval '52 hours' where id=$1", [oldOrder.id]);
    const expiredOrder = await call(users[1], 'select public.create_yerba_order($1::jsonb,null) r', [lines()]);
    await q("update public.orders set created_at=now()-interval '80 hours',expires_at=now()-interval '8 hours' where id=$1", [expiredOrder.id]);
    const readyOrder = await call(users[2], 'select public.create_yerba_order($1::jsonb,null) r', [lines()]);
    await call(admin, "select public.admin_set_order_status($1,'listo') r", [readyOrder.id]);
    await call(users[1], 'select public.create_order($1::jsonb) r', [JSON.stringify([{ product_id: product, variant: '500 g', quantity: 1 }])]);
    await call(admin, "select public.admin_create_sale($1::jsonb,null,'Venta ficticia',null,null) r", [lines()]);
    await q("insert into public.restock_requests(product_id,variant_id,user_id,email) values($1,$2,$3,'fixture0@example.invalid')", [product, emptyVariant, users[0]]);
    const snapshot = async () => {
      const result = {};
      for (const table of ['orders','order_items','inventory_movements','product_variants','order_events','restock_requests'])
        result[table] = (await q(`select to_jsonb(t) r from public.${table} t order by id`)).rows.map(r => r.r);
      return result;
    };
    const before = await snapshot();
    const beforeTotals = (await q(splitChecks('20261114_antes_codigos_12h.sql')[1])).rows;
    await q(migration('20261114000000_order_codes_12h.sql'));
    ok('20261114 se aplica en PostgreSQL con locale C', true);
    const after = await snapshot();
    equal('Pedidos históricos idénticos salvo columnas nuevas', after.orders.map(({ public_code, customer_seq, ...o }) => o), before.orders);
    for (const table of Object.keys(before).filter(t => t !== 'orders')) equal(`Datos históricos idénticos: ${table}`, after[table], before[table]);
    ok('Backfill Ñandú Íñiguez genera NI-001', after.orders.find(o => o.id === oldOrder.id).public_code === 'NI-001');
    ok('Contadores con RLS habilitada y sin políticas', (await one("select c.relrowsecurity and not exists(select 1 from pg_policy p where p.polrelid=c.oid) ok from pg_class c where c.oid='private.order_counters'::regclass")).ok);
    ok('Trigger SECURITY DEFINER pertenece al dueño de contadores, sin FORCE RLS', (await one("select p.prosecdef and p.proowner=c.relowner and not c.relforcerowsecurity ok from pg_proc p cross join pg_class c where p.oid='private.assign_order_code()'::regprocedure and c.oid='private.order_counters'::regclass")).ok);
    for (const role of ['anon', 'authenticated']) {
      ok(`${role}: sin permisos de tabla ni columna sobre contadores`, (await one("select not has_table_privilege($1,'private.order_counters','select,insert,update,delete') and not has_any_column_privilege($1,'private.order_counters','select,insert,update') ok", [role])).ok);
      for (const [operation, sql, params] of [
        ['SELECT', 'select * from private.order_counters', []],
        ['INSERT', 'insert into private.order_counters(customer_id,last_seq) values($1,1)', [users[6]]],
        ['UPDATE', 'update private.order_counters set last_seq=last_seq+1 where customer_id=$1', [users[0]]],
        ['DELETE', 'delete from private.order_counters where customer_id=$1', [users[0]]]
      ]) {
        await q('begin');
        let denied = false;
        try {
          await q(`set local role ${role}`);
          await q(sql, params);
        } catch (e) { denied = e.code === '42501'; }
        finally { await q('rollback'); }
        ok(`${role}: ${operation} directo rechazado con 42501`, denied);
      }
    }
    const countersBefore = (await q('select * from private.order_counters order by customer_id')).rows;
    const nameCases = [
      ['Ana','A'],['beto','B'],[' Ñandú','N'],['ñandú','N'],['Íñiguez','I'],
      ['Álvaro','A'],['Érica','E'],['Óscar','O'],['Úrsula','U'],['Çesar','C'],
      ['ÀÄÂÃÅ','A'],['ÈËÊ','E'],['ÌÏÎ','I'],['ÒÖÔÕ','O'],['ÙÜÛ','U'],['Ý','Y'],
      ['áàäâãå','A'],['éèëê','E'],['íìïî','I'],['óòöôõ','O'],['úùüû','U'],['çý','C'],
      ['', 'X'],[null,'X'],[' 123 ! ','X'],['Á'.normalize('NFD'),'A']
    ];
    const collations = (await q(`select n.nspname schema,c.collname name from pg_collation c join pg_namespace n on n.oid=c.collnamespace where c.collname in ('C','POSIX','unicode','und-x-icu') and c.collencoding in (-1,pg_char_to_encoding('UTF8')) order by 1,2`)).rows;
    const ident = s => '"' + s.replace(/"/g, '""') + '"';
    for (const collation of collations) {
      for (const [input, expected] of nameCases) {
        const r = await one(`select private.name_initial($1::text collate ${ident(collation.schema)}.${ident(collation.name)}) initial`, [input]);
        ok(`Inicial ${JSON.stringify(input)} bajo ${collation.name}`, r.initial === expected);
      }
    }
    // Every explicitly supported accented character, in both cases.
    const accented = 'áàäâãåéèëêíìïîóòöôõúùüûñçý';
    const expected = 'AAAAAAEEEEIIIIOOOOOUUUUNCY';
    for (let i = 0; i < accented.length; i++) for (const input of [accented[i], accented[i].toUpperCase()])
      ok(`Transliteración ${input}`, (await one('select private.name_initial($1) initial', [input])).initial === expected[i]);
    const post = async () => {
      const rows = [];
      for (const sql of splitChecks('20261114_despues_codigos_12h.sql')) rows.push((await q(sql)).rows);
      ok('Control posterior 14: cinco consultas', rows.length === 5);
      ok('Control posterior 14: estructura y permisos', Object.values(rows[0][0]).every(v => v === true));
      ok('Control posterior 14: códigos y contadores', Object.values(rows[1][0]).every(v => v === true));
      return rows;
    };
    const post14 = await post();
    equal('Control posterior: totales conservados', post14[2], beforeTotals);
    const yorder = (user, key = null, v = variant) => call(user, 'select public.create_yerba_order($1::jsonb,null,$2::uuid) r', [lines(v), key]);
    const fresh = await yorder(users[0]);
    ok('Nuevo Ñandú Íñiguez genera NI-002', fresh.public_code === 'NI-002');
    ok('Nueva reserva exactamente 12 horas', (await one("select expires_at-created_at=interval '12 hours' ok from public.orders where id=$1", [fresh.id])).ok);
    ok('Campos vacíos generan XX-001', (await yorder(users[3])).public_code === 'XX-001');
    const physical = await one('select stock from public.product_variants where id=$1', [variant]);
    const moveCount = await one('select count(*) n from public.inventory_movements');
    const key = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const repeated = await Promise.all(Array.from({ length: 4 }, () => yorder(users[5], key)));
    ok('4 reintentos concurrentes crean un único pedido', new Set(repeated.map(r => r.id)).size === 1 && repeated.filter(r => r.repeated).length === 3);
    const again = await yorder(users[5], key);
    ok('Reintento secuencial conserva ID y código', again.repeated === true && again.id === repeated[0].id && again.public_code === repeated[0].public_code);
    let rejected = false;
    try { await yorder(users[6], key); } catch (e) { rejected = e.hint === 'invalid_key'; }
    ok('Clave de otra cuenta se rechaza', rejected);
    // Free a pending slot without changing its original deadline or commitment.
    await call(admin, "select public.admin_set_order_status($1,'confirmado') r", [oldOrder.id]);
    const concurrent = await Promise.all(Array.from({ length: 2 }, () => yorder(users[0])));
    equal('Concurrencia Ñandú: NI-003 y NI-004 sin colisiones', concurrent.map(r => r.public_code).sort(), ['NI-003','NI-004']);
    ok('Bajo RLS: el trigger crea contadores nuevos', !countersBefore.some(c => c.customer_id === users[5]) && (await one('select last_seq from private.order_counters where customer_id=$1', [users[5]])).last_seq === 1);
    ok('Bajo RLS: el trigger actualiza el contador concurrentemente', (await one('select last_seq from private.order_counters where customer_id=$1', [users[0]])).last_seq === 4);
    const lastVariant = Number((await one("insert into public.product_variants(product_id,name,price) values($1,'última unidad',1000) returning id", [product])).id);
    await q("insert into public.inventory_movements(variant_id,movement_type,quantity,reason) values($1,'entrada',1,'fixture')", [lastVariant]);
    const race = await Promise.allSettled([users[1],users[2]].map(user => yorder(user, null, lastVariant)));
    ok('Última unidad: un ganador y un rechazo sin sobreventa', race.filter(r => r.status === 'fulfilled').length === 1 && race.some(r => r.status === 'rejected' && r.reason.hint === 'insufficient_stock'));
    equal('Reservas no descuentan stock físico', await one('select stock from public.product_variants where id=$1', [variant]), physical);
    ok('Reservas no generan movimientos', Number((await one('select count(*) n from public.inventory_movements')).n) === Number(moveCount.n) + 1);
    const committed = (await one('select private.committed_qty($1) n', [variant])).n;
    await q('begin');
    await q("update public.orders set expires_at=now() where id=$1", [fresh.id]);
    ok('Reserva se libera al vencer sin mantenimiento', committed - (await one('select private.committed_qty($1) n', [variant])).n === 1);
    await q('commit');
    let immutable = false;
    try { await q("update public.orders set public_code='ZZ-999' where id=$1", [fresh.id]); } catch (e) { immutable = e.hint === 'code_immutable'; }
    ok('Código inmutable', immutable);
    ok('20261114 no crea colas ni funciones de envío', (await one("select to_regclass('private.push_events') is null and to_regclass('private.restock_email_jobs') is null and to_regprocedure('private.push_kick()') is null ok")).ok);
    await post();
    // Successors: validate the intermediate Push label, then the random-code transition.
    let preserved = await snapshot();
    await q(migration('20261115000000_admin_push.sql'));
    equal('20261115 no modifica pedidos, reservas, inventario ni solicitudes', await snapshot(), preserved);
    const pushChecks = splitChecks('20261115_antes_y_despues_push.sql');
    ok('20261115: permisos y estructura', Object.values((await q(pushChecks[1])).rows[0]).every(v => v === true));
    await require('./push-security-db-test.cjs')({ Client, config, database, db, users, admin, call, product, emptyVariant, ok, equal });
    preserved = await snapshot();
    const pushed = await yorder(users[4]);
    const event = await one("select payload from private.push_events where event_key='order:'||$1::text", [pushed.id]);
    ok('20261115: evento Push contiene código intermedio AA-001', event.payload.body.includes('AA-001'));
    const before16 = await snapshot();
    await q(migration('20261116000000_random_public_codes.sql'));
    const after16 = await snapshot();
    equal('20261116 conserva pedidos salvo códigos públicos', after16.orders.map(({ public_code, legacy_public_code, ...o }) => o), before16.orders.map(({ public_code, ...o }) => o));
    ok('20261116 conserva NI-001 como referencia histórica', after16.orders.find(o => o.id === oldOrder.id).legacy_public_code === 'NI-001');
    ok('20261116: códigos PV únicos globales', after16.orders.every(o => /^PV-[A-F0-9]{10}$/.test(o.public_code)) && new Set(after16.orders.map(o => o.public_code)).size === after16.orders.length);
    const newEvent = await one("select payload from private.push_events where event_key='order:'||$1::text", [pushed.id]);
    ok('20261116 actualiza etiqueta Push al código aleatorio', newEvent.payload.body.includes(after16.orders.find(o => o.id === pushed.id).public_code));
    await q(migration('20261117000000_restock_email.sql'));
    equal('20261117 no modifica pedidos ni vencimientos', (await snapshot()).orders, after16.orders);
    const requests = (await q('select * from public.restock_requests')).rows;
    ok('20261117: solicitudes anteriores sin consentimiento', requests.every(r => r.email_consent_at === null));
    ok('20261117: no crea trabajos para solicitudes anteriores', (await one('select count(*)::int n from private.restock_email_jobs')).n === 0);
    const finalChecks = [];
    for (const sql of splitChecks('20261117_codigos_email.sql')) finalChecks.push((await q(sql)).rows);
    ok('Control final 20261117: todos los indicadores true', Object.values(finalChecks[0][0]).every(v => v === true));
    const finalNew = await yorder(users[3]);
    ok('Con secuencia completa: nuevo código PV y reserva de 12 horas', /^PV-[A-F0-9]{10}$/.test(finalNew.public_code) && (await one("select expires_at-created_at=interval '12 hours' ok from public.orders where id=$1", [finalNew.id])).ok);
    for (const table of ['order_items','inventory_movements','product_variants','order_events','restock_requests']) {
      const current = (await snapshot())[table];
      // Compare the original rows, allowing only additive email metadata.
      const original = preserved[table];
      for (const old of original) {
        const row = current.find(r => r.id === old.id);
        ok(`Sucesoras conservan fila ${table}:${old.id}`, !!row && Object.keys(old).every(k => canonical(row[k]) === canonical(old[k])));
      }
    }
    return { engine: await one('select version() version'), databaseLocale: await one('select datctype,datcollate from pg_database where datname=current_database()'), collations, checks: checks.length, failures: 0, names: checks, post14, finalChecks };
  } finally {
    if (db) await db.end();
    await control.query(`drop database if exists ${database}`);
    await control.end();
  }
}

module.exports = { run };
if (require.main === module) {
  const { Client } = require(require.resolve('pg', { paths: [process.env.PW || __dirname] }));
  run({ Client, root: path.resolve(process.argv[2] || path.join(__dirname, '..')), port: Number(process.argv[3] || 55448) })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
