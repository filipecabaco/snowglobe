import {VmClient} from './client.js';
import helper from './supabase-guest.mjs?raw';
import {requireApproval} from './approvals.js';
export const SUPABASE_ORIGIN='https://supabase.builder.invalid';
export function restoredBackendConfig(saved,slot){
 const config=saved.backendConfig;if(!config)return null;
 if(saved.backendSavedAt!==slot.saved?.savedAt||saved.backendBuild!==slot.config.build)throw new Error('The saved Supabase and source checkpoints do not match. Your saved files are preserved; restore a matching checkpoint before using this database.');
 let role;try{role=JSON.parse(atob(config.anonKey.split('.')[1].replaceAll('-','+').replaceAll('_','/'))).role;}catch{}
 if(config.url!==SUPABASE_ORIGIN||role!=='anon')throw new Error('The saved Supabase preview configuration is invalid. Your VM checkpoints are preserved.');
 return {url:SUPABASE_ORIGIN,anonKey:config.anonKey};
}
export const supabaseSource=`import {createClient} from '@supabase/supabase-js';
const config=window.SNOWGLOBE_SUPABASE;
export const supabaseUrl=config?.url||import.meta.env.VITE_SUPABASE_URL;
const key=config?.anonKey||import.meta.env.VITE_SUPABASE_ANON_KEY;
if(!supabaseUrl||!key)throw new Error('Enable Supabase in Builder before using this app.');
let queue=Promise.resolve();
export const supabase=createClient(supabaseUrl,key,{auth:{storageKey:'snowglobe-project-auth',detectSessionInUrl:false,lock:(_name,_timeout,fn)=>{const result=queue.then(fn,fn);queue=result.catch(()=>{});return result;}}});
// Supabase invokes auth listeners while holding its session lock. Run app callbacks
// afterwards so an async listener can safely query data or ask for the session.
const subscribe=supabase.auth.onAuthStateChange.bind(supabase.auth);
supabase.auth.onAuthStateChange=callback=>{
 let active=true;
 const result=subscribe((event,session)=>{setTimeout(()=>{if(active)Promise.resolve().then(()=>callback(event,session)).catch(error=>window.dispatchEvent(new ErrorEvent('error',{message:error.message})));},0);});
 const unsubscribe=result.data.subscription.unsubscribe.bind(result.data.subscription);
 result.data.subscription.unsubscribe=()=>{active=false;unsubscribe();};return result;
};
`;
export function validateBackendRequest(request,anonKey){
 if(!request||typeof request.url!=='string'||request.url.length>8192)throw new Error('Invalid backend request');
 const url=new URL(request.url);const path=url.pathname;
 if(url.origin!==SUPABASE_ORIGIN||url.username||url.password||url.searchParams.has('apikey')||/%(?:2f|5c|00)/i.test(path)||!(/^\/auth\/v1\/(health|settings|signup|token|logout|user)$/.test(path)||/^\/rest\/v1\/(?:[a-zA-Z_][\w]*(?:\/[a-zA-Z_][\w]*)?)?$/.test(path)))throw new Error('Only this project’s Supabase Auth and Data API are available');
 const method=String(request.method||'GET').toUpperCase();if(!['GET','HEAD','POST','PATCH','PUT','DELETE'].includes(method))throw new Error('Unsupported backend method');
 if(typeof request.body!=='string'||new TextEncoder().encode(request.body).length>131072)throw new Error('Backend request body exceeds 128 KiB');
 if(!Array.isArray(request.headers)||request.headers.length>32)throw new Error('Invalid backend headers');
 const allowed=new Set(['accept','content-type','prefer','range','range-unit','x-client-info','x-supabase-api-version','accept-profile','content-profile','authorization']);const headers=[];
 for(const pair of request.headers){if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string'||v.length>8192||/[\r\n\0]/.test(v)))throw new Error('Invalid backend header');const [name,value]=pair,key=name.toLowerCase();if(key==='apikey'){if(value!==anonKey)throw new Error('Only the public project API key is allowed');continue;}if(!allowed.has(key))continue;
  if((key==='accept-profile'||key==='content-profile')&&value!=='public')throw new Error('Only the public application schema is available');
  if(key==='authorization'){let role;try{const token=value.replace(/^Bearer /i,'');role=JSON.parse(atob(token.split('.')[1].replaceAll('-','+').replaceAll('_','/'))).role;}catch{}if(!['anon','authenticated'].includes(role))throw new Error('Administrative Supabase tokens are not available to previews');}
  headers.push([name,value]);
 }
 headers.push(['apikey',anonKey]);return {method,path:path+url.search,headers,body:new TextEncoder().encode(request.body)};
}
export class SupabaseBackend{
 constructor(api,{sourceClient,onProgress=()=>{},onEnabled=()=>{},onMutation=()=>{},approve,allowed=()=>true}={}){this.api=api;this.sourceClient=sourceClient;this.approve=approve;this.allowed=allowed;this.onProgress=onProgress;this.onEnabled=onEnabled;this.onMutation=onMutation;this.enabled=false;this.config=null;this.active=new Set();this.frozen=false;this.waiters=[];this.client=new VmClient(api,{runtime:'supabase',guestSource:helper,compilerSource:'',executable:'BUN_BE_BUN=1 supabase run',onProgress});}
 async enable(signal){
  if(!this.allowed())throw new Error('Supabase is disabled for this project. Ask the user to choose Automatic or Supabase in Backend settings.');
  if(this.enabling)return this.enabling;
  if(this.enabled){await this.installClient(signal);return {enabled:true,scope:'browser-local development',services:['auth','rest','postgres']};}
  this.enabling=this.initialize(signal).catch(error=>{this.enabled=false;this.config=null;throw error;}).finally(()=>this.enabling=null);return this.enabling;
 }
 async initialize(signal){
  this.onProgress({stage:'supabase-prepare',message:'Preparing Supabase Auth and database…'});
  const info=await this.client.call('backend.info',{},signal);this.config={url:SUPABASE_ORIGIN,anonKey:info.anonKey};this.enabled=true;
  await this.installClient(signal,true);
  await this.ready(signal);const health=await this.http({url:SUPABASE_ORIGIN+'/auth/v1/health',method:'GET',headers:[],body:''},signal);if(health.status!==200)throw new Error('Supabase Auth did not pass its health check');
  this.onEnabled();return {enabled:true,scope:info.scope,services:info.services,module:'src/supabase.js',instructions:'Import {supabase} from ./supabase.js. Apply migrations before querying tables. Email/password signup is local development, with no email delivery. Use RLS auth.uid() policies.'};
 }
 async installClient(signal,initialize=false){
  if(!this.sourceClient)return;
  if(!this.sdkPrepared){this.onProgress({stage:'supabase-sdk',message:'Preparing the project’s Supabase SDK dependency'});const result=await this.sourceClient.call('project.dependencies',{packages:{'@supabase/supabase-js':'2.119.0'}},signal);if(!result?.unchanged)this.onMutation();this.sdkPrepared=true;}
  let old=null;try{old=await this.sourceClient.call('fs.read',{path:'src/supabase.js'},signal);}catch(error){if(!/ENOENT/.test(error.message))throw error;}
  // Upgrade only our managed module. Preserve a user-created alternative implementation.
  if(!initialize&&old&&!old.text.includes('const config=window.SNOWGLOBE_SUPABASE;'))return;
  if(old?.text!==supabaseSource){await this.sourceClient.call('fs.write',{path:'src/supabase.js',version:old?.version??null,text:supabaseSource},signal);this.onMutation();}
 }
 async ready(signal){
  signal?.throwIfAborted();const view=await this.api.preview();if(view?.runtime==='supabase'&&this.api._get('supabase').lifecycle.state==='running')return;
  this.opening??=(async()=>{if(this.api._get('supabase').lifecycle.state!=='running'){const info=await this.client.call('backend.info',{},signal);if(info.anonKey!==this.config?.anonKey)throw new Error('The Supabase checkpoint belongs to a different backend configuration');}await this.api.openPreview({runtime:'supabase',port:54322},{check:false,signal});})().finally(()=>this.opening=null);await this.opening;
 }
 async http(request,signal){
  if(!this.allowed())throw new Error('The project backend is disabled');
  if(!this.enabled||!this.config)throw new Error('Enable Supabase before requesting its API');
  if(this.frozen)await new Promise(resolve=>this.waiters.push(resolve));signal?.throwIfAborted();
  if(this.active.size>=8)throw new Error('Too many concurrent Supabase requests');
  const input=validateBackendRequest(request,this.config.anonKey);const operation=(async()=>{await this.ready(signal);let head,error,size=0,tooLarge=false;const chunks=[],controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   try{await this.api.previewRequest({runtime:'supabase',port:54322,...input,prefix:'/builder-supabase',origin:location.origin},message=>{if(message.type==='head')head=message;else if(message.type==='data'){size+=message.bytes.length;if(size>524288){tooLarge=true;controller.abort();return;}chunks.push(message.bytes);}else if(message.type==='error'||message.type==='abort')error=message;},{signal:controller.signal});}finally{signal?.removeEventListener('abort',abort);}
   if(tooLarge)throw new Error('Backend response exceeds 512 KiB');
   if(error)throw new Error('Supabase request failed: '+(error.message||error.status||'no response'));if(!head)throw new Error('Supabase did not answer');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return {status:head.status,headers:head.headers,body:bytes};
  })();this.active.add(operation);try{return await operation;}finally{this.active.delete(operation);}
 }
 async migrate({name,sql},signal){
  if(!this.allowed())throw new Error('Supabase is disabled for this project');
  if(typeof name!=='string'||!/^\d{14}_[a-z0-9_]+\.sql$/.test(name))throw new Error('Use a timestamped SQL migration filename');
  if(typeof sql!=='string'||!sql.trim()||new TextEncoder().encode(sql).length>65536||/[\\\0]/.test(sql))throw new Error('Migration SQL must be bounded text without psql metacommands or backslashes');
  await requireApproval(this.approve,{title:'Review database change',description:'This migration can change or delete application data. Review the SQL before applying it. Source Undo does not undo database changes.',content:name+'\n\n'+sql},signal);
  await this.enable(signal);
  const path='supabase/migrations/'+name;let old=null;try{old=await this.sourceClient.call('fs.read',{path},signal);}catch(error){if(!/ENOENT/.test(error.message))throw error;}
  if(old&&old.text!==sql)throw new Error('A saved migration cannot be changed. Add a new repair migration.');
  await this.sourceClient.call('fs.write',{path,text:sql,version:old?.version??null},signal);
  const result=await this.client.call('backend.migrate',{name,sql},signal);this.api._get('supabase').dirty=true;return result;
 }
 async schema(signal){await this.enable(signal);return this.client.call('backend.schema',{},signal);}
 async freeze(){this.frozen=true;await Promise.allSettled([...this.active]);await this.api.closePreview();}
 resume(){this.frozen=false;for(const resolve of this.waiters.splice(0))resolve();}
}
