const {test}=require('node:test'),assert=require('node:assert/strict'),{Core}=require('./machine-core.js');
const core=()=>new Core({config:{warm:'https://files.test/warm.pack'},agent:null,blobRetryDelays:[]});
test('progressing image download can outlive its inactivity deadline',async()=>{
 const c=core();let n=0;c.fetch=async()=>new Response(new ReadableStream({async pull(controller){await new Promise(r=>setTimeout(r,20));if(n===5)controller.close();else controller.enqueue(Uint8Array.of(++n));}}));
 const started=Date.now();assert.deepEqual([...await c._fetchBytes('https://files.test/blob',60)],[1,2,3,4,5]);assert(Date.now()-started>60);
});
test('stalled response body is cancelled with a file-specific error',async()=>{
 const c=core();let cancelled=false;c.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(1));},cancel(){cancelled=true;}}));
 await assert.rejects(c._fetchBytes('https://files.test/stalled.bin',30),e=>e.name==='TimeoutError'&&e.message.includes('/stalled.bin'));await new Promise(r=>setImmediate(r));assert(cancelled);
});
test('background warming and required recovery share one download and do not refill a warmed VM',async()=>{
 const c=core(),index=Buffer.from(JSON.stringify([['file',0,3]])),header=Buffer.alloc(4);header.writeUInt32LE(index.length);const pack=Buffer.concat([header,index,Buffer.from([1,2,3])]);let downloads=0,provide=0,release;
 c.vm={stopped:false,has_blob:()=>false,provide_blob(){provide++;}};c.fetch=async()=>{downloads++;await new Promise(r=>release=r);return new Response(pack);};
 const background=c.warm(),required=c.warm({required:true});release();assert.deepEqual(await Promise.all([background,required]),[1,1]);assert.equal(downloads,1);assert.equal(provide,1);assert.equal(await c.warm({required:true}),0);assert.equal(downloads,1);
});
