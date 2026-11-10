// Set once before opening project stores. No silent fallback after selecting a folder.
let folder=null;
export const folderWorkspace=()=>folder;
export const useFolderWorkspace=value=>{folder=value;};
export async function workspaceHandle(value){
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('snowglobe-builder-folder',1);r.onupgradeneeded=()=>r.result.createObjectStore('settings');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('settings',value===undefined?'readonly':'readwrite'),store=tx.objectStore('settings');const r=value===undefined?store.get('root'):value===null?store.delete('root'):store.put(value,'root');let result;r.onsuccess=()=>result=r.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Folder preference could not be saved'));});}finally{db.close();}
}
