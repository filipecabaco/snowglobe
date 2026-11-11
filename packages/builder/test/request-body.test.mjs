import {test} from 'node:test';import assert from 'node:assert/strict';
import {readJsonBody} from '../request-body.mjs';
async function* chunks(values){yield* values;}
test('gateway JSON preserves multibyte prompts split across arbitrary network chunks',async()=>{
 const text=JSON.stringify({prompt:'Build 🌍 café 日本語'}),bytes=Buffer.from(text);
 const decoded=await readJsonBody(chunks([...bytes].map(byte=>Buffer.from([byte]))));
 assert.equal(decoded.prompt,'Build 🌍 café 日本語');
});
test('gateway JSON rejects invalid encoding, non-object input and byte-limit overflow',async()=>{
 for(const value of ['null','[]','123','"text"'])await assert.rejects(readJsonBody(chunks([Buffer.from(value)])),/object/);
 await assert.rejects(readJsonBody(chunks([Buffer.from([0xff])])));
 await assert.rejects(readJsonBody(chunks([Buffer.from('12345')] ),{maxBytes:4}),error=>error.status===413);
 assert.deepEqual(await readJsonBody(chunks([])),{});
});
