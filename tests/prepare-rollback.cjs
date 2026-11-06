// Local source bundle only. No Vercel commands, network, credentials or SQL execution.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const BASE='06400b4d1de0e62fc288763d2576c70ef31d1228';
const OLD_SHELL=['admin/admin.css','admin/index.html','admin/js/icons.js','admin/js/main.js','admin/js/router.js','admin/js/views/more.js'];
const runtime=f=>/^(admin|api|js|css|images)\//.test(f)||['index.html','yerbas.html','mp4.mp4','vercel.json','.vercelignore'].includes(f);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function run({root=path.resolve(__dirname,'..')}={}){
 const git=args=>cp.execFileSync('git',args,{cwd:root});
 if(git(['branch','--show-current']).toString().trim()!=='dev')throw Error('Build only from dev');
 const files=[...new Set(git(['ls-files','-z','--cached','--others','--exclude-standard']).toString().split('\0').filter(Boolean))].filter(runtime).sort();
 const parent=path.join(root,'.release-local');await fs.mkdir(parent,{recursive:true});
 const dir=await fs.mkdtemp(path.join(parent,'rollback-14-17-')),site=path.join(dir,'site');await fs.mkdir(site);
 const manifest={format:1,kind:'compatibility-rescue-source',createdAt:new Date().toISOString(),baseCommit:BASE,workingHead:git(['rev-parse','HEAD']).toString().trim(),branch:'dev',productionDeployment:'UNVERIFIED',productionSha:'UNVERIFIED',notifications:'FORCED_OFF_IN_ARTIFACT',oldShell:OLD_SHELL,files:[]};
 for(const file of files){
  if(file.includes('..')||file.includes('\\')||path.isAbsolute(file)||(!/\.(js|html|css|png|jpe?g|webp|svg|ico|mp4|json|webmanifest)$/i.test(file)&&file!=='.vercelignore'))throw Error('Unexpected runtime file: '+file);
  const stat=await fs.lstat(path.join(root,file));if(!stat.isFile()||stat.isSymbolicLink())throw Error('Nonregular file: '+file);
  const source=await fs.readFile(path.join(root,file));let body=source,origin='approved-working-tree';
  if(OLD_SHELL.includes(file)){body=git(['show',BASE+':'+file]);origin='base-admin-shell';}
  if(file==='api/_lib/webpush.js'){
   const old='const pushEnabled = (env = process.env) => env.PUSH_ENABLED === "true";';
   if(!body.toString().includes(old))throw Error('Push guard changed; review rescue patch');
   body=Buffer.from(body.toString().replace(old,'const pushEnabled = () => false; // Rescue artifact: permanently disabled.'));origin='approved-with-rescue-guard';
  }
  if(file==='api/_lib/restock-email.js'){
   const text=body.toString(),start=text.indexOf('function configured(env) {'),end=text.indexOf('\nasync function rpc(',start);
   if(start<0||end<0)throw Error('Email guard changed; review rescue patch');
   body=Buffer.from(text.slice(0,start)+'function configured() { return false; } // Rescue artifact: permanently disabled.\n'+text.slice(end));origin='approved-with-rescue-guard';
  }
  if(/\.(js|html|css|json|webmanifest)$/i.test(file)&&/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sb_secret_[A-Za-z0-9_-]{15,}|\bre_[A-Za-z0-9]{25,}/.test(body.toString()))throw Error('Possible secret; inspect locally: '+file);
  const dest=path.join(site,file);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,body);
  manifest.files.push({path:file,bytes:body.length,sha256:sha(body),approvedSourceSha256:sha(source),origin});
 }
 manifest.treeSha256=sha(manifest.files.map(f=>f.path+'\0'+f.sha256+'\n').join(''));
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 await fs.writeFile(path.join(dir,'RECOVERY.txt'),'LOCAL SOURCE ARTIFACT, NOT A VERCEL DEPLOYMENT.\nDeploy only site/ after explicit authorization and read PUBLICACION-Y-ROLLBACK.md.\nNever run SQL rollbacks. Email and Push are forced off. Existing cron configuration is unchanged.\n');
 return{dir,site,manifestPath:path.join(dir,'manifest.json'),files:files.length,treeSha256:manifest.treeSha256};
}
async function seal({dir,dependencyRoot=process.env.PW,root=path.resolve(__dirname,'..')}){
 const resolved=await fs.realpath(dir),parent=await fs.realpath(path.join(root,'.release-local'));
 if(!resolved.startsWith(parent+path.sep))throw Error('Artifact must be inside .release-local');
 const {yazl}=require(require.resolve('playwright-core/lib/zipBundle',{paths:[dependencyRoot]}));
 const nativeFs=require('node:fs'),zip=new yazl.ZipFile(),archive=resolved+'.zip';
 const add=async(folder,prefix='')=>{for(const item of await fs.readdir(folder,{withFileTypes:true})){if(item.isSymbolicLink())throw Error('Symlink forbidden');const file=path.join(folder,item.name),name=prefix+item.name;if(item.isDirectory())await add(file,name+'/');else zip.addFile(file,name);}};
 await add(resolved);
 await new Promise((resolve,reject)=>{const out=nativeFs.createWriteStream(archive,{flags:'wx'});out.on('close',resolve);out.on('error',reject);zip.outputStream.on('error',reject);zip.outputStream.pipe(out);zip.end();});
 const hash=crypto.createHash('sha256');for await(const chunk of nativeFs.createReadStream(archive))hash.update(chunk);
 const sha256=hash.digest('hex');await fs.writeFile(archive+'.sha256',sha256+'  '+path.basename(archive)+'\n',{flag:'wx'});
 return{archive,sha256,bytes:(await fs.stat(archive)).size};
}
module.exports={run,seal,OLD_SHELL};if(require.main===module)(process.argv[2]==='--seal'?seal({dir:path.resolve(process.argv[3])}):run()).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
