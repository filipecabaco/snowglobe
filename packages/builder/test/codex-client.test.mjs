import {test} from 'node:test';import assert from 'node:assert/strict';import {CodexAgent} from '../src/codex-client.js';
test('Codex client rejects silent or error-marked success instead of accepting an empty app turn',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 const agent=new CodexAgent({model:'test',post:async()=>{},execute:async()=>({}),onText(){},onTool(){}});
 globalThis.fetch=async()=>new Response('data: '+JSON.stringify({type:'done',status:'completed'})+'\n\n');await assert.rejects(agent.prompt('Build an app'),/no response/);
 globalThis.fetch=async()=>new Response('data: '+JSON.stringify({type:'done',status:'completed',error:'Model is unavailable'})+'\n\n');await assert.rejects(agent.prompt('Build an app'),/Model is unavailable/);
});
