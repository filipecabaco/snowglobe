// Only project data and render/error notifications cross this bridge. No VM or credential access.
export function previewBootstrap(config){
 const send=(type,value)=>parent.postMessage({channel:'snowglobe-preview-v1',token:config.token,type,value},'*');
 let failed=false,ready=false;
 const error=message=>{if(failed)return;failed=true;send('error',String(message).slice(0,1000));};
 addEventListener('error',e=>error(e.message||'An application script or resource failed to load.'));
 addEventListener('unhandledrejection',e=>error(e.reason?.message||String(e.reason||'An application promise failed.')));
 addEventListener('securitypolicyviolation',e=>error('The preview blocked '+e.violatedDirective+'. External resources and network access are disabled in this prototype.'));
 const makeStorage=(initial,persist)=>{
  let values=Object.assign(Object.create(null),initial||{});
  const save=()=>{if(JSON.stringify(values).length>262144)throw new DOMException('Project storage exceeds 256 KiB','QuotaExceededError');if(persist)send('storage',values);};
  const api={get length(){return Object.keys(values).length;},key:i=>Object.keys(values)[Number(i)]??null,getItem:key=>Object.hasOwn(values,String(key))?values[String(key)]:null,
   setItem(key,value){key=String(key);value=String(value);const old=values[key],had=Object.hasOwn(values,key);values[key]=value;try{save();}catch(e){if(had)values[key]=old;else delete values[key];throw e;}},
   removeItem(key){delete values[String(key)];save();},clear(){values=Object.create(null);save();}};
  return new Proxy(api,{get(target,key){if(key in target)return Reflect.get(target,key);if(typeof key==='string')return values[key];},set(target,key,value){if(typeof key==='string'){target.setItem(key,value);return true;}return false;},deleteProperty(target,key){target.removeItem(key);return true;}});
 };
 try{Object.defineProperty(window,'localStorage',{value:makeStorage(config.storage,true)});Object.defineProperty(window,'sessionStorage',{value:makeStorage({},false)});}catch(e){error('Could not initialize project storage: '+e.message);}
 if(config.backend){
  const nativeFetch=window.fetch.bind(window),requests=new Map();let sequence=0;
  Object.defineProperty(window,'SNOWGLOBE_SUPABASE',{value:config.backend});
  addEventListener('message',event=>{const d=event.data;if(event.source!==parent||d?.channel!=='snowglobe-preview-v1'||d.token!==config.token||d.type!=='backend.response')return;const pending=requests.get(d.id);if(!pending)return;requests.delete(d.id);clearTimeout(pending.timer);pending.cleanup();if(d.error)pending.reject(new Error(d.error));else pending.resolve(new Response([204,205,304].includes(d.status)?null:d.body,{status:d.status,headers:d.headers}));});
  window.fetch=async(input,init={})=>{
   const request=new Request(input,init),url=new URL(request.url);
   if(url.origin!==config.backend.url)return nativeFetch(input,init);
   if(requests.size>=8)throw new Error('Too many concurrent Supabase requests');request.signal.throwIfAborted();
   const body=await request.text();if(new TextEncoder().encode(body).length>131072)throw new Error('Supabase request exceeds 128 KiB');
   return new Promise((resolve,reject)=>{const id=++sequence;
    const abort=()=>{const p=requests.get(id);if(!p)return;requests.delete(id);clearTimeout(p.timer);p.cleanup();send('backend.cancel',{id});reject(new DOMException('Supabase request cancelled','AbortError'));};
    const cleanup=()=>request.signal.removeEventListener('abort',abort);
    const timer=setTimeout(()=>{abort();},180000);requests.set(id,{resolve,reject,timer,cleanup});request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted){abort();return;}
    send('backend.request',{id,request:{url:request.url,method:request.method,headers:[...request.headers],body}});
   });
  };
 }
 send('booted',null);
 const started=performance.now();
 function check(){
  if(failed||ready)return;
  const root=document.getElementById('root')||document.getElementById('app')||document.body;
  const visual=root?.querySelector('canvas,svg,img,video,input,select,textarea,button[aria-label]');
  const visible=visual&&visual.getBoundingClientRect().width>0&&visual.getBoundingClientRect().height>0;
  // A wrapper containing only a startup script is not a rendered application.
  if(visible||root?.innerText?.trim()){ready=true;send('ready',null);return;}
  if(performance.now()-started>12000){error('The app loaded but rendered an empty page. Check its startup code and build details.');return;}
  setTimeout(check,100);
 }
 // WebKit suspends animation frames in offscreen/transparent iframes. A new candidate is
 // transparent until ready, and mobile chat scrolling can put the preview outside the viewport.
 // Startup validation must inspect DOM readiness independently of painting.
 if(document.readyState==='loading')addEventListener('DOMContentLoaded',check,{once:true});else check();
}
export function previewDocument(html,token,storage,backend){
 const csp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
 const config=JSON.stringify({token,storage,backend}).replaceAll('<','\\u003c');
 return '<!doctype html>\n<meta http-equiv="Content-Security-Policy" content="'+csp+'"><script>('+previewBootstrap.toString()+')('+config+');<\/script>'+html.replace(/^\s*<!doctype[^>]*>/i,'');
}
export function validPreviewStorage(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).length<=1000&&Object.values(value).every(v=>typeof v==='string')&&JSON.stringify(value).length<=262144;}
export function mountPreview({container,html,storage={},backend,onBackendRequest,onStorage=()=>{},onRuntimeError=()=>{},signal,timeoutMs=20000}){
 if(!validPreviewStorage(storage))storage={};
 const frame=document.createElement('iframe');frame.title='Your application';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('credentialless','');
 const token=crypto.randomUUID(),requests=new Map();let settled=false,disposed=false,ready=false,booted=false,pendingStorage=storage,objectUrl;
 frame.style.cssText='position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none';
 let resolve,reject;const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const dispose=()=>{if(disposed)return;disposed=true;for(const controller of requests.values())controller.abort();requests.clear();removeEventListener('message',message);signal?.removeEventListener('abort',abort);clearTimeout(timer);if(objectUrl)URL.revokeObjectURL(objectUrl);};
 const fail=error=>{if(settled)return;settled=true;dispose();frame.remove();reject(error);};
 const abort=()=>fail(new DOMException('Preview cancelled','AbortError'));
 const message=e=>{
  if(e.source!==frame.contentWindow||e.origin!=='null'||e.data?.channel!=='snowglobe-preview-v1'||e.data.token!==token)return;
  const {type,value}=e.data;
  if(type==='backend.cancel'){requests.get(value?.id)?.abort();return;}
  if(type==='backend.request'&&backend&&onBackendRequest){
   if(!Number.isSafeInteger(value?.id)||requests.has(value.id)||requests.size>=8)return;
   const controller=new AbortController();requests.set(value.id,controller);
   const reply=result=>{if(!disposed)frame.contentWindow.postMessage({channel:'snowglobe-preview-v1',token,type:'backend.response',id:value.id,...result},'*');};
   Promise.resolve().then(()=>onBackendRequest(value.request,controller.signal)).then(reply,error=>reply({error:String(error.message||error).slice(0,800)})).finally(()=>requests.delete(value.id));return;
  }
  if(type==='booted')booted=true;
  if(type==='storage'&&validPreviewStorage(value)){pendingStorage=value;if(ready)onStorage(value);}
  if(type==='error'){const error=new Error('App preview failed: '+String(value).slice(0,1000));if(!ready)fail(error);else onRuntimeError(error);}
  if(type==='ready'&&!settled){settled=true;ready=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const previous of [...container.children])if(previous!==frame){previous._disposePreview?.();previous.remove();}frame.style.cssText='';onStorage(pendingStorage);resolve(frame);}
 };
 const timer=setTimeout(()=>fail(new Error(booted?'The preview started but did not report rendered content. Check its startup code and retry.':'The browser did not start the preview frame. Keep Builder visible and retry the preview.')),timeoutMs);
 // A blob provides a stable in-frame URL for hash routers. Without allow-same-origin
 // the document remains opaque: no Builder DOM, cookies, storage or privileges.
 objectUrl=URL.createObjectURL(new Blob([previewDocument(html,token,storage,backend)],{type:'text/html'}));
 frame._disposePreview=dispose;addEventListener('message',message);signal?.addEventListener('abort',abort,{once:true});frame.src=objectUrl;container.append(frame);if(signal?.aborted)abort();
 return result;
}
