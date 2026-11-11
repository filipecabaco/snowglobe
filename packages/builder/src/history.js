import {folderWorkspace} from './storage-context.js';
import {fileBytes,sameFile,fileDescription} from './source-files.js';
import {requireApproval} from './approvals.js';
import {validProjectId} from './projects.js';
export async function sourceVersions(files){
 const versions={};await Promise.all(Object.keys(files).map(async path=>{const digest=await crypto.subtle.digest('SHA-256',fileBytes(files[path]));versions[path]=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');}));return versions;
}
export function sourceChanges(before,after){return Object.fromEntries([...new Set([...Object.keys(before),...Object.keys(after)])].filter(path=>!sameFile(before[path],after[path])).map(path=>[path,Object.hasOwn(after,path)?after[path]:null]));}
export function sourceDiff(before,after){
 return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(path=>!sameFile(before[path],after[path])).map(path=>{
  const a=before[path],b=after[path];let text='--- '+(a===undefined?'/dev/null':path)+'\n+++ '+(b===undefined?'/dev/null':path)+'\n';
  const old=fileDescription(a??'').split('\n'),next=fileDescription(b??'').split('\n');let start=0;while(start<old.length&&start<next.length&&old[start]===next[start])start++;
  let end=0;while(end<old.length-start&&end<next.length-start&&old[old.length-1-end]===next[next.length-1-end])end++;
  text+='@@ line '+(start+1)+' @@\n'+old.slice(start,old.length-end).map(l=>'-'+l).join('\n')+'\n'+next.slice(start,next.length-end).map(l=>'+'+l).join('\n');return text;
 }).join('\n\n');
}
export async function restoreVersion(client,before,target,{approve,signal}={}){
 const changes=sourceDiff(before,target);if(!changes)return {unchanged:true};
 for(const path of new Set([...Object.keys(before),...Object.keys(target)]))if(path.startsWith('supabase/migrations/')&&before[path]!==target[path])throw new Error('Source restore cannot change migration history. Use a new repair migration.');
 await requireApproval(approve,{title:'Restore source version',description:'Review the source changes below. This restores files only. Database rows, accounts and app data will not be rolled back.',content:changes},signal);
 // Check the complete source set after review before starting the restore.
 const current=await client.call('project.export',{},signal);if(JSON.stringify(Object.entries(current.files).sort())!==JSON.stringify(Object.entries(before).sort()))throw new Error('Project changed during review. Refresh history before restoring.');
 const versions=await sourceVersions(before);
 return client.call('project.restore',{expected:versions,changes:sourceChanges(before,target)},signal);
}
export async function historyStore(projectId,entry){
 validProjectId(projectId);
 if(folderWorkspace())return folderWorkspace().history(projectId,entry);
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('snowglobe-builder-history',1);r.onupgradeneeded=()=>r.result.createObjectStore('versions');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('versions',entry!==undefined?'readwrite':'readonly'),store=tx.objectStore('versions');let versions=[];
  const r=store.get(projectId);r.onsuccess=()=>{versions=r.result||[];if(entry===null){versions=[];store.delete(projectId);}else if(entry){versions=[{id:crypto.randomUUID(),createdAt:Date.now(),...entry},...versions].slice(0,20);store.put(versions,projectId);}};
  tx.oncomplete=()=>resolve(versions);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('History save failed'));
 });}finally{db.close();}
}
