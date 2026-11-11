import {test} from 'node:test';import assert from 'node:assert/strict';
import {needsSourceRecovery,restoreSource} from '../src/checkpoint.js';
test('source recovery prefers interrupted saves but preserves newer automatic VM checkpoints',()=>{
 assert.equal(needsSourceRecovery({savedAt:200},{saved:{savedAt:100}}),true);
 assert.equal(needsSourceRecovery({savedAt:200},{saved:{savedAt:300}}),true);
 assert.equal(needsSourceRecovery({savedAt:200,metadata:{}},{saved:{savedAt:100}}),true);
 assert.equal(needsSourceRecovery({savedAt:200,metadata:{}},{saved:{savedAt:300}}),false);
 assert.equal(needsSourceRecovery({savedAt:200,metadata:{}},{saved:null}),true);
});
test('source recovery sends a complete version-checked restore and retains conflict protection',async()=>{
 const calls=[];const client={async call(op,args){if(op==='project.export')return {files:{'src/App.jsx':'old source','deleted.js':'remove me'}};calls.push({op,args});}};
 const files={'src/App.jsx':'latest app','new.js':'new file'};await restoreSource(client,files,undefined,undefined,{approve:async()=>true});
 assert.equal(calls[0].op,'project.restore');assert.deepEqual(calls[0].args.changes,{...files,'deleted.js':null});assert.equal(calls[0].args.expected['src/App.jsx'].length,64);assert.equal(calls[0].args.expected['deleted.js'].length,64);
 const denied={async call(op){if(op==='project.export')return {files:{'src/App.jsx':'old'}};throw new Error('Conflict');}};
 await assert.rejects(restoreSource(denied,files,undefined,undefined,{approve:async()=>true}),/Conflict/);
});

test('recovering an older database reapplies named schema migrations in order, preserving migration errors',async()=>{
 const calls=[];const client={async call(op){if(op==='project.export')return {files:{}};}};
 const files={'supabase/migrations/20261108000002_policy.sql':'policy','src/App.jsx':'app','supabase/migrations/20261108000001_table.sql':'table'};
 await restoreSource(client,files,undefined,async migration=>calls.push(migration),{approve:async()=>true});
 assert.deepEqual(calls.map(call=>call.sql),['table','policy']);
 await assert.rejects(restoreSource(client,files,undefined,async()=>{throw new Error('Migration conflict');},{approve:async()=>true}),/Migration conflict/);
});
test('mismatched recovery fails closed on denial or absent approval and keeps source copies untouched',async()=>{
 const mutations=[],client={async call(op,args){if(op==='project.export')return {files:{'src/app.js':'VM source'}};mutations.push({op,args});}};
 const files={'src/app.js':'saved source'};let review;
 await assert.rejects(restoreSource(client,files,undefined,undefined,{approve:async request=>{review=request;return false;}}),/denied|cancel|approved/i);assert.match(review.content,/VM source/);assert.match(review.content,/saved source/);assert.deepEqual(mutations,[]);assert.equal(files['src/app.js'],'saved source');
 await assert.rejects(restoreSource(client,files),/denied/i);assert.deepEqual(mutations,[]);
});
