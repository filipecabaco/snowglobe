import {test} from 'node:test';
import assert from 'node:assert/strict';
import {admissionLimiter} from '../rate-limit.mjs';
import {createGateway} from '../gateway.mjs';
test('connection admission bounds clients and attempts and releases expired windows',()=>{
 let time=0;const admit=admissionLimiter({limit:2,maxClients:2,windowMs:100,now:()=>time});
 assert(admit('a'));assert(admit('a'));assert(!admit('a'));assert(admit('b'));assert(!admit('c'));
 time=100;assert(admit('c'));assert(admit('a'));
});
test('gateway limits invalid credential attempts before creating sessions',async t=>{
 const server=createGateway({origin:'http://limit.test'});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await server.dispose();await new Promise(r=>server.close(r));});
 const url='http://127.0.0.1:'+server.address().port+'/connect';
 for(let i=0;i<10;i++){const r=await fetch(url,{method:'POST',headers:{Origin:'http://limit.test','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,400);await r.text();}
 const denied=await fetch(url,{method:'POST',headers:{Origin:'http://limit.test'},body:'{}'});
 assert.equal(denied.status,429);assert.equal(denied.headers.get('Retry-After'),'60');assert.equal(denied.headers.get('set-cookie'),null);
});
