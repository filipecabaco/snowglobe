import pathPolicy from './path-policy.js?raw';
import previewAssets from './preview-assets.mjs?raw';
import {parseGuestOutput} from './progress.js';
import compiler from './compiler.mjs?raw';
import guest from './guest.mjs?raw';
import sourceFiles from './source-files.js?raw';
import provision from './provision.mjs?raw';
import frameworks from './frameworks.js?raw';
import templateCatalog from './template-catalog.mjs?raw';
import staticPreview from './static-preview.mjs?raw';
import {gzipSync} from 'fflate';
export class VmClient {
  constructor(api,{onProgress=()=>{},runtime='web',guestSource=guest,compilerSource=compiler,executable='node'}={}) {this.runtime=runtime;this.guestSource=guestSource;this.compilerSource=compilerSource;this.executable=executable;this.onProgress=onProgress;this.api=api;this.projectId='local-builder';this.vmGeneration=1;this.tail=Promise.resolve();this.installed=false;}
  call(op,params={},signal) {
    const run=async(recovered=false)=>{
      signal?.throwIfAborted();
      if(this.api.wake)await this.api.wake(this.runtime);
      signal?.throwIfAborted();
      const host=this.api._get?.(this.runtime)?.host;
      if(host&&host!==this.host){if(this.host)this.vmGeneration++;this.host=host;this.installed=false;}
      this.onProgress({stage:'transfer',message:this.installed?'Sending your change to the environment':'Starting your environment and installing its project tools'});
      const request={protocol:'snowglobe-builder-rpc-v1',id:crypto.randomUUID(),projectId:this.projectId,vmGeneration:this.vmGeneration,op,params};
      const files={'request.json':new TextEncoder().encode(JSON.stringify(request))};
      let command=this.executable+' /var/lib/snowglobe-builder/bridge.mjs "$EXCLAVE_WORKSPACE/in/request.json"';
      if(!this.installed){
        const tools={'compiler.mjs':this.compilerSource};
        if(this.runtime==='web')Object.assign(tools,{'path-policy.js':pathPolicy,'preview-assets.mjs':previewAssets,'source-files.js':sourceFiles,'frameworks.js':frameworks,'template-catalog.mjs':templateCatalog,'provision.mjs':provision,'static-preview.mjs':staticPreview});
        tools['bridge.mjs']=this.guestSource;
        let install='mkdir -p /var/lib/snowglobe-builder';
        for(const [name,source] of Object.entries(tools)){
          files[name+'.gz']=gzipSync(new TextEncoder().encode(source));
          install+=' && gzip -dc "$EXCLAVE_WORKSPACE/in/'+name+'.gz" > /var/lib/snowglobe-builder/'+name+'.new && mv /var/lib/snowglobe-builder/'+name+'.new /var/lib/snowglobe-builder/'+name;
        }
        command=install+' && '+command;
      }
      const {jobId}=await this.api.runCommand({runtime:this.runtime,command,timeoutSeconds:['project.initialize','project.dependencies','preview.build'].includes(op)?900:300},{wrap:true,files});
      const abort=()=>this.api.cancelJob(jobId).catch(()=>{});
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      try {
        let job,seen=0,parsed;
        do {
          await new Promise(r=>setTimeout(r,300));job=await this.api.readJob(jobId);
          parsed=parseGuestOutput(job.output,request,job.state!=='running');
          for(const event of parsed.events.slice(seen))this.onProgress(event);
          seen=parsed.events.length;
        }while(job.state==='running');
        signal?.throwIfAborted();
        if(job.truncated)throw new Error('Guest output exceeds the development transport limit. Simplify this project before retrying.');
        if(job.state!=='exited'){
          this.installed=false;
          // Step zero only creates upload directories. No project helper or model-requested
          // operation has run yet, so it is safe to repair image downloads and retry once.
          if(!recovered&&job.state==='failed'&&job.uploadFailure?.step===0&&[126,127].includes(job.uploadFailure.status)){
            this.onProgress({stage:'file-recovery',message:'Restoring environment files · your project is kept'});
            try{await this.api.recoverFiles(this.runtime);}catch(error){throw new Error('Environment files could not be restored: '+error.message+'. Check the dev server connection and retry. Your project is kept.');}
            signal?.throwIfAborted();return await run(true);
          }
          throw new Error('Guest operation '+op+' '+job.state+': '+(job.error||'Retry the operation. Builds can take several minutes on slower devices.'));
        }
        const response=parsed.response;
        if(!response)throw new Error('Guest operation '+op+' returned no complete result: '+(job.error||job.output.slice(-1000)));
        if(job.exitStatus!==0&&response.ok)throw new Error('Guest process exited with '+job.exitStatus);
        if(!response.ok)throw new Error(response.error);
        this.installed=true;
        if(response.id!==request.id||response.projectId!==request.projectId||response.vmGeneration!==this.vmGeneration||(host&&this.api._get?.(this.runtime)?.host!==host))throw new Error('Stale guest result');
        return response.result;
      } finally {signal?.removeEventListener('abort',abort);}
    };
    const promise=this.tail.then(()=>run());this.tail=promise.catch(()=>{});return promise;
  }
}
