import {test} from 'node:test';import assert from 'node:assert/strict';import {usageLabel} from '../src/usage.js';
test('usage distinguishes estimated API spend from Codex plan request counts',()=>{
 const base={requests:3,tokens:42,estimatedCostUsd:0.0123,limits:{maxRequests:100,maxCostUsd:2}};
 assert.match(usageLabel({...base,metering:'catalog-estimate'}),/estimated \$0.0123.*not a provider invoice/);
 const codex=usageLabel({...base,metering:'request-count-only'});assert.match(codex,/managed by Codex/);assert(!codex.includes('$'));
 assert.equal(usageLabel({...base,estimatedCostUsd:NaN}),'Usage unavailable');assert.equal(usageLabel(null),'Usage unavailable');
 const incomplete=usageLabel({...base,metering:'catalog-estimate',accountingComplete:false});assert.match(incomplete,/further requests are blocked/);assert(!incomplete.includes('$'));
});
test('user window allowance remains visible after session reconnect and rejects invalid dates',()=>{
 const usage={requests:0,limits:{maxRequests:100},metering:'request-count-only',userUsage:{requests:8,limits:{maxRequests:10},windowEndsAt:2000000000000,accountingComplete:false}};assert.match(usageLabel(usage),/User window: 8 \/ 10/);assert.match(usageLabel(usage),/blocked for this window/);assert.doesNotThrow(()=>usageLabel({...usage,userUsage:{...usage.userUsage,windowEndsAt:Number.MAX_SAFE_INTEGER}}));
});
