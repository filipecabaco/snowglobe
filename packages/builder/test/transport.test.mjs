import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const A=require('../../../site/builder/agent.js');
test('Builder transport tolerates delayed shell acknowledgements and still bounds a stalled upload',()=>{
 const job=new A.Job({id:'aaaaaaaaaaaaaaaa',nonce:'bbbbbbbbbbbbbbbb',ack:'cccccccccccccccc',command:'echo hello',timeoutS:300,now:0,window:1});
 job.tick(15000);assert.equal(job.state,'running');
 const lines=job.feed('SGSYNC_'+job.syncTok+'_42\n',15000);assert.equal(lines.length,1);
 job.tick(30000);assert.equal(job.state,'running');
 const next=job.feed('SGACK_'+job.ack+'_0_0_42\n',30000);assert.equal(next.length,1);
 job.tick(150001);assert.equal(job.state,'failed');assert.match(job.error,/shell stopped answering/);
});
