// Standard Codex CLI device authentication, in the runtime's isolated CODEX_HOME.
// Only the public verification URL and user code leave this helper. Codex stores credentials.
import {spawn} from 'node:child_process';
import {safeError} from './errors.mjs';
export function deviceLogin({executable,env,cwd,spawnProcess=spawn}) {
 if(typeof env?.CODEX_HOME!=='string'||!env.CODEX_HOME)throw new Error('An isolated Codex home is required for device sign-in');
 const child=spawnProcess(executable,['login','--device-auth'],{env:{...env,NO_COLOR:'1',TERM:'dumb'},cwd,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let output='',ready=false,ended=false,resolveCode,rejectCode,resolveEnd,rejectEnd;
 const code=new Promise((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});
 const completed=new Promise((resolve,reject)=>{resolveEnd=resolve;rejectEnd=reject;});code.catch(()=>{});completed.catch(()=>{});
 const kill=signal=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{}};
 const fail=error=>{if(!ready)rejectCode(error);rejectEnd(error);};
 const timer=setTimeout(()=>{if(!ready){fail(new Error('Codex CLI did not issue a sign-in code. Retry the connection.'));kill('SIGTERM');}},30000);
 const data=chunk=>{
  output=(output+String(chunk)).slice(-16000);const plain=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  const url=plain.match(/https:\/\/auth\.openai\.com\/codex\/device\b/),match=plain.match(/(?:^|\n)\s*([A-Z0-9]{4}-[A-Z0-9]{4,8})\s*(?:\r?\n|$)/);
  if(!ready&&url&&match){ready=true;clearTimeout(timer);resolveCode({verificationUrl:url[0],userCode:match[1]});}
 };
 child.stdout.on('data',data);child.stderr.on('data',data);
 child.on('error',()=>{clearTimeout(timer);fail(new Error('Codex CLI sign-in could not start on the development server'));});
 child.on('exit',status=>{ended=true;clearTimeout(timer);if(status===0&&ready)resolveEnd();else{const plain=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');const errorLine=plain.split(/[\r\n]+/).filter(line=>/^error[: ]|^failed[: ]/i.test(line.trim())).slice(-1)[0];fail(new Error(errorLine?safeError(errorLine):'Codex CLI sign-in ended without authorization. Request a fresh code.'));}});
 return {code,completed,async cancel(){if(ended)return;kill('SIGTERM');await new Promise(resolve=>{if(ended)return resolve();const timer=setTimeout(()=>{kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}};
}
