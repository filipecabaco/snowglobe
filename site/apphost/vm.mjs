import {archiveProject} from './project.mjs';

export const port = 4180;
const tools = ['guest.mjs','server.mjs','environments.mjs','project.mjs'];
const base = '/var/lib/snowglobe-apphost';
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

export async function setupWorker() {
  if (!isSecureContext) throw Error('App Host needs HTTPS or localhost to share folders and show previews.');
  if (!('serviceWorker' in navigator)) throw Error('This browser does not support the preview service worker. Try desktop Chrome or Edge.');
  await navigator.serviceWorker.register('sw.js', {scope:'./'});
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((resolve,reject) => {
    const timeout = setTimeout(()=>{navigator.serviceWorker.removeEventListener('controllerchange',change);reject(Error('The preview worker did not take control. Reload this page.'));},10000);
    const change = () => {clearTimeout(timeout); resolve();};
    navigator.serviceWorker.addEventListener('controllerchange',change,{once:true});
    if (navigator.serviceWorker.controller) {navigator.serviceWorker.removeEventListener('controllerchange',change);change();}
  });
}

export class AppHostVm {
  constructor(manifest, {onLog=()=>{}, onStage=()=>{}, onProgress=()=>{}, onError=()=>{}} = {}) {
    this.manifest=manifest; this.onLog=onLog; this.onStage=onStage; this.onProgress=onProgress; this.onError=onError;
    this.host=null; this.currentJob=null; this.deployed=false;
  }

  async boot(signal) {
    if (this.host) return;
    signal.throwIfAborted();
    const runtime = this.manifest.runtimes.find(item => item.name === 'web' && item.network === 'fetch');
    if (!runtime) throw Error('The Node web environment is missing. Build examples/web, then run snowglobe agent-pages dist.');
    if (runtime.cpus > 1 && !crossOriginIsolated) throw Error('This VM needs browser isolation. Reload this page after the preview worker has installed.');
    const absolute = url => new URL(url,location.href).href;
    const runtimeBase = new URL(runtime.base,location.href);
    const config = {
      name:'apphost', memory_mb:runtime.memory_mb, cpus:runtime.cpus,
      wasm:this.manifest.armless.wasm ? absolute(this.manifest.armless.wasm) : undefined,
      wasm_smp:this.manifest.armless.wasm_smp ? absolute(this.manifest.armless.wasm_smp) : undefined,
      filesystem:{json:'system/filesystem.json',baseurl:runtime.baseurl || 'system/filesystem/'},
      initial_state:'system/state.bin.zst', warm:'system/warm.pack', network:{tls:'system/tls.json'},
    };
    const host = SnowglobeHost.createMachine({base:runtimeBase.href,config,transport:'worker',uploadWindow:4,scripts:{
      worker:absolute('machine-worker.js'),
      core:[absolute(this.manifest.armless.js),...['sessions.js','agent.js','transfer.js','ws-client.js','machine-core.js'].map(absolute)],
    }});
    this.host=host;
    host.on('progress',event => {if (event.total) this.onProgress('Loading environment · '+Math.round(event.loaded/event.total*100)+'%');});
    host.on('error',error => {if (error.fatal) {this.host=null; this.deployed=false; this.onError(Error(error.message));}});
    const abort = () => {host.destroy().catch(()=>{});};
    signal.addEventListener('abort',abort,{once:true});
    try {await host.boot(); signal.throwIfAborted(); await host.run(); signal.throwIfAborted();}
    catch (error) {this.host=null; await host.destroy().catch(()=>{}); throw error;}
    finally {signal.removeEventListener('abort',abort);}
  }

  async run(command, {files,signal,timeoutSeconds=3600} = {}) {
    signal.throwIfAborted();
    const host=this.host;
    const {jobId}=await host.runCommand({command,files,timeoutSeconds});
    this.currentJob=jobId;
    const abort=()=>{host.cancelJob(jobId).catch(()=>{});};
    signal.addEventListener('abort',abort,{once:true});
    if (signal.aborted) abort();
    let previous='';
    try {
      for (;;) {
        const job=await host.readJob(jobId), output=job.output || '';
        if (output !== previous) {this.onLog(output.startsWith(previous) ? output.slice(previous.length) : '\n[Earlier output omitted]\n'+output); previous=output;}
        if (job.state !== 'running') {
          signal.throwIfAborted();
          if (job.state==='timed_out') {
            const stage=[...output.matchAll(/APPHOST_STAGE (\w+)/g)].at(-1)?.[1];
            throw Error(stage==='install' ? 'Dependency installation timed out before compilation. Keep this tab open and retry to reuse verified package downloads.' : 'The build timed out. Keep this tab open and retry to reuse installed dependencies.');
          }
          if (job.state !== 'exited' || job.exitStatus !== 0) throw Error(job.error || 'The build stopped with '+(job.state === 'exited' ? 'exit '+job.exitStatus : job.state)+'. Check the logs and try again.');
          return output;
        }
        await delay(400);
      }
    } finally {signal.removeEventListener('abort',abort); this.currentJob=null;}
  }

  async build(project,settings,signal) {
    this.onStage('prepare');
    await this.boot(signal);
    this.onStage('copy');
    const archive=await archiveProject(project,signal);
    this.onLog('Sharing '+project.files.length+' files ('+(archive.size/1048576).toFixed(2)+' MiB compressed) with the browser VM.\n');
    await this.host.writeFile('/tmp/apphost-source.gz',archive,{signal,onProgress:progress=>this.onProgress('Sharing source · '+Math.round(progress.done/Math.max(1,progress.total)*100)+'%')});
    signal.throwIfAborted();
    const id=crypto.randomUUID();
    const prefix=new URL('preview/web/'+port,location.href).pathname;
    const config={id,environment:settings.id,script:settings.script,output:settings.output,prefix,archive:'/tmp/apphost-source.gz'};
    const responses=await Promise.all(tools.map(async name=>{
      const response=await fetch(name,{signal,cache:'no-store'});
      if (!response.ok) throw Error('Could not load the environment helper '+name+'.');
      return [name,new Uint8Array(await response.arrayBuffer())];
    }));
    const files=Object.fromEntries(responses);
    files['config.json']=new TextEncoder().encode(JSON.stringify(config));
    const install=tools.map(name=>'cp "$EXCLAVE_WORKSPACE/in/'+name+'" '+base+'/'+name).join('\n');
    const output=await this.run('set -e\nmkdir -p '+base+'\n'+install+'\n'+
      'if ! wget -qO- http://127.0.0.1:'+port+'/__apphost_health >/dev/null 2>&1; then\n'+
      '  setsid node '+base+'/server.mjs >'+base+'/server.log 2>&1 </dev/null &\nfi\n'+
      'attempt=0; until wget -qO- http://127.0.0.1:'+port+'/__apphost_health >/dev/null 2>&1; do attempt=$((attempt+1)); if [ "$attempt" -ge 60 ]; then cat '+base+'/server.log; exit 1; fi; sleep 1; done\n'+
      'node '+base+'/guest.mjs "$EXCLAVE_WORKSPACE/in/config.json"\n', {files,signal});
    if (!output.includes('APPHOST_DEPLOYED '+id)) throw Error('The environment did not confirm deployment. Check the logs and retry.');
    this.deployed=true;
    return {id,url:new URL('preview/web/'+port+'/',location.href).href};
  }

  async request(request,send,{signal}={}) {
    if (!this.host || !this.deployed || request.runtime !== 'web' || request.port !== port) {
      send({type:'error',...SnowglobePreview.errorPage(503,'No app is running','Build and deploy your shared folder first.')}); return;
    }
    await SnowglobePreview.serve(p=>this.host.tcpOpen(p),request,send,{signal});
  }

  destroy() {this.deployed=false; const host=this.host; this.host=null; return host?.destroy();}
}
