// Public test assets only; never contacts application services.
const https=require('node:https'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
async function download(url){
 const u=new URL(url);if(!['fonts.googleapis.com','fonts.gstatic.com'].includes(u.hostname)||u.protocol!=='https:')throw Error('Unexpected font host');
 return new Promise((resolve,reject)=>{const req=https.get(u,res=>{if(res.statusCode!==200){res.resume();reject(Error('Font HTTP '+res.statusCode));return;}const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>2e6)res.destroy(Error('Font too large'));else chunks.push(b);});res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);});req.setTimeout(30000,()=>req.destroy(Error('Font timeout')));req.on('error',reject);});
}
async function run(){
 const dir=path.join(os.tmpdir(),'povmatero-browser-font');await fs.mkdir(dir,{recursive:true});
 const css=await download('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
 const urls=[...new Set(css.toString().match(/https:\/\/fonts\.gstatic\.com\/s\/inter\/[^)\s]+/g)||[])];
 if(!urls.length||urls.length>20)throw Error('Unexpected font stylesheet');
 for(const url of urls)await fs.writeFile(path.join(dir,path.basename(new URL(url).pathname)),await download(url));
 await fs.writeFile(path.join(dir,'inter.css'),css);console.log('Offline Inter cache:',dir);
}
module.exports={run};if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
