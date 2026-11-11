// Injected only into Builder's worker core. Existing Snowglobe networking is unchanged.
export async function registryFetch(input,init={}){
 if(/(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|$)/i.test(String(input)))throw new Error('Invalid registry path');
 const url=new URL(input),method=String(init.method||'GET').toUpperCase();let pathname;
 try{pathname=decodeURIComponent(url.pathname);}catch{throw new Error('Invalid registry URL');}
 if(url.origin!=='https://registry.npmjs.org'||url.username||url.password||url.search||url.hash||!['GET','HEAD'].includes(method)||!/^\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/(?:[0-9][a-zA-Z0-9.+-]*|-\/[a-zA-Z0-9._-]+\.tgz))?$/.test(pathname)||pathname.split('/').some(p=>p==='.'||p==='..'))throw new Error('Builder guest network permits only npm registry package metadata and tarballs');
 const controller=new AbortController(),stop=()=>controller.abort();init.signal?.addEventListener('abort',stop,{once:true});if(init.signal?.aborted)stop();
 const timer=setTimeout(stop,60000);
 try{
  const response=await fetch(url.href,{method,headers:{Accept:'application/json'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'force-cache',signal:controller.signal});
  const length=Number(response.headers.get('content-length')||0);if(length>32*1024*1024)throw new Error('Registry response exceeds 32 MiB');
  const reader=response.body?.getReader(),chunks=[];let total=0;
  if(reader)try{for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>32*1024*1024){controller.abort();throw new Error('Registry response exceeds 32 MiB');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');headers.delete('set-cookie');
  return new Response(method==='HEAD'||[204,205,304].includes(response.status)?null:bytes,{status:response.status,statusText:response.statusText,headers});
 }finally{clearTimeout(timer);init.signal?.removeEventListener('abort',stop);}
}
