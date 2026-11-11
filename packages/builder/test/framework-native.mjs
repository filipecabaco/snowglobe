// Native dependency/build compatibility and lockfile generation. This is not VM proof.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {createProvisioner,validateLock} from '../src/provision.mjs';
const repository=new URL('../../../',import.meta.url).pathname,work=path.join(repository,'.local-dev/framework-native');await fs.mkdir(work,{recursive:true});
const provision=createProvisioner({base:path.join(repository,'examples/web/app'),cache:path.join(work,'cache'),registry:'https://registry.npmjs.org/',onProgress:(stage,message,extra)=>console.log(stage,message,extra?.log||'')});
const locks={};
for(const id of ['react-vite','vanilla-vite','svelte-vite']){
 const root=path.join(work,id);await fs.rm(root,{recursive:true,force:true});
 const selected=process.env.BUILDER_WRITE_LOCKS==='1'&&id!=='react-vite'?createProvisioner({base:path.join(repository,'examples/web/app'),cache:path.join(work,'clean-locks-'+id),registry:'https://registry.npmjs.org/',seedImage:false,templateLocks:{},onProgress:(stage,message)=>console.log(stage,message)}):provision;
 const result=await selected.initialize(root,id);assert.equal(result.id,id);console.log('INITIALIZED',id,result.cached);
 const vite=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')).href);await vite.build({root,base:'./',clearScreen:false,build:{reportCompressedSize:false,rolldownOptions:{output:{codeSplitting:false}}}});
 const html=await fs.readFile(path.join(root,'dist/index.html'),'utf8');assert(html.includes('script'));locks[id]=validateLock(JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8')));
 console.log('PASS native initialization, pinned install and production build:',id);
}
if(process.env.BUILDER_WRITE_LOCKS==='1'){await fs.writeFile(new URL('../template-locks.json',import.meta.url),JSON.stringify(locks,null,2)+'\n');console.log('WROTE validated framework lockfiles');}
