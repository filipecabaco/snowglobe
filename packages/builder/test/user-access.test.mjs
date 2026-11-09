import {test} from 'node:test';import assert from 'node:assert/strict';import {userAccess} from '../user-access.mjs';import {createGateway} from '../gateway.mjs';
const alice='fixture-alice-access-token-32-characters',bob='fixture-bob-access-token-32-characters';
test('individual access tokens map to distinct identities and invalid configuration fails without secret text',()=>{
 const access=userAccess({alice,bob});assert.equal(access.authenticate(alice),'alice');assert.equal(access.authenticate(bob),'bob');assert.equal(access.authenticate('unknown'),null);assert.equal(userAccess(undefined),null);
 for(const config of [{},[],{alice:'short'},{alice,bob:alice},'{PRIVATE_TOKEN'])assert.throws(()=>userAccess(config),error=>!error.message.includes('PRIVATE_TOKEN'));
});
test('production individual authentication gates both modes and replacing the browser identity revokes its old session',async t=>{
 const server=createGateway({origin:'https://test.local',development:false,userTokens:{alice,bob}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const post=(route,token='',cookie='')=>fetch(base+route,{method:'POST',headers:{Origin:'https://test.local',Authorization:token?'Bearer '+token:'',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({key:'fixture-provider-api-key-123456'})});
 for(const route of ['/connect','/codex/connect'])assert.equal((await post(route,'unknown')).status,401);
 const first=await post('/connect',alice),firstCookie=first.headers.get('set-cookie').split(';')[0];assert.equal(first.status,200);const second=await post('/connect',bob,firstCookie),secondCookie=second.headers.get('set-cookie').split(';')[0];assert.equal(second.status,200);assert.notEqual(firstCookie,secondCookie);assert.equal((await post('/usage','',firstCookie)).status,401);assert.equal((await post('/usage','',secondCookie)).status,200);
 const status=await (await post('/status')).text();assert.equal(JSON.parse(status).accessMode,'individual');assert(!status.includes(alice));assert(!status.includes(bob));
});
test('one user cannot exhaust gateway sessions and can rotate its existing session at capacity',async t=>{
 const server=createGateway({origin:'https://test.local',development:false,userTokens:{alice,bob},userMaxSessions:1});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const connect=(token,cookie='',route='/connect')=>fetch(base+route,{method:'POST',headers:{Origin:'https://test.local',Authorization:'Bearer '+token,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({key:'fixture-provider-key-123456'})}),first=await connect(alice),cookie=first.headers.get('set-cookie').split(';')[0];assert.equal((await connect(alice)).status,429);assert.equal((await connect(alice,'','/codex/connect')).status,429);assert.equal((await connect(bob)).status,200);assert.equal((await connect(alice,cookie)).status,200);
});
