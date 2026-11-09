import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {embedPreviewAssets} from '../src/preview-assets.mjs';
test('built media becomes bounded data URLs in markup, bundle strings and CSS without host requests',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'builder-media-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'assets'));await fs.writeFile(path.join(dir,'assets/icon.png'),Buffer.from([0,255]));
 const html=await embedPreviewAssets('<img src="/assets/icon.png"><style>x{background:url(./assets/icon.png)}</style><script>const src="assets/icon.png";</script>',dir);assert.equal((html.match(/data:image\/png;base64,AP8=/g)||[]).length,3);
 const css=await embedPreviewAssets('a{background:url(icon.png)}b{background:url(../assets/icon.png)}',dir,{referenceFile:'assets/style.css'});assert.equal((css.match(/data:image\/png;base64,AP8=/g)||[]).length,2);
 await fs.symlink('/etc/passwd',path.join(dir,'escape'));await assert.rejects(embedPreviewAssets('',dir),/Symlink/);await fs.rm(path.join(dir,'escape'));await fs.writeFile(path.join(dir,'huge.png'),Buffer.alloc(256*1024+1));await assert.rejects(embedPreviewAssets('',dir),/asset limits/);
});
