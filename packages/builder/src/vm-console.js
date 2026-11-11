// Only the owner UI imports this transport. It is not an agent tool or preview relay.
import installer from './console-start.mjs?raw';
const encode=new TextEncoder();
const base64=bytes=>{let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);};
export class VmConsole {
 constructor(api,{assetUrl=new URL('console-bridge.gz',location.href),onOutput=()=>{},onClose=()=>{},onDirty=()=>{},onProgress=()=>{}}={}){Object.assign(this,{api,assetUrl,onOutput,onClose,onDirty,onProgress});this.installed=new WeakMap();}
 async install(runtime,signal){
  await this.api.wake(runtime);signal?.throwIfAborted();const host=this.api._get(runtime).host;
  if(this.installed.has(host))return this.installed.get(host);
  this.onProgress('Installing the interactive console in this VM. First setup can take a few minutes…');
  this.binary??=fetch(this.assetUrl,{credentials:'omit'}).then(async response=>{if(!response.ok)throw Error('Console bridge is unavailable. Rebuild Builder before retrying.');const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>4*1024*1024)throw Error('Console bridge exceeds its size limit');return bytes;}).catch(error=>{this.binary=null;throw error;});
  const bytes=await this.binary;signal?.throwIfAborted();
  const token=(crypto.randomUUID()+crypto.randomUUID()).replaceAll('-',''),bridgeSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join(''),request={token,cwd:runtime==='web'?'/workspace':'/home/supa/app',bridgeSha256,bridgeSize:bytes.length};
  const command=(runtime==='web'?'node':'BUN_BE_BUN=1 supabase run')+' "$EXCLAVE_WORKSPACE/in/console-start.mjs" "$EXCLAVE_WORKSPACE/in/request.json"';
  const {jobId}=await this.api.runCommand({runtime,command,timeoutSeconds:300},{wrap:true,files:{'console-start.mjs':encode.encode(installer),'request.json':encode.encode(JSON.stringify(request))}});
  const abort=()=>{void this.api.cancelJob(jobId).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{let job;do{signal?.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,250));job=await this.api.readJob(jobId);}while(job.state==='running');signal?.throwIfAborted();if(job.state!=='exited'||job.exitStatus!==0||!job.output?.includes('BUILDER_CONSOLE_UPLOAD_READY'))throw Error('Console setup failed: '+(job.error||job.output?.slice(-600)||job.state));}
  finally{signal?.removeEventListener('abort',abort);}
  if(this.api._get(runtime).host!==host)throw Error('The VM changed during console setup. Reconnect.');
  const release=this.api._hold(runtime);try{await this.upload(host,token,bytes,signal);}finally{release();}
  const installed={host,token};this.installed.set(host,installed);return installed;
 }
 upload(host,token,bytes,signal){return new Promise((resolve,reject)=>{
  const stream=host.tcpOpen(54324),decoder=new TextDecoder();let response='',settled=false;
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);stream.abort();error?reject(error):resolve();};
  const abort=()=>finish(new DOMException('Console upload stopped','AbortError'));
  const timer=setTimeout(()=>finish(Error('Console upload timed out. Reconnect to retry.')),90000);
  stream.onconnect=async()=>{try{await stream.write(encode.encode('POST /bridge HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+token+'\r\nContent-Length: '+bytes.length+'\r\nConnection: close\r\n\r\n'));for(let offset=0;offset<bytes.length&&!settled;offset+=65536){signal?.throwIfAborted();await stream.write(bytes.subarray(offset,offset+65536));this.onProgress('Uploading console helper · '+Math.min(100,Math.round((offset+65536)*100/bytes.length))+'%');}}catch(error){finish(error);}};
  stream.ondata=data=>{response+=decoder.decode(data,{stream:true});if(response.length>16384)finish(Error('Invalid console upload response'));};
  const completed=()=>{if(settled)return;try{const separator=response.indexOf('\r\n\r\n');if(!/^HTTP\/1\.[01] 200\b/.test(response)||separator<0||JSON.parse(response.slice(separator+4)).ready!==true)throw Error('Console upload failed. Reconnect to retry.');finish();}catch(error){finish(error);}};
  stream.onend=completed;stream.onclose=completed;stream.onerror=error=>finish(error);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });}
 async connect(runtime,{signal,cols=80,rows=24}={}){
  await this.disconnect();const {host,token}=await this.install(runtime,signal);signal?.throwIfAborted();
  const release=this.api._hold(runtime),stream=host.tcpOpen(54323),decoder=new TextDecoder();let buffer='',settled=false,resolveReady,rejectReady,resolveClosed;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;}),closed=new Promise(resolve=>resolveClosed=resolve);
  const session=this.session={runtime,host,stream,closed,dirty:false,connected:false,write:value=>stream.write(encode.encode(JSON.stringify(value)+'\n'))};
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);release();if(error)this.installed.delete(host);if(this.session===session)this.session=null;rejectReady(error||Error('Console session ended'));resolveClosed();this.onClose(error);};
  const abort=()=>{stream.abort();finish(new DOMException('Console connection stopped','AbortError'));};
  const timer=setTimeout(()=>{stream.abort();finish(Error('Console did not answer. Reconnect to retry.'));},20000);
  stream.onconnect=()=>{void session.write({type:'open',token,cols,rows});};
  stream.ondata=bytes=>{try{buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>256*1024)throw Error('Console output frame exceeds limit');for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const event=JSON.parse(line);if(event.type==='ready'){clearTimeout(timer);session.connected=true;resolveReady();}else if(event.type==='output'&&session.connected&&typeof event.data==='string'&&event.data.length<=65536)this.onOutput(Uint8Array.from(atob(event.data),char=>char.charCodeAt(0)));else if(event.type==='error')throw Error(event.message||'Console failed');else throw Error('Unexpected console response');}}catch(error){stream.abort();finish(error);}};
  stream.onend=()=>finish();stream.onclose=()=>finish();stream.onerror=error=>finish(error);session.finish=finish;
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();await ready;signal?.throwIfAborted();
 }
 input(text){const session=this.session;if(!session?.connected)return;const machine=this.api._get(session.runtime);machine.dirty=true;machine.lifecycle.touch();if(!session.dirty){session.dirty=true;this.onDirty(session.runtime);}const bytes=encode.encode(text);for(let offset=0;offset<bytes.length;offset+=16384)void session.write({type:'input',data:base64(bytes.subarray(offset,offset+16384))});}
 resize(cols,rows){if(this.session?.connected)void this.session.write({type:'resize',cols:Math.min(500,Math.max(2,cols)),rows:Math.min(300,Math.max(2,rows))});}
 async disconnect(){const session=this.session;if(!session)return;if(session.closing)return session.closing;session.closing=(async()=>{try{await session.write({type:'close'});await Promise.race([session.closed,new Promise(resolve=>setTimeout(resolve,1500))]);}finally{session.stream.abort();session.finish();}})();return session.closing;}
}
