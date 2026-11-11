import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,unzipSync} from 'fflate';
import {fileBytes,sourceFile} from '../src/source-files.js';
import {sourceVersions,sourceDiff,sourceChanges} from '../src/history.js';
import {dispatcher} from '../src/guest.mjs';
const control=await fs.mkdtemp(path.join(os.tmpdir(),'builder-binary-control-'));process.env.SNOWGLOBE_COMPILER_DIR=control;after(()=>fs.rm(control,{recursive:true,force:true}));
const request=(op,params={})=>({protocol:'snowglobe-builder-rpc-v1',id:'binary-test',projectId:'binary-project',vmGeneration:1,op,params});
test('binary assets survive ZIP export, version-checked restore and interrupted journal recovery',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'builder-binary-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const png=Uint8Array.from([137,80,78,71,13,10,26,10,0,255,254]),replacement=Uint8Array.from([0,255,9]);
 await fs.mkdir(path.join(root,'public'));await fs.writeFile(path.join(root,'public/icon.png'),png);await fs.writeFile(path.join(root,'hello.txt'),'héllo');await fs.writeFile(path.join(root,'bom.txt'),'\ufefftext');
 const call=dispatcher(root),before=(await call(request('project.export'))).result.files;
 assert.equal(before['hello.txt'],'héllo');assert.equal((await call(request('fs.read',{path:'bom.txt'}))).result.text,'\ufefftext');assert.deepEqual(fileBytes(before['public/icon.png']),png);
 const zip=unzipSync(zipSync(Object.fromEntries(Object.entries(before).map(([name,value])=>[name,fileBytes(value)]))));assert.deepEqual(zip['public/icon.png'],png);
 const target={...before,'public/icon.png':sourceFile(replacement)};
 assert.match(sourceDiff(before,target),/Binary file: 11 bytes/);assert.deepEqual(sourceChanges(before,structuredClone(before)),{});
 const expected=await sourceVersions(before);await call(request('project.restore',{expected,changes:sourceChanges(before,target)}));assert.deepEqual(new Uint8Array(await fs.readFile(path.join(root,'public/icon.png'))),replacement);
 await assert.rejects(call(request('project.restore',{expected,files:before})),/Conflict/);
 const journal=(await import('../src/compiler.mjs')).compilerPaths(root).revision+'.restore';await fs.writeFile(journal,JSON.stringify({root,before:{'public/icon.png':before['public/icon.png']}}));
 await call(request('fs.list'));assert.deepEqual(new Uint8Array(await fs.readFile(path.join(root,'public/icon.png'))),png);
});
test('source envelopes reject malformed or ambiguous encodings and preserve ordinary strings',()=>{
 for(const invalid of [{encoding:'hex',data:'ff'},{encoding:'base64',data:'%%%='},{encoding:'base64',data:'AB=='},{encoding:'base64',data:'AA==',extra:1}])assert.throws(()=>fileBytes(invalid));
 const bom=Uint8Array.from([239,187,191,65]);assert.deepEqual(fileBytes(sourceFile(bom)),bom);
 const text='{"encoding":"base64","data":"AA=="}';assert.equal(sourceFile(fileBytes(text)),text);
});
test('source byte limits reject oversized text and binary envelopes before restore',()=>{
 const maximum=256*1024,bytes=new Uint8Array(maximum).fill(255),encoded={encoding:'base64',data:Buffer.from(bytes).toString('base64')};assert.equal(fileBytes(encoded).length,maximum);assert.equal(fileBytes('a'.repeat(maximum)).length,maximum);assert.throws(()=>fileBytes('a'.repeat(maximum+1)),/limits/);assert.throws(()=>fileBytes('é'.repeat(maximum)),/limits/);assert.throws(()=>fileBytes({encoding:'base64',data:'A'.repeat(400000)}),/encoding/);
});
