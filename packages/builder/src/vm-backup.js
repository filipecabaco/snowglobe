import {projectStore,projectScope,projectName} from './projects.js';
import {checkpointStore} from './checkpoint.js';
import {requireApproval} from './approvals.js';
export async function savedVmBackup(api,runtime,metadata,sessions,signal){
 signal?.throwIfAborted();
 if(!['web','supabase'].includes(runtime))throw Error('Unknown backup runtime');
 if(!metadata||!Number.isSafeInteger(metadata.snapshotSavedAt))throw Error('Save VM successfully before downloading backups');
 // Both files must belong to the completed paired Save, never independently
 // chosen latest checkpoints from different saves.
 for(const name of metadata.backendConfig?['web','supabase']:['web']){
  const slot=api._get(name).slot;await slot.open();signal?.throwIfAborted();const time=name==='web'?metadata.snapshotSavedAt:metadata.backendSavedAt,build=name==='web'?metadata.buildId:metadata.backendBuild;
  if(!slot.saved||slot.saved.savedAt!==time||slot.config.build!==build)throw Error('Saved machines do not match the completed Save. Save VM again before backing up');
 }
 if(runtime==='supabase'&&!metadata.backendConfig)throw Error('This saved project has no database checkpoint');
 const checkpoint=await api._get(runtime).slot.load();signal?.throwIfAborted();if(!checkpoint)throw Error('Saved checkpoint unavailable; keep this tab open and retry Save VM');const expectedTime=runtime==='web'?metadata.snapshotSavedAt:metadata.backendSavedAt,expectedBuild=runtime==='web'?metadata.buildId:metadata.backendBuild;if(checkpoint.savedAt!==expectedTime||checkpoint.config.build!==expectedBuild)throw Error('Checkpoint changed while preparing backup; retry after Save VM');
 const blob=await sessions.encodeBackup(checkpoint);signal?.throwIfAborted();return {blob,filename:'snowglobe-'+metadata.snapshotSavedAt+'-'+runtime+'.snowglobe'};
}
// Pairing metadata contains no conversation, model credential or host settings.
export function vmBackupManifest(project,metadata){
 if(!metadata||!Number.isSafeInteger(metadata.snapshotSavedAt)||typeof metadata.buildId!=='string')throw Error('A completed Save is required');
 const saved={snapshotSavedAt:metadata.snapshotSavedAt,buildId:metadata.buildId};
 if(metadata.backendConfig){if(!Number.isSafeInteger(metadata.backendSavedAt)||typeof metadata.backendBuild!=='string')throw Error('A completed paired database Save is required');Object.assign(saved,{backendSavedAt:metadata.backendSavedAt,backendBuild:metadata.backendBuild,backendConfig:{url:metadata.backendConfig.url,anonKey:metadata.backendConfig.anonKey}});}
 return {format:'snowglobe-builder-vm-set-v1',project:{name:project.name,template:project.template,backend:metadata.backendConfig?'supabase':'off'},metadata:saved};
}
export async function validateVmBackupSet(manifest,files,configs,sessions){
 if(manifest?.format!=='snowglobe-builder-vm-set-v1'||!manifest.project||typeof manifest.project.name!=='string'||!manifest.project.name.trim()||manifest.project.name.length>80||!['react-vite','vanilla-vite','svelte-vite','sveltekit-spa'].includes(manifest.project.template))throw Error('Invalid Builder backup manifest');
 const canonical=vmBackupManifest(manifest.project,manifest.metadata),checkpoints={};
 if(!canonical.metadata.backendConfig&&files.supabase)throw Error('Database backup supplied for a source-only manifest');
 if(canonical.metadata.backendConfig){const config=canonical.metadata.backendConfig;let role;try{role=JSON.parse(atob(config.anonKey.split('.')[1].replaceAll('-','+').replaceAll('_','/'))).role;}catch{}if(config.url!=='https://supabase.builder.invalid'||role!=='anon')throw Error('Invalid backup backend configuration');}
 for(const runtime of canonical.metadata.backendConfig?['web','supabase']:['web']){
  const file=files[runtime];if(!file||file.size>2*1024*1024*1024)throw Error('Missing or oversized '+runtime+' backup');
  const checkpoint=await sessions.decodeBackup(file),expected=runtime==='web'?canonical.metadata.snapshotSavedAt:canonical.metadata.backendSavedAt;
  if(checkpoint.savedAt!==expected||!sessions.compatible(checkpoint,configs[runtime]))throw Error('Backup timestamp or VM build/configuration does not match');
  if(checkpoint.config.build!==(runtime==='web'?canonical.metadata.buildId:canonical.metadata.backendBuild))throw Error('Backup manifest build mismatch');
  checkpoints[runtime]=checkpoint;
 }
 return {...canonical,checkpoints};
}
export async function importVmBackupSet(manifest,files,configs,sessions,{approve,signal}={}){
 const validated=await validateVmBackupSet(manifest,files,configs,sessions);signal?.throwIfAborted();
 const name=projectName((validated.project.name+' restored').slice(0,80));
 await requireApproval(approve,{title:'Restore VM backups into a new project',description:'These files contain executable VM state and may contain accounts, private rows and service keys. Restore only backups you trust. Existing projects are kept. Conversation and browser preview storage are not restored.',content:JSON.stringify({name,framework:validated.project.template,sourceSavedAt:validated.metadata.snapshotSavedAt,databaseSavedAt:validated.metadata.backendSavedAt,build:validated.metadata.buildId},null,2)},signal);
 const id=crypto.randomUUID(),stores=[],releases=[];
 try{
  for(const [runtime,checkpoint] of Object.entries(validated.checkpoints)){
   signal?.throwIfAborted();const scope=projectScope(id,runtime);releases.push(await sessions.acquireLock(scope));const store=await sessions.BrowserStore.open(scope);stores.push(store);await store.put({...checkpoint,id:'machine'});
  }
  signal?.throwIfAborted();await checkpointStore('readwrite',{savedAt:validated.metadata.snapshotSavedAt,metadata:{...validated.metadata,messages:[],preview:'',previewData:{}}},id);
  signal?.throwIfAborted();await projectStore('put',{id,name,createdAt:Date.now(),template:validated.project.template,backend:validated.project.backend});
  return id;
 }catch(error){
  const cleanup=await Promise.allSettled([...stores.map(store=>store.remove('machine')),checkpointStore('readwrite',null,id)]);
  if(cleanup.some(result=>result.status==='rejected'))throw new Error('Backup import failed; incomplete data may remain under new project '+id+'. Existing projects were kept.');
  throw error;
 }finally{for(const store of stores)store.db.close();for(const release of releases.reverse())await release();}
}
