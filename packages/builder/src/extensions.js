import {requireApproval} from './approvals.js';
const CAPABILITIES=new Set(['files:list','files:read']);
export function validateExtension(value){
 if(!value||value.version!==1||typeof value.id!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id)||value.id.length>64)throw new Error('Invalid Builder extension identifier/version');
 if(typeof value.name!=='string'||!value.name.trim()||value.name.length>80||typeof value.description!=='string'||value.description.length>512)throw new Error('Invalid extension metadata');
 if(!Array.isArray(value.scopes)||value.scopes.length>2||new Set(value.scopes).size!==value.scopes.length||value.scopes.some(s=>!CAPABILITIES.has(s)))throw new Error('Unsupported extension permission');
 if(typeof value.source!=='string'||new TextEncoder().encode(value.source).length>32768)throw new Error('Extension source exceeds 32 KiB');
 return {version:1,id:value.id,name:value.name,description:value.description,scopes:[...value.scopes],source:value.source};
}
function extensionDocument(manifest,nonce){
 const workerSource=`const waiting=new Map();let n=0;
 const api=Object.freeze({listFiles:()=>request('files:list',{}),readFile:path=>request('files:read',{path})});
 function request(op,args){return new Promise((resolve,reject)=>{const id=++n;waiting.set(id,{resolve,reject});postMessage({kind:'extension-request',id,op,args});});}
 const run=(${manifest.source});
 addEventListener('message',async event=>{const m=event.data;
 if(m.kind==='extension-response'){const pending=waiting.get(m.id);if(pending){waiting.delete(m.id);m.error?pending.reject(new Error(m.error)):pending.resolve(m.result);}return;}
 if(m.kind==='extension-invoke'){try{const result=await run(m.input,api);postMessage({kind:'extension-result',id:m.id,result});}catch(error){postMessage({kind:'extension-result',id:m.id,error:String(error.message).slice(0,500)});}}
 });postMessage({kind:'extension-ready'});`;
 const body=`const token=${JSON.stringify(nonce)};const url=URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}],{type:'text/javascript'}));const worker=new Worker(url);let active;
 worker.onmessage=event=>{if(event.data?.kind==='extension-ready')URL.revokeObjectURL(url);parent.postMessage({...event.data,token},'*');};
 worker.onerror=event=>{event.preventDefault();parent.postMessage({kind:active?'extension-result':'extension-failed',token,id:active,error:'Extension execution failed'},'*');};
 addEventListener('message',event=>{const m=event.data;if(event.source!==parent||m?.token!==token)return;if(m.kind==='extension-invoke')active=m.id;worker.postMessage(m);});`;
 return '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-'+nonce+'\'; worker-src blob:; connect-src \'none\'; img-src \'none\'; form-action \'none\'; base-uri \'none\'"><script nonce="'+nonce+'">'+body.replace(/<\/script/gi,'<\\/script')+'</script>';
}
export class ExtensionRegistry{
 constructor(client,{approve,document:doc=globalThis.document,window:win=globalThis.window}={}){this.client=client;this.approve=approve;this.document=doc;this.window=win;this.extensions=new Map();}
 list(){return [...this.extensions.values()].map(e=>({id:e.manifest.id,name:e.manifest.name,description:e.manifest.description,scopes:e.manifest.scopes}));}
 async register(value,signal){
  const manifest=validateExtension(value);
  if(!this.extensions.has(manifest.id)&&this.extensions.size>=8)throw new Error('At most eight extensions can be enabled');
  await requireApproval(this.approve,{title:'Review Builder extension',description:'This extension runs in an isolated frame. Allow only the listed project permissions. It cannot run native Pi extensions, commands, or access Builder credentials.',content:manifest.name+'\nPermissions: '+manifest.scopes.join(', ')+'\n\n'+manifest.source},signal);
  this.revoke(manifest.id);
  const iframe=this.document.createElement('iframe'),token=crypto.randomUUID().replaceAll('-','');iframe.setAttribute('sandbox','allow-scripts');iframe.hidden=true;iframe.title='Extension: '+manifest.name;
  const entry={manifest,iframe,token,pending:new Map(),active:false,requests:0};
  let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  entry.rejectReady=readyReject;
  entry.listener=async event=>{
   const m=event.data;if(event.source!==iframe.contentWindow||m?.token!==token||!this.extensions.has(manifest.id))return;
   if(m.kind==='extension-ready'){readyResolve();return;}
   if(m.kind==='extension-failed'){readyReject(new Error('The isolated extension worker could not start. This browser may block opaque-origin workers; use desktop Chromium or check the extension syntax.'));return;}
   if(m.kind==='extension-result'){
    const request=entry.pending.get(m.id);if(!request)return;
    try{const serialized=JSON.stringify(m.result??null);if(serialized.length>65536)throw new Error('Extension output exceeds 64 KiB');m.error?request.reject(new Error(String(m.error).slice(0,500))):request.resolve(JSON.parse(serialized));}catch(error){request.reject(error);}return;
   }
   if(m.kind!=='extension-request')return;
   let result,error;
   try{
    if(!entry.active||++entry.requests>16||!manifest.scopes.includes(m.op))throw new Error('Extension permission denied or request limit reached');
    if(m.op==='files:list')result=await this.client.call('fs.list',{},entry.signal);
    else if(m.op==='files:read'){
     if(typeof m.args?.path!=='string'||m.args.path.length>512)throw new Error('Invalid extension file path');
     result=await this.client.call('fs.read',{path:m.args.path},entry.signal);
     if(new TextEncoder().encode(result.text).length>32768)throw new Error('Extension reads are limited to 32 KiB');
    }else throw new Error('Unsupported extension operation');
    if(!entry.active||!this.extensions.has(manifest.id))return;
   }catch(e){result=undefined;error=e.message;}
   iframe.contentWindow?.postMessage({kind:'extension-response',token,id:m.id,result,error},'*');
  };
  this.extensions.set(manifest.id,entry);this.window.addEventListener('message',entry.listener);iframe.srcdoc=extensionDocument(manifest,token);this.document.body.append(iframe);
  const timer=setTimeout(()=>readyReject(new Error('Extension did not initialize')),5000),cancel=()=>readyReject(signal.reason||new Error('Extension import stopped'));
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  try{await ready;return this.list().find(e=>e.id===manifest.id);}catch(error){this.revoke(manifest.id);throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
 }
 async invoke(id,input,signal){
  const entry=this.extensions.get(id);if(!entry)throw new Error('Enable this extension before using it');
  if(entry.active)throw new Error('Extension is already running');
  const serialized=JSON.stringify(input??{});if(serialized.length>32768)throw new Error('Extension input exceeds 32 KiB');
  signal?.throwIfAborted();entry.active=true;entry.requests=0;entry.signal=signal;
  const callId=crypto.randomUUID();let timer,cancel;
  try{return await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(new Error('Extension timed out')),10000);cancel=()=>reject(signal.reason||new Error('Extension stopped'));signal?.addEventListener('abort',cancel,{once:true});
   entry.pending.set(callId,{resolve,reject});entry.iframe.contentWindow.postMessage({kind:'extension-invoke',token:entry.token,id:callId,input:JSON.parse(serialized)},'*');
  });}catch(error){this.revoke(id);throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);entry.active=false;entry.signal=null;entry.pending.delete(callId);}
 }
 revoke(id){const entry=this.extensions.get(id);if(!entry)return;this.extensions.delete(id);entry.active=false;entry.rejectReady(new Error('Extension revoked'));for(const request of entry.pending.values())request.reject(new Error('Extension revoked'));this.window.removeEventListener('message',entry.listener);entry.iframe.remove();}
 close(){for(const id of this.extensions.keys())this.revoke(id);}
}
export const projectSummaryExtension={version:1,id:'project-summary',name:'Project summary',description:'Count project source files by extension.',scopes:['files:list'],source:`async function(input,api){const {files}=await api.listFiles();const types={};for(const path of files){const ext=path.includes('.')?path.split('.').pop():'other';types[ext]=(types[ext]||0)+1;}return {files:files.length,types};}`};
