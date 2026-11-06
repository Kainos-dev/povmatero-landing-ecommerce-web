// Run existing concurrency assertions against a disposable database on a local cluster.
// Avoids starting extra OS services and never reads production connection credentials.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),moduleApi=require('node:module'),os=require('node:os');
async function run({Client,root=path.resolve(__dirname,'..'),port=55448,dependencyRoot,suite='codes-push-concurrency-test.cjs'}){
 if(!['codes-push-concurrency-test.cjs','legacy/concurrency-test.cjs','cancel-concurrency-test.cjs','shelf-order-concurrency-test.cjs'].includes(suite))throw Error('Unsupported concurrency suite');
 const config={host:'127.0.0.1',port,user:'postgres',password:'local-test-only',ssl:false,connectionTimeoutMillis:5000};
 const database=`povmatero_concurrency_${Date.now()}_${require('node:crypto').randomBytes(4).toString('hex')}`,control=new Client({...config,database:'postgres'}),clients=[],logs=[];
 await control.connect();let timer;
 try{
  await control.query(`create database ${database} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`);
  for(const [role,suffix]of[['anon',''],['authenticated',''],['service_role',' bypassrls']])if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await control.query(`create role ${role} nologin${suffix}`);
  class LocalClient extends Client{
   constructor(){super({...config,database});clients.push(this);}
   query(sql,...params){return super.query(typeof sql==='string'?sql.replace(/create role [^;]+;/g,''):sql,...params);}
  }
  class ExistingCluster{async initialise(){}async start(){}async stop(){}}
  const file=path.join(root,'tests',suite),baseRequire=moduleApi.createRequire(file),safeFs={...fs,rmSync(target){if(fs.existsSync(target))throw Error('This runner never creates a data directory; refusing deletion');}};
  const req=name=>{const resolved=baseRequire.resolve(name);if(name==='fs'||name==='node:fs')return safeFs;if(resolved.includes('embedded-postgres'))return{default:ExistingCluster};if(resolved===baseRequire.resolve('pg',{paths:[dependencyRoot]}))return{Client:LocalClient};return baseRequire(name);};req.resolve=baseRequire.resolve;
  let finish;const done=new Promise(r=>finish=r),fakeProcess={env:{PW:dependencyRoot},argv:['node',file,root,os.tmpdir()],exitCode:0,exit(code){fakeProcess.exitCode=code;finish();}};
  const box={require:req,__dirname:path.dirname(file),__filename:file,process:fakeProcess,console:{log:(...a)=>logs.push(a.join(' ')),error:(...a)=>logs.push(a.map(x=>x?.stack||String(x)).join(' '))},Buffer,URL,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),box,{filename:file});
  timer=setTimeout(()=>{fakeProcess.exitCode=3;logs.push('Test timeout');finish();},60000);await done;clearTimeout(timer);
  const count=logs.join('\n').match(/(?:^|\n)(\d+) OK[^\n]*?([0-9]+) falla/i);
  return{suite,exitCode:fakeProcess.exitCode,checks:Number(count?.[1]||0),failures:Number(count?.[2]||(fakeProcess.exitCode?1:0)),logs};
 }finally{clearTimeout(timer);await Promise.allSettled(clients.map(c=>c.end()));await control.query(`drop database if exists ${database}`);await control.end();}
}
module.exports={run};if(require.main===module){const {Client}=require(require.resolve('pg',{paths:[process.env.PW||__dirname]}));run({Client,dependencyRoot:process.env.PW,suite:process.argv[2]||'codes-push-concurrency-test.cjs',root:path.resolve(process.argv[3]||path.join(__dirname,'..')),port:Number(process.argv[4]||55448)}).then(r=>{console.log(JSON.stringify(r,null,2));process.exitCode=r.exitCode;}).catch(e=>{console.error(e);process.exitCode=1;});}
