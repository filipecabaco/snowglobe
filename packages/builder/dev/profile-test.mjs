// Private development controller: user requests device codes on demand. Only
// whitelisted status/code fields leave this process; diagnostics stay local.
import {spawn} from 'node:child_process';import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';
import {createLiveTestServer} from './live-test.mjs';
export class ProfileTest{
 constructor({spawnProcess=spawn,readResult=file=>fs.readFile(file,'utf8').then(JSON.parse)}={}){Object.assign(this,{spawnProcess,readResult});this.state={phase:'idle',message:'Ready. Request a sign-in code when you are ready to approve it.',checks:[]};}
 async start(){
  if(this.disconnectUnconfirmed)throw Error('Previous provider disconnect is unconfirmed; operator cleanup is required before another test.');
  if(this.child&&!['awaiting','failed'].includes(this.state.phase))throw Error('A test is active. Cancel it before requesting another code.');
  if(this.child)await this.cancel();
  if(this.disconnectUnconfirmed)throw Error('Previous provider disconnect is unconfirmed; operator cleanup is required before another test.');
  const resultName='live-profile-run-'+randomUUID()+'.json',file=new URL('../../../.local-dev/'+resultName,import.meta.url);
  this.state={phase:'starting',message:'Requesting a fresh OpenAI sign-in code…',checks:[]};let cancelled=false,buffer='',finish;
  const child=this.child=this.spawnProcess(process.execPath,[fileURLToPath(new URL('../test/live-profile-browser.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe'],env:{...process.env,BUILDER_LIVE_SUBSCRIPTION:'1',BUILDER_PROFILE_FIXTURE:'0',BUILDER_PROFILE_RESULT_NAME:resultName}});
  this.completion=new Promise(resolve=>finish=resolve);this.requestCancel=()=>{cancelled=true;child.kill('SIGTERM');};
  const timer=setTimeout(()=>{if(this.child===child&&this.state.phase==='starting'){this.state={phase:'failed',message:'A sign-in code was not issued. Cancel or retry.',checks:[]};this.requestCancel();}},60000);timer.unref();
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>32768)buffer=buffer.slice(-32768);for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(this.child!==child||cancelled)continue;
   if(line.startsWith('SIGN_IN ')&&this.state.phase==='starting'){try{const code=JSON.parse(line.slice(8));if(code.verificationUrl!=='https://auth.openai.com/codex/device'||!/^[A-Z0-9]{4}-[A-Z0-9]{4,8}$/.test(code.userCode))throw Error();clearTimeout(timer);this.state={phase:'awaiting',message:'Enter the code on OpenAI’s sign-in page. Tests start after approval.',code:code.userCode,verificationUrl:code.verificationUrl,issuedAt:Date.now(),checks:[]};}catch{this.state={phase:'failed',message:'Unexpected sign-in response. Cancel and retry.',checks:[]};this.requestCancel();}}
   else if(this.state.phase==='awaiting'&&line.startsWith('STATUS ')&&!line.includes('Open the sign-in link'))this.state={phase:'building',message:'Sign-in approved. Preparing and testing the profile app…',checks:[]};
   else if(line==='PASS real source and Supabase VMs prepared before live model request')this.state={phase:'building',message:'Source and database are ready. Asking the live model to build the profile app…',checks:[]};
   else if(line==='APPROVED synthetic profiles schema migration')this.state={phase:'building',message:'Reviewed profiles migration approved. Building and testing account/profile behavior…',checks:[]};
   else if(line.startsWith('REPAIR '))this.state={phase:'building',message:'Repairing the profile workflow within the same approved session…',checks:this.state.checks};
   else if(line.startsWith('PASS live generated profile app'))this.state={phase:'checking',message:'Profile data and two-user isolation passed. Checking save and reload…',checks:['Two accounts, profile data and row isolation passed.']};
  }});
  // Provider errors/stack traces can contain sensitive details. Never expose them.
  child.stderr.resume();let ended=false;
  const done=async()=>{if(ended)return;ended=true;clearTimeout(timer);let result;try{result=await this.readResult(file);}catch{}if(this.child===child){this.child=null;this.requestCancel=null;this.disconnectUnconfirmed=!result?.disconnected;
   if(cancelled)this.state={phase:result?.disconnected?'cancelled':'failed',message:result?.disconnected?'Test cancelled and disconnected.':'Test stopped; provider disconnect could not be confirmed. Return to the operator.',checks:[]};
   else if(result?.status==='passed'&&result?.disconnected&&result?.mode==='live-subscription')this.state={phase:'passed',message:'Live profiles, account isolation and checkpoint tests passed. Session disconnected.',checks:['Real model generation and database migration.','Two accounts and direct row isolation.','Profile save/reload and denied destructive SQL.']};
   else if(result?.mode==='live-subscription'&&result.disconnected&&!result.checks?.includes('user-approved-subscription'))this.state={phase:'expired',message:'Sign-in was not completed. Request a fresh code when you are ready.',checks:[]};
   else this.state={phase:'failed',message:result?.disconnected?'The test stopped and disconnected. Diagnostics were retained privately; return to chat.':'The test stopped; disconnect could not be confirmed. Return to the operator.',checks:[]};
  }finish(result);};child.once('close',done);child.once('error',done);
 }
 async cancel(){if(!this.child){if(this.disconnectUnconfirmed)return;this.state={phase:'cancelled',message:'No test session remains active.',checks:[]};return;}const child=this.child;this.state={phase:'disconnecting',message:'Stopping and disconnecting the test…',checks:[]};this.requestCancel();const timer=setTimeout(()=>child.kill('SIGKILL'),15000);try{await this.completion;}finally{clearTimeout(timer);}}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const template=await fs.readFile(new URL('./live-test.html',import.meta.url),'utf8'),html=template.replace('This creates a small voting app','This creates an accounts and editable profiles app');
 const server=createLiveTestServer({test:new ProfileTest(),html});server.listen(18448,'127.0.0.1',()=>console.log('Private live-profile test page ready on loopback 18448; no code requested until a user clicks.'));
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await server.dispose();server.close(()=>process.exit(0));});
}
