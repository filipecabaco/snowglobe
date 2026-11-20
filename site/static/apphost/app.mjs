import {environments,environment,buildSettings} from './environments.mjs';
import {readFolder} from './project.mjs';
import {AppHostVm,setupWorker} from './vm.mjs';

const $ = id => document.getElementById(id);
const stages = ['prepare','copy','install','build','deploy'];
const stageNames = {prepare:'Preparing the browser environment',copy:'Sharing your source files',install:'Installing dependencies',build:'Building your application',deploy:'Deploying your preview'};
let handle=null,project=null,vm=null,busy=false,controller=null,previewUrl=null,timer=null,started=0,lastStage='',logText='',buildName='';
const status = text => {$('app-status').textContent=text;};
const error = text => {$('app-error').textContent=text; $('app-error').hidden=!text;};
const size = bytes => bytes < 1048576 ? (bytes/1024).toFixed(1)+' KiB' : (bytes/1048576).toFixed(1)+' MiB';
const currentEnvironment = () => $('environment').value === 'auto' ? project?.detection.id : $('environment').value;

for (const recipe of environments) {$('environment').add(new Option(recipe.name,recipe.id));}

function tab(name,{focus=false}={}) {
  for (const view of ['build','preview']) {
    const selected=view===name, button=$('tab-'+view);
    button.setAttribute('aria-selected',String(selected)); button.tabIndex=selected?0:-1;
    $('panel-'+view).hidden=!selected;
  }
  if (focus) $('tab-'+name).focus();
}
for (const name of ['build','preview']) {
  $('tab-'+name).addEventListener('click',()=>tab(name));
  $('tab-'+name).addEventListener('keydown',event=>{
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); tab(event.key==='Home'?'build':event.key==='End'?'preview':name==='build'?'preview':'build',{focus:true});
  });
}
$('back-to-build').addEventListener('click',()=>tab('build',{focus:true}));

function controls() {
  $('choose-folder').disabled=busy || !vm || !('showDirectoryPicker' in window);
  $('refresh-folder').disabled=busy;
  $('environment').disabled=busy;
  $('build-script').disabled=busy || currentEnvironment()==='static';
  $('output-folder').disabled=busy;
  $('deploy').disabled=busy || !vm || !project || !currentEnvironment();
  $('cancel-build').hidden=!busy || !controller;
  if (!busy) $('cancel-build').disabled=false;
}
function configure({defaults=true}={}) {
  const id=currentEnvironment(), recipe=id?environment(id):null;
  $('environment-info').hidden=!recipe;
  if (recipe) {
    $('environment-name').textContent=recipe.name;
    $('environment-description').textContent=recipe.detail;
    if (defaults) {$('build-script').value=recipe.script; $('output-folder').value=recipe.output;}
  }
  $('detection-detail').textContent=$('environment').value==='auto' ? project?.detection.reason || 'We’ll look at package.json and your project files.' : 'Using your selected setup. '+(project?.detection.reason || '');
  $('detection-badge').textContent=$('environment').value==='auto'?'AUTO DETECT':'MANUAL SETUP';
  controls();
}
$('environment').addEventListener('change',()=>{configure(); changed();});
for (const id of ['build-script','output-folder']) $(id).addEventListener('input',changed);
function changed() {if (previewUrl) $('deployment-status').textContent='Settings or source changed. Build again to update Preview.';}

function showProject(next,{defaults=true}={}) {
  project=next;
  $('folder-empty').hidden=true; $('folder-selected').hidden=false;
  $('folder-name').textContent=handle.name;
  $('folder-meta').textContent=next.files.length+' files · '+size(next.bytes)+' · '+next.skipped+' excluded entries';
  $('choose-folder').firstChild.textContent='Change folder ';
  $('refresh-folder').hidden=false;
  $('file-list').replaceChildren(...next.files.map(({path})=>{const item=document.createElement('li');item.textContent=path;return item;}));
  configure({defaults}); changed();
}

async function selectFolder() {
  if (busy) return;
  error('');
  // The picker must be called synchronously from the user's click.
  let selected;
  try {selected=await window.showDirectoryPicker({id:'snowglobe-apphost',mode:'read'});}
  catch (e) {if (e.name!=='AbortError') error(e.message); return;}
  busy=true; controls(); status('Reading '+selected.name+'…');
  try {const next=await readFolder(selected);handle=selected;showProject(next);status('Folder shared. Review the environment, then build and deploy.');}
  catch (e) {error(e.message);status('Could not share that folder.');}
  finally {busy=false;controls();}
}
$('choose-folder').addEventListener('click',event=>{if (event.isTrusted) selectFolder();});
$('refresh-folder').addEventListener('click',async event=>{
  if (!event.isTrusted || busy || !handle) return;
  busy=true;controls();error('');
  try {showProject(await readFolder(handle),{defaults:false});status('Source files refreshed from your folder.');}
  catch (e) {project=null;error(e.message);}
  finally {busy=false;controls();}
});

function log(text) {
  logText=(logText+text).slice(-200000);
  const area=$('build-log'),atBottom=area.scrollHeight-area.scrollTop-area.clientHeight<60;
  area.textContent=logText;
  if (atBottom) area.scrollTop=area.scrollHeight;
  $('logs-empty').hidden=true; $('download-logs').disabled=false;
  for (const stage of [...logText.matchAll(/^APPHOST_STAGE (\w+)$/gm)]) setStage(stage[1]);
}
function setStage(stage) {
  if (!stages.includes(stage) || stages.indexOf(stage)<=stages.indexOf(lastStage)) return;
  lastStage=stage;
  for (const item of $('build-stages').children) {
    const value=item.dataset.stage,index=stages.indexOf(value);
    item.dataset.state=currentEnvironment()==='static' && ['install','build'].includes(value) ? 'skipped' : index<stages.indexOf(stage)?'done':value===stage?'active':'';
  }
  $('build-activity').textContent=stageNames[stage];status(stageNames[stage]+'…');
}
function elapsed() {const seconds=Math.floor((Date.now()-started)/1000);$('build-elapsed').textContent=seconds<60?seconds+'s':Math.floor(seconds/60)+'m '+seconds%60+'s';}
function preview() {
  if (!previewUrl || !vm.deployed) return;
  navigator.serviceWorker.controller?.postMessage({type:'snowglobe-preview-nav',url:previewUrl});
  $('app-frame').src=previewUrl;
  $('app-frame').hidden=false; $('preview-empty').hidden=true;
}

$('deploy').addEventListener('click',async event=>{
  if (!event.isTrusted || busy || !project || !currentEnvironment()) return;
  let settings;
  try {settings=buildSettings(currentEnvironment(),$('build-script').value.trim(),$('output-folder').value);}
  catch (e) {error(e.message);$('build-settings').open=true;return;}
  busy=true;controller=new AbortController();controls();error('');
  lastStage='';logText='';$('build-log').textContent='';$('log-state').textContent='BUILDING';$('log-state').dataset.state='running';
  started=Date.now();elapsed();timer=setInterval(elapsed,1000);
  buildName=handle.name;
  try {
    setStage('copy');
    // Snapshot again at the moment of build: local edits and deletions are reflected.
    const fresh=await readFolder(handle,{signal:controller.signal});
    project=fresh;
    $('folder-meta').textContent=fresh.files.length+' files · '+size(fresh.bytes)+' · '+fresh.skipped+' excluded entries';
    lastStage='';
    log('App Host · '+buildName+'\nEnvironment: '+settings.name+'\nSource: '+fresh.files.length+' files · '+size(fresh.bytes)+'\n\n');
    const deployment=await vm.build(fresh,settings,controller.signal);
    previewUrl=deployment.url;
    for (const item of $('build-stages').children) if (item.dataset.state!=='skipped') item.dataset.state='done';
    $('log-state').textContent='DEPLOYED';$('log-state').dataset.state='success';
    $('build-activity').textContent='Build complete';
    $('deployment-status').textContent='Deployed '+buildName+' at '+new Date().toLocaleTimeString()+'. Rebuild to pick up local changes.';
    $('preview-name').textContent=buildName;
    $('preview-location').textContent=settings.name+' · browser VM';
    $('preview-dot').hidden=false;$('preview-status-dot').classList.add('live');
    $('reload-preview').disabled=false;$('fullscreen-preview').disabled=false;
    log('\nBuild successful. Your application is ready.\n');status('Deployed '+buildName+'. Your application is running in Preview.');
    preview();tab('preview');
  } catch (e) {
    const cancelled=controller.signal.aborted;
    const message=cancelled?'Build cancelled.':e.message;
    log('\n'+message+'\n');
    $('log-state').textContent=cancelled?'CANCELLED':'FAILED';$('log-state').dataset.state='error';
    $('build-activity').textContent=cancelled?'Build cancelled':'Build failed';
    for (const item of $('build-stages').children) if (item.dataset.state==='active') item.dataset.state='';
    status(message+(previewUrl?' The previous deployment is still available.':''));
    if (!cancelled) error(message);
  } finally {clearInterval(timer);timer=null;controller=null;busy=false;controls();}
});
$('cancel-build').addEventListener('click',()=>{controller?.abort();$('cancel-build').disabled=true;status('Cancelling the build…');});
$('reload-preview').addEventListener('click',preview);
$('fullscreen-preview').addEventListener('click',async()=>{
  try {if (document.fullscreenElement) await document.exitFullscreen();else await $('panel-preview').requestFullscreen();}
  catch (e) {error('Full screen could not open: '+e.message);tab('build');}
});
$('download-logs').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([logText],{type:'text/plain'})),link=document.createElement('a');link.href=url;link.download='apphost-build.log';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
addEventListener('beforeunload',event=>{if (busy || vm?.deployed) {event.preventDefault();event.returnValue='';}});
addEventListener('pagehide',()=>{controller?.abort();vm?.destroy();});

navigator.serviceWorker?.addEventListener('message',event=>{
  if (event.data?.type!=='snowglobe-preview' || !event.ports[0]) return;
  const channel=event.ports[0], cancel=new AbortController();
  channel.onmessage=({data})=>{if(data?.type==='cancel')cancel.abort();};
  channel.postMessage({type:'taken'});
  const send=(message,transfer=[])=>channel.postMessage(message,transfer);
  const respond=vm ? vm.request(event.data.request,send,{signal:cancel.signal}) : Promise.reject(Error('App Host is loading.'));
  respond.catch(e=>send({type:'error',...SnowglobePreview.errorPage(502,'The preview failed',e.message)}));
});
addEventListener('message',event=>{
  if (event.origin!==location.origin || event.source!==$('app-frame').contentWindow || event.data?.type!=='snowglobe-preview-log') return;
  if (['error','network','warn'].includes(event.data.level)) log('\n[preview '+event.data.level+'] '+String(event.data.text).slice(0,1000)+'\n');
});

try {
  if (window.top!==window) throw Error('Open App Host in its own browser tab.');
  await setupWorker();
  const response=await fetch('runtimes.json',{cache:'no-store'});
  if (!response.ok) throw Error('The environment catalog is unavailable. Run snowglobe agent-pages dist after building the web example.');
  const manifest=await response.json();
  const runtime=manifest.runtimes?.find(item=>item.name==='web' && item.network==='fetch');
  if (!runtime) throw Error('The Node web environment is missing from this site. Build examples/web and regenerate the runtime catalog.');
  $('runtime-spec').textContent='Node.js + npm · '+runtime.memory_mb+' MiB';
  vm=new AppHostVm(manifest,{onLog:log,onStage:setStage,onProgress:text=>{$('build-activity').textContent=text;},onError:e=>{
    previewUrl=null;$('preview-dot').hidden=true;$('preview-status-dot').classList.remove('live');
    $('reload-preview').disabled=true;$('fullscreen-preview').disabled=true;
    $('app-frame').hidden=true;$('app-frame').removeAttribute('src');$('preview-empty').hidden=false;
    error(e.message);status('The browser environment stopped. Rebuild to restart it.');
  }});
  status('Choose a local app folder to get started.');
  if (!('showDirectoryPicker' in window)) {status('Folder sharing requires desktop Chrome or Edge.');error('Open this page in desktop Chrome or Edge to share a local folder.');}
  configure();
} catch (e) {status('App Host could not start.');error(e.message);controls();}
