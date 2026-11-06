// Cache the pinned public browser SDK and its ESM imports. No Supabase project calls.
const https=require('node:https'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
async function run(){
 const dir=path.join(os.tmpdir(),'povmatero-browser-sdk-2.117.3');await fs.mkdir(dir,{recursive:true});
 const queue=['/npm/@supabase/supabase-js@2.117.3/+esm'],map={};
 for(let i=0;i<queue.length;i++){
  const modulePath=queue[i];if(map[modulePath])continue;
  if(Object.keys(map).length>=40||!/^\/npm\/[^?#]+\/\+esm$/.test(modulePath))throw Error('Unexpected SDK import');
  const text=await new Promise((resolve,reject)=>{const req=https.get('https://cdn.jsdelivr.net'+modulePath,response=>{
   if(response.statusCode!==200){response.resume();reject(Error('SDK HTTP '+response.statusCode));return;}
   response.setEncoding('utf8');let body='';response.on('data',s=>body+=s);response.on('end',()=>resolve(body));response.on('error',reject);
  });req.setTimeout(15000,()=>req.destroy(Error('SDK timeout')));req.on('error',reject);});
  const file=path.join(dir,String(Object.keys(map).length).padStart(2,'0')+'.js');await fs.writeFile(file,text);map[modulePath]=file;
  for(const m of text.matchAll(/"(\/npm\/[^"\s]+\+esm)"/g))queue.push(m[1]);
 }
 await fs.writeFile(path.join(dir,'map.json'),JSON.stringify(map,null,2));console.log('Offline SDK cache:',dir,'—',Object.keys(map).length,'modules');
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});module.exports={run};
