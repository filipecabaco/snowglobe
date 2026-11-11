import {test} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {createGateway} from '../gateway.mjs';
const accessToken='fixture-operator-token-32-characters-long';
test('production gateway rejects ambiguous origins before accepting requests',async()=>{
 for(const origin of ['http://example.test','https://example.test/','https://example.test/path','https://user:password@example.test'])assert.throws(()=>createGateway({development:false,userTokens:{tester:accessToken},origin}));
 const gateway=createGateway({development:false,userTokens:{tester:accessToken},origin:'https://example.test'});await gateway.dispose();
});
test('CLI fails closed for unknown mode or missing explicit production origin',()=>{
 const file=new URL('../gateway.mjs',import.meta.url).pathname;
 for(const [mode,message] of [['prod',/BUILDER_MODE must be/],['production',/explicit BUILDER_ORIGIN/]]){
  const env={...process.env,BUILDER_MODE:mode,BUILDER_GATEWAY_ACCESS_TOKEN:accessToken};delete env.BUILDER_ORIGIN;
  const child=spawnSync(process.execPath,[file],{env,encoding:'utf8',timeout:10000});
  assert.notEqual(child.status,0);assert.match(child.stderr,message);
 }
});
