import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {browserNotices} from '../browser-notices.mjs';
test('missing Pi notices use the pinned upstream license only for matching releases and declarations',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'builder-notices-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const packageRoot=path.join(root,'node_modules/@earendil-works/pi-ai');await fs.mkdir(packageRoot,{recursive:true});
 const output=path.join(root,'NOTICES.txt'),meta={outputs:{'app.js':{inputs:{[path.join(packageRoot,'dist/index.js')]:{bytesInOutput:50}}}}};
 const pkg={name:'@earendil-works/pi-ai',version:'1.5.0',license:'MIT'};
 await fs.writeFile(path.join(packageRoot,'package.json'),JSON.stringify(pkg));
 const known=await browserNotices(meta,output),text=await fs.readFile(output,'utf8');assert.deepEqual(known.issues,[]);assert(text.includes('Copyright (c) 2025 Mario Zechner'));assert(text.includes('/f9a26365568127461c47a07a37dcb42c140a3ac5/LICENSE'));
 for(const mismatch of [{version:'1.5.1'},{license:'Apache-2.0'}]){await fs.writeFile(path.join(packageRoot,'package.json'),JSON.stringify({...pkg,...mismatch}));const unknown=await browserNotices(meta,output);assert.equal(unknown.issues.length,1);assert((await fs.readFile(output,'utf8')).includes('NOTICE REVIEW REQUIRED'));}
 await fs.writeFile(path.join(packageRoot,'LICENSE'),'Installed package license');const installed=await browserNotices(meta,output);assert.deepEqual(installed.issues,[]);assert((await fs.readFile(output,'utf8')).includes('Installed package license'));assert(!(await fs.readFile(output,'utf8')).includes('Mario Zechner'));
});
