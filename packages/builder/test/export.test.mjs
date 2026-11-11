import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {strFromU8,zipSync,unzipSync} from 'fflate';import {exportFiles} from '../src/export.js';
test('portable export inventories exact binary/text bytes and documents deployment without overwriting source',async()=>{
 const files=await exportFiles({format:'snowglobe-source-v2',template:'sveltekit-spa',files:{'README.md':'Project notes','public/icon.png':{encoding:'base64',data:'AP8='},'package-lock.json':'{}'}},{backend:true,exportedAt:'fixed'}),zip=unzipSync(zipSync(files)),manifest=JSON.parse(strFromU8(zip['snowglobe-export.json']));
 assert.equal(strFromU8(zip['README.md']),'Project notes');assert.deepEqual([...zip['public/icon.png']],[0,255]);assert.equal(manifest.exportedAt,'fixed');assert.equal(manifest.files.length,3);
 for(const entry of manifest.files){assert.equal(entry.bytes,zip[entry.path].length);assert.equal(entry.sha256,createHash('sha256').update(zip[entry.path]).digest('hex'));}
 const readme=strFromU8(zip['SNOWGLOBE-README.md']);for(const text of ['npm ci','npm run build','build/','hash routing','VITE_SUPABASE_ANON_KEY','never use a service-role key','not included'])assert(readme.includes(text));
 for(const name of ['.npmrc','x/.aws/credentials','../escape','/absolute','node_modules/key'])await assert.rejects(exportFiles({files:{[name]:'private'}}),/excluded path/);
 await assert.rejects(exportFiles({files:{'SNOWGLOBE-README.md':'user content'}}),/reserved export files/);
});
