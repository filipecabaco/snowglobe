export function modelPreference(engine,id){if(!['pi','codex'].includes(engine)||typeof id!=='string'||!id||id.length>128||/[\x00-\x20]/.test(id))throw Error('Invalid saved model preference');return {engine,id};}
export const DEFAULT_PROJECT='local-builder';
export function validProjectId(id){if(id!==DEFAULT_PROJECT&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))throw new Error('Invalid project identifier');return id;}
export function projectScope(id,runtime){validProjectId(id);if(!['web','supabase'].includes(runtime))throw new Error('Invalid project runtime');return id===DEFAULT_PROJECT?'/builder/'+runtime:'/builder/projects/'+id+'/'+runtime;}
export function projectName(name){if(typeof name!=='string'||!name.trim()||name.trim().length>80||/[\x00-\x1f]/.test(name))throw new Error('Project names need 1–80 plain text characters');return name.trim();}
export async function projectStore(op,project){
 if(!['list','put','delete'].includes(op))throw new Error('Invalid project operation');
 if(project){validProjectId(project.id);if(op==='put')project={...project,name:projectName(project.name)};}
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('snowglobe-builder-projects',1);r.onupgradeneeded=()=>r.result.createObjectStore('projects',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('projects',op==='list'?'readonly':'readwrite'),store=tx.objectStore('projects');const r=op==='list'?store.getAll():op==='put'?store.put(project):store.delete(project.id);let result;r.onsuccess=()=>result=r.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Project metadata update failed'));});}finally{db.close();}
}
