import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseGuestOutput,PROGRESS_PREFIX,formatElapsed} from '../src/progress.js';
const request={id:'a',projectId:'p',vmGeneration:1};
test('stream records tolerate partial output and reject unrelated VM/task events',()=>{
 const event={...request,stage:'compiling',message:'Compiling'};
 const unrelated={...event,id:'old'};
 const first=PROGRESS_PREFIX+JSON.stringify(event)+'\n'+PROGRESS_PREFIX+JSON.stringify(unrelated)+'\n';
 assert.equal(parseGuestOutput(first+'{"ok":tr',request).events.length,1);
 assert.equal(parseGuestOutput(first+'{"ok":tr',request).response,undefined);
 const final=parseGuestOutput(first+JSON.stringify({...request,ok:true,result:{html:'<p>ok</p>'}}),request,true);
 assert.equal(final.response.result.html,'<p>ok</p>');assert.deepEqual(final.events,[event]);
 assert.equal(parseGuestOutput(PROGRESS_PREFIX+'broken\n',request).events.length,0);
 assert.equal(formatElapsed(124000),'2m 04s');
});
