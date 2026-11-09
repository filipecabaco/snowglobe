import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deviceLogin} from '../codex-device-login.mjs';
import {CodexRuntime} from '../codex-runtime.mjs';
function processFixture(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{if(child.exitCode===null){child.exitCode=143;queueMicrotask(()=>child.emit('exit',143));}return true;};return child;}
test('CLI device login exposes only its public code, tolerates split/color output, and reports completion',async()=>{
 const child=processFixture(),login=deviceLogin({executable:'codex',env:{CODEX_HOME:'/private-test'},cwd:'/',spawnProcess:(bin,args,options)=>{assert.deepEqual(args,['login','--device-auth']);assert.equal(options.env.CODEX_HOME,'/private-test');return child;}});
 child.stdout.write('Open https://auth.openai.com/codex/');child.stdout.write('device\n\u001b[32m    ABCD-');child.stdout.write('12345\u001b[0m\n');
 assert.deepEqual(await login.code,{verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-12345'});
 child.exitCode=0;child.emit('exit',0);await login.completed;await login.cancel();
});
test('cancelling CLI login rejects pending work and does not manufacture authorization',async()=>{
 const child=processFixture(),login=deviceLogin({executable:'codex',env:{CODEX_HOME:'/private-test'},cwd:'/',spawnProcess:()=>child});
 await login.cancel();await assert.rejects(login.code,/without authorization/);await assert.rejects(login.completed,/without authorization/);
});
test('device sign-in cannot fall back to a developer home when called before runtime startup',async()=>{
 assert.throws(()=>deviceLogin({executable:'codex',env:{},cwd:'/'}),/isolated Codex home/);
 const runtime=new CodexRuntime({directory:'/not-started'});await assert.rejects(runtime.loginStart(),/Start the isolated/);
});
test('runtime restarts the official app-server after CLI login and reads account metadata without reading tokens',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sg-cli-login-'));let appStarts=0,cli;
 const runtime=new CodexRuntime({directory,spawnProcess:(bin,args,options)=>{
  assert.equal(options.env.OPENAI_API_KEY,undefined);const child=processFixture();
  if(args[0]==='login'){cli=child;queueMicrotask(()=>child.stdout.write('https://auth.openai.com/codex/device\nABCD-12345\n'));return child;}
  appStarts++;let buffer='';child.stdin.on('data',bytes=>{buffer+=String(bytes);while(buffer.includes('\n')){const at=buffer.indexOf('\n'),message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(message.id===undefined)continue;let result={};if(message.method==='account/read')result={account:appStarts>1?{type:'chatgpt',email:'test@example.invalid',planType:'plus'}:null};if(message.method==='model/list')result={data:[{model:'test-model',displayName:'Test model',isDefault:true}]};queueMicrotask(()=>child.stdout.write(JSON.stringify({id:message.id,result})+'\n'));}});return child;
 }});
 t.after(()=>runtime.close());await runtime.start();assert.equal((await runtime.account()).connected,false);
 assert.equal((await runtime.loginStart()).userCode,'ABCD-12345');assert.equal((await runtime.account()).login.status,'pending');
 cli.exitCode=0;cli.emit('exit',0);await runtime.loginTransition;
 assert.equal(appStarts,2);assert.equal(runtime.failed,undefined);assert.equal((await runtime.account()).connected,true);
 assert(!Object.keys(await runtime.account()).some(key=>/token|secret/i.test(key)));
});
