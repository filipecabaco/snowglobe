import {test} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {ProfileTest} from '../dev/profile-test.mjs';
function fixture(){let result={status:'failed',mode:'live-subscription',disconnected:true},child,spawns=0,env;
 const test=new ProfileTest({spawnProcess:(_exe,_args,options)=>{spawns++;env=options.env;child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit('close',130));return true;};return child;},readResult:async()=>result});
 return {test,get child(){return child;},get spawns(){return spawns;},get env(){return env;},result:value=>{result=value;},line:line=>child.stdout.write(line+'\n')};
}
test('profile controller issues codes only on start and exposes no arbitrary diagnostics',async()=>{
 const f=fixture();assert.equal(f.spawns,0);await f.test.start();assert.equal(f.env.BUILDER_LIVE_SUBSCRIPTION,'1');assert.equal(f.env.BUILDER_PROFILE_FIXTURE,'0');
 f.line('SIGN_IN '+JSON.stringify({verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGHI'}));assert.equal(f.test.state.phase,'awaiting');
 f.child.stderr.write('PRIVATE ACCOUNT TOKEN');f.line('unrecognized PRIVATE SOURCE');assert(!JSON.stringify(f.test.state).includes('PRIVATE'));
 f.line('STATUS Preparing environment PRIVATE DETAIL');assert.equal(f.test.state.phase,'building');assert(!JSON.stringify(f.test.state).includes('PRIVATE'));assert.equal(f.test.state.code,undefined);
 f.line('PASS real source and Supabase VMs prepared before live model request');assert.match(f.test.state.message,/database are ready/);
 f.line('APPROVED synthetic profiles schema migration');assert.match(f.test.state.message,/migration approved/);
 await assert.rejects(f.test.start(),/active/);await f.test.cancel();assert.equal(f.test.state.phase,'cancelled');assert.equal(f.test.child,null);
});
test('profile controller permits explicit code renewal and refuses fixture results as live success',async()=>{
 const f=fixture();await f.test.start();f.line('SIGN_IN '+JSON.stringify({verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGHI'}));await f.test.start();assert.equal(f.spawns,2);
 f.result({status:'passed',disconnected:true,mode:'deterministic-fixture'});f.child.emit('close',0);await f.test.completion;assert.equal(f.test.state.phase,'failed');
 await f.test.start();f.result({status:'passed',disconnected:true,mode:'live-subscription'});f.child.emit('close',0);await f.test.completion;assert.equal(f.test.state.phase,'passed');
});
test('profile controller never claims cancellation or success without confirmed disconnect',async()=>{
 const f=fixture();await f.test.start();f.result({status:'passed',disconnected:false,mode:'live-subscription'});await f.test.cancel();assert.equal(f.test.state.phase,'failed');assert.match(f.test.state.message,/could not be confirmed/);await assert.rejects(f.test.start(),/operator cleanup/);await f.test.cancel();assert.equal(f.test.state.phase,'failed');
});
test('profile controller refuses renewal when the previous session cannot confirm disconnect',async()=>{
 const f=fixture();await f.test.start();f.line('SIGN_IN '+JSON.stringify({verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGHI'}));
 f.result({status:'failed',mode:'live-subscription',disconnected:false});await assert.rejects(f.test.start(),/operator cleanup/);assert.equal(f.spawns,1);assert.equal(f.test.state.phase,'failed');
});
