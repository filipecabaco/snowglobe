import {requireApproval} from './approvals.js';
// A small source/preview recovery record is committed before capturing either large VM.
// Separate IndexedDB storage avoids localStorage's small string quota.
import {sourceVersions,sourceChanges,sourceDiff} from './history.js';
import {validProjectId} from './projects.js';
export function needsSourceRecovery(recovery,slot){
 // A newer automatic VM checkpoint may contain edits made after a completed Save.
 // Never replace those with the older recovery copy. An interrupted manual Save
 // has no final metadata and its recovery record represents the intended source.
 return !recovery.metadata||!slot.saved||slot.saved.savedAt<recovery.savedAt;
}
export async function checkpointStore(mode, value, projectId='local-builder'){
 validProjectId(projectId);
 const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('snowglobe-builder-recovery',1);request.onupgradeneeded=()=>request.result.createObjectStore('checkpoints');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('checkpoints',mode),store=tx.objectStore('checkpoints'),key=projectId==='local-builder'?'latest':projectId;const request=mode==='readonly'?store.get(key):value===null?store.delete(key):store.put(value,key);let result;request.onsuccess=()=>result=request.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Source recovery save was aborted'));});}finally{db.close();}
}
export async function restoreSource(client,files,signal,migrate,{approve}={}){
 const current=await client.call('project.export',{},signal);
 const diff=sourceDiff(current.files,files);if(diff)await requireApproval(approve,{title:'Recover saved source',description:'The saved source differs from this VM. Review before replacing files. Database rows and accounts are not rolled back. Cancel keeps both copies available and leaves the VM source unchanged.',content:diff},signal);
 await client.call('project.restore',{expected:await sourceVersions(current.files),changes:sourceChanges(current.files,files)},signal);
 if(migrate)for(const path of Object.keys(files).sort()){
  const match=/^supabase\/migrations\/(\d{14}_[a-z0-9_]+\.sql)$/.exec(path);
  if(match)await migrate({name:match[1],sql:files[path]},signal);
 }
}
