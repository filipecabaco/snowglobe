import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLiveTestServer} from '../dev/live-test.mjs';
test('live test requests codes on demand, rejects cross-origin actions and hides private browser control',async t=>{
 let starts=0,cancels=0;
 const fake={state:{phase:'idle',message:'Ready',checks:[],endpoint:'PRIVATE_BROWSER_ENDPOINT',cookie:'PRIVATE_COOKIE'},async start(){starts++;this.state={...this.state,phase:'awaiting',message:'Sign in',code:'CODE-'+starts,verificationUrl:'https://auth.openai.com/codex/device'};},async cancel(){cancels++;this.state={...this.state,phase:'cancelled',message:'Disconnected'};}};
 const server=createLiveTestServer({test:fake,origin:'https://dev.invalid'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port;
 const html=await fetch(url+'/builder-test/').then(r=>r.text());assert(html.includes('Get a fresh sign-in code'));assert.equal(starts,0);
 const status=await fetch(url+'/builder-test/api/status').then(r=>r.text());assert(!status.includes('PRIVATE'));assert.equal(starts,0);
 const post=(path,origin='https://dev.invalid')=>fetch(url+'/builder-test/api/'+path,{method:'POST',headers:{Origin:origin}});
 assert.equal((await post('start','https://other.invalid')).status,403);assert.equal((await post('start','null')).status,403);assert.equal(starts,0);
 assert.equal((await (await post('start')).json()).code,'CODE-1');assert.equal((await (await post('start')).json()).code,'CODE-2');
 fake.state.phase='expired';assert.equal((await fetch(url+'/builder-test/api/status').then(r=>r.json())).code,undefined,'an ended session cannot advertise its old code');
 const cancelled=await (await post('cancel')).json();assert.equal(cancelled.phase,'cancelled');assert.equal(cancelled.code,undefined);assert.equal(cancels,1);
});
