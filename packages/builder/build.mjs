import {browserNotices} from './browser-notices.mjs';
import {build} from 'esbuild';
import path from 'node:path';
import fs from 'node:fs/promises';
import {registryFetch} from './src/registry-fetch.js';
const catalog=JSON.parse(await fs.readFile('templates.json','utf8')),locks=JSON.parse(await fs.readFile('template-locks.json','utf8'));
await fs.writeFile('src/template-catalog.mjs','export const catalog='+JSON.stringify(catalog)+';\nexport const locks='+JSON.stringify(locks)+';\n');
const bundled=await build({metafile:true,entryPoints:['src/app.js'],bundle:true,format:'esm',platform:'browser',target:'chrome120',outfile:'../../site/builder/app.js',plugins:[{name:'guest-source',setup(b){b.onResolve({filter:/\?raw$/},a=>({path:path.resolve(a.resolveDir,a.path.replace(/\?raw$/,'')),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async a=>({contents:await (await import('node:fs/promises')).readFile(a.path,'utf8'),loader:'text'}));}}]});
const notices=await browserNotices(bundled.metafile,'../../site/builder/THIRD_PARTY_NOTICES.txt');await fs.writeFile('browser-notices.json',JSON.stringify(notices,null,2)+'\n');


// The dev test page keeps its scripts inline under its CSP and shares the same copy helper.
const clipboard=await fs.readFile('src/clipboard.js','utf8');
const testPage=await fs.readFile('dev/live-test.template.html','utf8');
await fs.writeFile('dev/live-test.html',testPage.replace('/* SIGN_IN_CLIPBOARD_HELPER */',()=>clipboard.replace(/^export /gm,'')));
for(const name of ['sessions','agent','machine','transfer','ws-client','machine-core','machine-host','machine-worker','preview','builder','scheduler','orchestrator']){
 let source=await fs.readFile('../../internal/site/'+name+'.js','utf8');
 if(name==='agent')source=source.replace('const SYNC_WAIT_MS = 10000;', 'const SYNC_WAIT_MS = 120000;');
 if(name==='machine-core'){
  const guestFetchPattern=/function guestFetch\([^)]*\) \{[\s\S]*?\n  \}/;
  if(!guestFetchPattern.test(source))throw Error('Cannot apply the Builder guest network restriction to this runtime');
  source=source.replace(guestFetchPattern,registryFetch.toString().replace('function registryFetch','function guestFetch'));
 }
 await fs.writeFile('../../site/builder/'+name+'.js',source);
}
