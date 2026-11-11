import {test} from 'node:test';import assert from 'node:assert/strict';import {validateExtension,projectSummaryExtension} from '../src/extensions.js';
test('Builder extensions reject native, write and host capabilities before execution',()=>{
 assert.equal(validateExtension(projectSummaryExtension).id,'project-summary');
 for(const scopes of [['files:write'],['shell'],['host:credentials'],['files:list','files:list']])assert.throws(()=>validateExtension({...projectSummaryExtension,scopes}),/permission/);
 for(const extra of [{version:2},{id:'../escape'},{source:'x'.repeat(32769)}])assert.throws(()=>validateExtension({...projectSummaryExtension,...extra}));
});
