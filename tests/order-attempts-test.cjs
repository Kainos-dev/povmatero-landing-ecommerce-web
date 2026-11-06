// Load the real frontend module into a clock/storage sandbox, without a build step.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
async function run({root=path.resolve(__dirname,'..')}={}){
 const source=fs.readFileSync(path.join(root,'js/yerbas/orderAttempts.js'),'utf8').replace('export function createOrderAttempts','function createOrderAttempts');
 const storage=()=>({data:new Map(),getItem(k){return this.data.get(k)??null},setItem(k,v){this.data.set(k,v)},removeItem(k){this.data.delete(k)}});
 const shared=storage(),legacy=storage();let now=1000000;const names=[],ok=(n,v)=>{assert.ok(v,n);names.push(n);};
 const make=()=>{const box={Date:{now:()=>now},TextEncoder,Uint8Array,globalThis:{}};vm.runInNewContext(source+'\nthis.factory=createOrderAttempts;',box);return box.factory({storage:shared,legacyStorage:legacy,crypto:crypto.webcrypto});};
 let a=make();const first=await a.prepare('account-a','1:2','cart-1');
 ok('UUID válido para client_key',/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(first.key));
 for(const hours of [5,6,7,12,13,48]){now=1000000+hours*3600000;ok(`Respuesta perdida: misma clave a ${hours} h`,(await a.prepare('account-a','1:2','cart-1')).key===first.key);}
 a=make();ok('Recarga conserva clave',(await a.prepare('account-a','1:2','cart-1')).key===first.key);
 const other=await a.prepare('account-b','1:2','cart-1');ok('Otra cuenta tiene clave distinta',other.key!==first.key);
 ok('Volver a cuenta original recupera pendiente',(await a.prepare('account-a','1:2','cart-1')).key===first.key);
 const changed=await a.prepare('account-a','1:3','cart-2');ok('Carrito distinto es otra operación',changed.key!==first.key);
 ok('Restaurar carrito pendiente recupera intento anterior',(await a.prepare('account-a','1:2','cart-3')).key===first.key);
 a.complete(first);const second=await a.prepare('account-a','1:2','new-cart-after-success');ok('Segunda compra legítima usa clave nueva',second.key!==first.key);
 a.complete(first);ok('Acuse viejo no resuelve una nueva compra',a.find('account-a','1:2').key===second.key&&a.find('account-a','1:2').status==='pending');
 const concurrent=await Promise.all(Array.from({length:8},()=>make().prepare('account-c','2:4','shared-cart')));ok('8 pestañas sin Web Locks obtienen una sola clave',new Set(concurrent.map(r=>r.key)).size===1);
 legacy.setItem('povmatero-yerbas-attempt',JSON.stringify({owner:'old-account',signature:'3:1',key:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',at:0}));
 const adopted=await make().prepare('old-account','3:1','legacy');ok('Actualización del frontend conserva clave anterior aunque tenga más de 6 h',adopted.key==='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
 ok('Consentimiento/cuentas no se mezclan: otro dueño no adopta clave antigua',(await make().prepare('another-account','3:1','legacy')).key!==adopted.key);
 const box={TextEncoder,Uint8Array,Date,globalThis:{}};vm.runInNewContext(source+'\nthis.factory=createOrderAttempts;',box);const broken=box.factory({storage:{getItem(){return null},setItem(){throw Error('quota')}},crypto:crypto.webcrypto});let blocked=false;try{await broken.prepare('account','1:1','cart');}catch(e){blocked=e.hint==='attempt_storage';}ok('Sin persistencia se bloquea el envío en vez de perder idempotencia',blocked);
 return {checks:names.length,failures:0,names};
}
module.exports={run};if(require.main===module)run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
