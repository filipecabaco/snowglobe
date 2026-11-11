// Guest-only bootstrap. A small serial job starts an authenticated binary upload;
// the bridge itself travels over TCP. Supabase's private environment stays here.
import fs from 'node:fs/promises';import {spawn} from 'node:child_process';import {gunzipSync} from 'node:zlib';import net from 'node:net';import http from 'node:http';import {createHash,timingSafeEqual} from 'node:crypto';
const directory='/var/lib/snowglobe-builder',binary=directory+'/console-bridge',config=directory+'/console.json',pidfile=directory+'/console.pid',uploader=directory+'/console-start.mjs',uploadPid=directory+'/console-upload.pid';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function listening(port){return new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});let finished=false;const done=value=>{if(finished)return;finished=true;socket.destroy();resolve(value);};socket.setTimeout(1000,()=>done(false));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});}
async function spawnService(executable,args){const log=await fs.open(directory+'/console.log','a',0o600);try{const child=spawn(executable,args,{env:process.env,detached:true,stdio:['ignore',log.fd,log.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Guest console could not start')));});child.unref();return child.pid;}finally{await log.close();}}
async function stopOwned(file,check){try{const pid=Number(await fs.readFile(file,'utf8'));if(Number.isSafeInteger(pid)&&pid>1&&await check(pid)){try{process.kill(pid,'SIGTERM');}catch{}for(let i=0;i<20;i++){try{process.kill(pid,0);}catch{return;}await delay(50);}try{process.kill(pid,'SIGKILL');}catch{}await delay(100);}}catch{}}
if(process.argv[2]==='--serve'){
 const request=JSON.parse(await fs.readFile(config,'utf8'));let uploading=false;
 const server=http.createServer(async(req,res)=>{
  const supplied=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1]||'';
  if(supplied.length!==request.token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(request.token))){res.writeHead(401,{'Connection':'close'});return res.end();}
  if(req.method!=='POST'||req.url!=='/bridge'||uploading||Number(req.headers['content-length'])!==request.bridgeSize){res.writeHead(400,{'Connection':'close'});return res.end();}
  uploading=true;
  try{
   let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>request.bridgeSize)throw Error('Console upload exceeds limit');chunks.push(chunk);}
   const bytes=Buffer.concat(chunks);if(bytes.length!==request.bridgeSize||createHash('sha256').update(bytes).digest('hex')!==request.bridgeSha256)throw Error('Console upload checksum mismatch');
   await fs.writeFile(binary,gunzipSync(bytes,{maxOutputLength:8*1024*1024}),{mode:0o700});await fs.chmod(binary,0o700);
   await fs.writeFile(pidfile,String(await spawnService(binary,[config])),{mode:0o600});
   const deadline=Date.now()+20000;while(!await listening(54323)){if(Date.now()>deadline)throw Error('Guest console did not become ready');await delay(200);}
   res.writeHead(200,{'Content-Type':'application/json','Content-Length':'14','Connection':'close'});res.end('{"ready":true}');server.close();clearTimeout(timer);
  }catch{uploading=false;res.writeHead(500,{'Connection':'close'});res.end('Console setup failed');}
 });
 const timer=setTimeout(()=>server.close(()=>process.exit(0)),180000);server.listen(54324,'0.0.0.0');
}else{
 const request=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
 if(!/^[a-f0-9]{64}$/.test(request.token)||!['/workspace','/home/supa/app'].includes(request.cwd)||!Number.isSafeInteger(request.bridgeSize)||request.bridgeSize<1||request.bridgeSize>4*1024*1024||!/^[a-f0-9]{64}$/.test(request.bridgeSha256))throw Error('Invalid console setup');
 await fs.mkdir(directory,{recursive:true});try{await fs.access(request.cwd);}catch{throw Error('Prepare this project before opening its console');}
 await stopOwned(pidfile,async pid=>(await fs.readlink('/proc/'+pid+'/exe'))===binary);
 await stopOwned(uploadPid,async pid=>(await fs.readFile('/proc/'+pid+'/cmdline','utf8')).split('\0').includes(uploader));
 await fs.writeFile(config,JSON.stringify(request),{mode:0o600});await fs.chmod(config,0o600);await fs.copyFile(process.argv[1],uploader);
 const args=[...(process.env.BUN_BE_BUN==='1'?['run']:[]),uploader,'--serve'];await fs.writeFile(uploadPid,String(await spawnService(process.execPath,args)),{mode:0o600});
 const deadline=Date.now()+20000;while(!await listening(54324)){if(Date.now()>deadline)throw Error('Console upload did not become ready');await delay(200);}
 console.log('BUILDER_CONSOLE_UPLOAD_READY');
}
