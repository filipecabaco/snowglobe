import {test} from 'node:test';import assert from 'node:assert/strict';import {createApprovalPrompt} from '../src/approvals.js';
function dialogFixture(){const nodes=new Map(),dialog=new EventTarget();dialog.querySelector=selector=>{if(!nodes.has(selector))nodes.set(selector,{});return nodes.get(selector);};dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};return dialog;}
test('a stale approval callback cannot settle or disable the next approval',async()=>{
 const dialog=dialogFixture(),ask=createApprovalPrompt(dialog),request={title:'Review',description:'Exact action',content:'SQL'};
 const first=ask(request),oldApprove=dialog.querySelector('[data-approve]').onclick;dialog.querySelector('[data-deny]').onclick();assert.equal(await first,false);
 let settled=false;const second=ask(request).then(value=>{settled=true;return value;});oldApprove();await Promise.resolve();assert.equal(settled,false);assert.equal(dialog.open,true);assert.equal(typeof dialog.querySelector('[data-approve]').onclick,'function');dialog.querySelector('[data-approve]').onclick();assert.equal(await second,true);
});
test('Stop rejects pending approval and permits a later task to request review',async()=>{
 const dialog=dialogFixture(),ask=createApprovalPrompt(dialog),controller=new AbortController();const pending=ask({title:'Delete'},controller.signal);controller.abort();await assert.rejects(pending,/abort/i);assert.equal(dialog.open,false);const next=ask({title:'New action'});dialog.querySelector('[data-deny]').onclick();assert.equal(await next,false);
});
