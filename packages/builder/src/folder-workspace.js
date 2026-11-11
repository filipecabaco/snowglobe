import {validProjectId,projectName} from './projects.js';
import {fileBytes,sourceFile,sameFile} from './source-files.js';
import {privatePathSegment} from './path-policy.js';
const FORMAT='snowglobe-builder-folder-v1',MAX_JSON=32*1024*1024;
const excluded=new Set(['snowglobe-project.json','.snowglobe','node_modules','dist','build','.svelte-kit','__proto__','prototype','constructor']);
const allowed=name=>!excluded.has(name)&&!privatePathSegment(name);
function sourcePath(path){if(typeof path!=='string'||path.length>512||/[\\\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||!allowed(p)))throw Error('Invalid folder source path');return path;}
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
async function readJson(dir,name){const file=await (await dir.getFileHandle(name)).getFile();if(file.size>MAX_JSON)throw Error('Project metadata is too large');return JSON.parse(await file.text());}
async function write(dir,name,value){const file=await dir.getFileHandle(name,{create:true}),stream=await file.createWritable();try{await stream.write(value);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}}
async function parent(dir,path,create=false){const parts=path.split('/'),name=parts.pop();for(const part of parts)dir=await dir.getDirectoryHandle(part,{create});return {dir,name};}
async function readSource(dir){
 const files=Object.create(null);let bytes=0,entries=0;
 async function walk(at,prefix='',depth=0){if(depth>32)throw Error('Project folder is nested too deeply');for await(const [name,handle] of at.entries()){
  if(!allowed(name))continue;if(++entries>1500)throw Error('Project folder has too many entries');const path=sourcePath(prefix+name);
  if(handle.kind==='directory')await walk(handle,path+'/',depth+1);else{const f=await handle.getFile();if(f.size>262144||(bytes+=f.size)>600*1024||Object.keys(files).length>=500)throw Error('Folder source exceeds Builder limits (256 KiB per file, 600 KiB total, 500 files)');files[path]=sourceFile(new Uint8Array(await f.arrayBuffer()));}
 }}await walk(dir);return files;
}
function equalSource(a,b){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&sameFile(a[k],b[k]));}

// One root, many UUID-named project folders. Human names remain in each manifest.
// JSON uses alternating checksummed generations. VM blobs are immutable; only a
// completed paired Save publishes their names into the project generation.
export class FolderWorkspace{
 constructor(root,sessions){this.root=root;this.sessions=sessions;this.cache=new Map();this.tail=Promise.resolve();}
 async open(){
  if(await this.root.queryPermission({mode:'readwrite'})!=='granted')throw Error('Reconnect your Builder folder to continue');
  const release=await this.sessions.acquireLock('/builder/folder-setup');
  try{let marker;try{marker=await readJson(this.root,'snowglobe-builder.json');}catch(e){if(e.name!=='NotFoundError')throw e;marker={format:FORMAT,id:crypto.randomUUID()};await write(this.root,'snowglobe-builder.json',JSON.stringify(marker,null,2));}
  if(marker.format!==FORMAT||typeof marker.id!=='string'||!/^[a-f0-9-]{36}$/.test(marker.id))throw Error('Unsupported SnowGlobe Builder folder');this.id=marker.id;return this;}finally{await release();}
 }
 async lock(){this.release??=await this.sessions.acquireLock('/builder/folder/'+this.id);}
 async close(){await this.release?.();this.release=null;}
 hasUnpublished(id){const p=this.cache.get(id);return !!p&&Object.entries(p.staged).some(([runtime,c])=>c.name!==p.state.vmFiles[runtime]?.name);}
 serial(fn){const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p;}
 async generations(meta){const records=[];let corrupt=false;for(const slot of ['a','b'])try{const envelope=await readJson(meta,'state.'+slot+'.json');if(!envelope.payload||await digest(typeof envelope.payload==='string'?envelope.payload:JSON.stringify(envelope.payload))!==envelope.sha256)throw Error('Invalid project checksum');const state=typeof envelope.payload==='string'?JSON.parse(envelope.payload):envelope.payload;if(state.format!==FORMAT||!Number.isSafeInteger(state.sequence)||state.sequence<1)throw Error('Invalid project generation');validProjectId(state.project?.id);projectName(state.project.name);records.push({slot,state});}catch(e){if(e.name!=='NotFoundError')corrupt=true;}if(!records.length&&corrupt)throw Error('Project metadata is unreadable; keep the folder for recovery');return records.sort((a,b)=>b.state.sequence-a.state.sequence);}
 async project(id,create=false){
  validProjectId(id);if(this.cache.has(id))return this.cache.get(id);
  const dir=await this.root.getDirectoryHandle('project-'+id,{create}),meta=await dir.getDirectoryHandle('.snowglobe',{create});
  const latest=(await this.generations(meta))[0];if(latest&&latest.state.project.id!==id)throw Error('Project folder identifier mismatch');
  const entry={dir,meta,state:latest?.state||{format:FORMAT,sequence:0,project:{id,name:'Recovered project',template:'auto',backend:'auto',createdAt:Date.now()},vmFiles:{},history:[]},slot:latest?.slot,staged:{},baseline:await readSource(dir)};
  this.cache.set(id,entry);return entry;
 }
 async unchanged(entry){const latest=(await this.generations(entry.meta))[0];if((latest?.state.sequence||0)!==entry.state.sequence||latest&&JSON.stringify(latest.state)!==JSON.stringify(entry.state))throw Error('Project metadata changed outside this tab. Reopen the project before saving.');}
 async commit(entry,state){
  await this.unchanged(entry);
  const slot=entry.slot==='a'?'b':'a',next={...state,sequence:entry.state.sequence+1};const payload=JSON.stringify(next);
  if(payload.length>MAX_JSON/2)throw Error('Project metadata exceeds folder limit');await write(entry.meta,'state.'+slot+'.json',JSON.stringify({payload:next,sha256:await digest(payload)},null,2));entry.state=structuredClone(next);entry.slot=slot;
  // A small visible manifest identifies the project outside Builder; the
  // checksummed private generations remain authoritative for restoration.
  const {id,name,template,backend}=next.project;
  try{await write(entry.dir,'snowglobe-project.json',JSON.stringify({format:'snowglobe-builder-project-v1',id,name,template,backend},null,2));}catch(error){throw Error('Project state saved, but its visible manifest could not be updated: '+error.message);}
 }
 async projects(op,project){return this.serial(async()=>{
  if(op==='list'){const result=[];for await(const [name,handle]of this.root.entries())if(handle.kind==='directory'&&name.startsWith('project-')){const id=name.slice(8);try{validProjectId(id);}catch{continue;}const entry=await this.project(id);if(entry.state.sequence)result.push(structuredClone(entry.state.project));}return result;}
  const entry=await this.project(project.id,op==='put');if(op==='delete'){await this.root.removeEntry('project-'+project.id,{recursive:true});this.cache.delete(project.id);}else await this.commit(entry,{...entry.state,project});
 });}
 async checkpoint(mode,value,id){return this.serial(async()=>{
  const entry=await this.project(id,true);
  if(mode==='readonly'){
   const files=await readSource(entry.dir);const recovery=entry.state.recovery;
   if(!recovery)return Object.keys(files).length?{savedAt:Date.now(),files,messages:[],previewData:{}}:undefined;
   if(!equalSource(files,recovery.files||{}))return structuredClone({...recovery,files,metadata:undefined,preview:'',savedAt:Math.max(Date.now(),(recovery.savedAt||0)+1)});
   return structuredClone(recovery);
  }
  if(value===null){await this.commit(entry,{...entry.state,recovery:null});return;}
  await this.unchanged(entry);
  const files=value.files||{};let total=0;if(Object.keys(files).length>500)throw Error('Too many source files');for(const [path,file]of Object.entries(files)){sourcePath(path);total+=fileBytes(file).length;}if(total>600*1024)throw Error('Folder source exceeds 600 KiB');
  let vmFiles=entry.state.vmFiles;
  if(value.metadata){vmFiles={};for(const runtime of value.metadata.backendConfig?['web','supabase']:['web']){
   const candidate=entry.staged[runtime]||entry.state.vmFiles[runtime];if(!candidate)throw Error('Missing '+runtime+' folder checkpoint');
   const expected=runtime==='web'?value.metadata.snapshotSavedAt:value.metadata.backendSavedAt;
   const build=runtime==='web'?value.metadata.buildId:value.metadata.backendBuild;
   if(candidate.savedAt!==expected||candidate.metadata.config.build!==build)throw Error('Folder checkpoint pair does not match completed Save');vmFiles[runtime]=candidate;
  }}
  const disk=await readSource(entry.dir);if(!equalSource(disk,entry.baseline))throw Error('Project files changed outside Builder. Export source to keep your VM edits, then reopen this project to review the folder source before saving.');
  // All external changes are checked before touching source; state remains a
  // recovery copy if a later individual file write fails.
  for(const [path,file]of Object.entries(files))if(!sameFile(disk[path],file)){const at=await parent(entry.dir,path,true);await write(at.dir,at.name,fileBytes(file));}
  for(const path of Object.keys(disk))if(!Object.hasOwn(files,path)){const at=await parent(entry.dir,path);await at.dir.removeEntry(at.name);}
  entry.baseline=structuredClone(files);
  await this.commit(entry,{...entry.state,recovery:value,vmFiles});
  await this.collect(entry);
 });}
 async history(id,entry){return this.serial(async()=>{const p=await this.project(id,true);if(entry===undefined)return structuredClone(p.state.history||[]);const history=entry===null?[]:[{id:crypto.randomUUID(),createdAt:Date.now(),...entry},...(p.state.history||[])].slice(0,20);await this.commit(p,{...p.state,history});return history;});}
 runtimeStore(id,runtime,config){
  if(!['web','supabase'].includes(runtime))throw Error('Unknown folder VM runtime');const self=this;
  return {
   async list(){const p=await self.project(id,true),c=p.staged[runtime]||p.state.vmFiles[runtime];if(c&&config&&!self.sessions.compatible(c.metadata,config))throw Error('This folder contains a '+runtime+' VM from a different build. Keep the folder and use its matching Builder version or export source.');return c?[c.metadata]:[];},
   async get(){const p=await self.project(id,true),c=p.staged[runtime]||p.state.vmFiles[runtime];if(!c)return null;if(!/^(web|supabase)-[a-f0-9-]{36}\.snowglobe$/.test(c.name))throw Error('Invalid VM checkpoint filename');const file=await(await p.meta.getFileHandle(c.name)).getFile();const checkpoint=await self.sessions.decodeBackup(file);if(checkpoint.id!=='machine'||checkpoint.savedAt!==c.savedAt||!self.sessions.compatible(checkpoint,c.metadata.config))throw Error('Folder VM checkpoint metadata mismatch');return checkpoint;},
   async put(checkpoint){return self.serial(async()=>{const p=await self.project(id,true),name=runtime+'-'+crypto.randomUUID()+'.snowglobe';await write(p.meta,name,await self.sessions.encodeBackup(checkpoint));p.staged[runtime]={name,savedAt:checkpoint.savedAt,metadata:self.sessions.metadata(checkpoint)};await self.collect(p);});},
   async remove(){return self.serial(async()=>{const p=await self.project(id,true);delete p.staged[runtime];const vmFiles={...p.state.vmFiles};delete vmFiles[runtime];await self.commit(p,{...p.state,vmFiles});});}
  };
 }
 async collect(entry){
  // Retain both published generations and in-session checkpoints. Cleanup must
  // never turn a successfully committed save into a reported failure.
  try{const keep=new Set(Object.values(entry.staged).map(c=>c.name));for(const {state}of await this.generations(entry.meta))for(const c of Object.values(state.vmFiles||{}))keep.add(c.name);for await(const [name]of entry.meta.entries())if(/^(web|supabase)-[a-f0-9-]{36}\.snowglobe$/.test(name)&&!keep.has(name))await entry.meta.removeEntry(name);}catch{}
 }
}
