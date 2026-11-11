// Private Unix-socket compiler inside the guest. Never exposed through preview HTTP.
import net from 'node:net';
import fs from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const VERSION=2;
export function compilerPaths(root){const dir=process.env.SNOWGLOBE_COMPILER_DIR||'/var/lib/snowglobe-builder';const name=createHash('sha256').update(root).digest('hex').slice(0,12);return {dir,socket:path.join(dir,'compiler-'+name+'.sock'),revision:path.join(dir,'revision-'+name+'.json'),log:path.join(dir,'compiler-'+name+'.log')};}
async function revision(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return {value:0,epoch:0};}}
export async function sourceChanged(root,file){const p=compilerPaths(root);await fs.mkdir(p.dir,{recursive:true});const r=await revision(p.revision);r.value++;if(!file.startsWith('src/')&&file!=='index.html')r.epoch++;const tmp=p.revision+'.new';await fs.writeFile(tmp,JSON.stringify(r));await fs.rename(tmp,p.revision);return r;}
export async function startCompilerServer(root,{loadVite=()=>import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')).href)}={}){
 const p=compilerPaths(root);await fs.mkdir(p.dir,{recursive:true});try{await fs.access(p.revision);}catch{await fs.writeFile(p.revision,JSON.stringify({value:0,epoch:0}));}
 let watcher=null,epoch=-1,busy=false,settled=-1,started=-1,lastError=null,generation=0,booting=null,logs=[],closing=false;
 const clients=new Set();
 const emit=(stage,message,extra={})=>{for(const c of clients)if(!c.destroyed)c.write(JSON.stringify({type:'progress',stage,message,...extra})+'\n');};
 const logger=(message)=>{const text=String(message).replace(/\x1b\[[0-9;]*m/g,'').slice(0,1000);logs.push(text);logs=logs.slice(-60);emit('compiler-output','The compiler is working',{log:text});};
 const reply=async()=>{
   if(busy||booting||closing)return;
   for(const c of clients){if(c.target===undefined||settled<c.target)continue;
     c.finished=true;c.end(JSON.stringify({type:'result',ok:c.quiesce||!lastError,error:c.quiesce?null:lastError,result:{version:VERSION,generation,revision:settled,diagnostics:logs.join('\n').slice(-12000),warm:c.warm}})+'\n');clients.delete(c);
   }
 };
 async function ensure(r){
   if(watcher&&epoch===r.epoch)return;
   if(booting)return booting;
   booting=(async()=>{
     if(watcher){await watcher.close();watcher=null;}
     emit('compiler-start','Starting the persistent app compiler');logs=[];settled=-1;lastError=null;epoch=r.epoch;
     const vite=await loadVite();
     watcher=await vite.build({root,base:'./',clearScreen:false,customLogger:{info:logger,warn:logger,warnOnce:logger,error:logger,clearScreen(){},hasErrorLogged(){return false;},hasWarned:false},
       build:{reportCompressedSize:false,watch:{buildDelay:100},rolldownOptions:{experimental:{incrementalBuild:true},output:{codeSplitting:false}}},plugins:[{name:'snowglobe-build-revision',transformIndexHtml:{order:'pre',handler(){return [{tag:'script',attrs:{type:'module'},children:"import 'virtual:snowglobe-builder-revision';",injectTo:'head'}];}},resolveId(id){if(id==='virtual:snowglobe-builder-revision')return '\0snowglobe-builder-revision';},async load(id){if(id==='\0snowglobe-builder-revision'){this.addWatchFile(p.revision);return 'export default '+(await revision(p.revision)).value+';';}},async buildStart(){busy=true;started=(await revision(p.revision)).value;emit('compiling','Compiling the latest source and reusing cached packages');}}]});
     watcher.on('event',e=>{
       if(e.code==='START'||e.code==='BUNDLE_START')busy=true;
       if(e.code==='BUNDLE_END'||e.code==='ERROR'){
         settled=started;lastError=e.code==='ERROR'?String(e.error?.message??e.error).slice(-12000):null;generation++;
         // Vite owns result.close(); retain the watcher across builds.
       }
       if(e.code==='END'){busy=false;emit(lastError?'compiler-error':'compiled',lastError?'The compiler found an error':'The latest source is compiled');setTimeout(()=>reply().catch(()=>{}),100);}
     });
   })();
   try{await booting;}finally{booting=null;}
 }
 const server=net.createServer(c=>{
   c.setEncoding('utf8');let buffer='';clients.add(c);
   c.on('data',async chunk=>{buffer+=chunk;if(buffer.length>4096){c.destroy();return;}if(!buffer.includes('\n')||c.requested)return;c.requested=true;
     try{
       const request=JSON.parse(buffer.split('\n')[0]);
       if(request.op==='stop'){c.finished=true;closing=true;c.end(JSON.stringify({type:'result',ok:true})+'\n',()=>{if(process.env.SNOWGLOBE_COMPILER_CHILD==='1')setTimeout(()=>{try{process.kill(-process.pid,'SIGTERM');}catch{process.exit(0);}},25);});if(process.env.SNOWGLOBE_COMPILER_CHILD!=='1'){await watcher?.close();server.close();}return;}
       if(!['build','quiesce'].includes(request.op))throw new Error('Unknown compiler operation');
       const r=await revision(p.revision);c.quiesce=request.op==='quiesce';c.target=r.value;c.warm=!!watcher&&epoch===r.epoch;
       if(request.op==='quiesce'&&!watcher&&!booting){c.finished=true;c.end(JSON.stringify({type:'result',ok:true,result:{idle:true}})+'\n');clients.delete(c);return;}
       emit('compiler-wait',c.warm?'Reusing the running compiler and cached packages':'Preparing your first compilation');
       await ensure(r);await reply();
     }catch(e){c.finished=true;c.end(JSON.stringify({type:'result',ok:false,error:String(e.message).slice(-12000)})+'\n');clients.delete(c);}
   });
   c.on('error',()=>{});
   c.on('close',()=>{clients.delete(c);if(c.requested&&!c.finished&&c.target!==undefined){
     // Cancellation of an active build kills the detached guest process group, including workers.
     if(process.env.SNOWGLOBE_COMPILER_CHILD==='1'){try{process.kill(-process.pid,'SIGTERM');}catch{process.exit(1);}}
   }});
 });
 await fs.rm(p.socket,{force:true});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(p.socket,resolve);});await fs.chmod(p.socket,0o600);
 const heartbeat=setInterval(()=>emit('heartbeat','Your environment and compiler are responding'),1000);
 server.on('close',()=>clearInterval(heartbeat));
 return {server,async close(){closing=true;for(const c of clients){c.finished=true;c.destroy();}await watcher?.close();await new Promise(r=>server.close(r));await fs.rm(p.socket,{force:true});}};
}
export async function compilerRequest(root,op,onProgress=()=>{}){
 const p=compilerPaths(root);
 async function connect(){return new Promise((resolve,reject)=>{const c=net.connect(p.socket);c.once('error',reject);c.once('connect',()=>{c.removeListener('error',reject);resolve(c);});});}
 let socket;
 try{socket=await connect();}catch(e){
   if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;
   if(op!=='build')return {idle:true};
   await fs.mkdir(p.dir,{recursive:true});await fs.rm(p.socket,{force:true});
   const fd=openSync(p.log,'w',0o600);const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve',root],{detached:true,stdio:['ignore','ignore',fd],env:{...process.env,SNOWGLOBE_COMPILER_CHILD:'1'}});child.unref();closeSync(fd);
   for(let n=0;n<300;n++){try{socket=await connect();break;}catch{await new Promise(r=>setTimeout(r,100));}}
   if(!socket)throw new Error('The persistent compiler could not start. '+(await fs.readFile(p.log,'utf8').catch(()=>'' )).slice(-2000));
 }
 const result=await new Promise((resolve,reject)=>{let buffer='',done=false;socket.setEncoding('utf8');socket.on('error',reject);socket.on('end',()=>{if(!done)reject(new Error('Compiler disconnected before completing the build'));});socket.on('data',chunk=>{buffer+=chunk;for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const event=JSON.parse(line);if(event.type==='progress')onProgress(event.stage,event.message,event.log?{log:event.log}:{});else if(event.type==='result'){done=true;socket.end();if(event.ok)resolve(event.result??{});else reject(new Error(event.error));}}catch(e){reject(e);socket.destroy();}}});socket.write(JSON.stringify({op,version:VERSION})+'\n');});
 if(op==='build'&&result.version!==VERSION){
   onProgress('compiler-upgrade','Updating the compiler for this Builder version');await compilerRequest(root,'stop');
   let stopped=false;for(let n=0;n<40;n++){try{const probe=await connect();probe.destroy();}catch{stopped=true;break;}await new Promise(r=>setTimeout(r,100));}
   if(!stopped)throw new Error('The previous compiler did not stop for its update. Stop and retry.');
   return compilerRequest(root,op,onProgress);
 }
 return result;
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href&&process.argv[2]==='--serve'){
 await startCompilerServer(process.argv[3]);
}
