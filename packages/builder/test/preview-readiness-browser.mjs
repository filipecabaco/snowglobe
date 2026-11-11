import {chromium} from '../../../bench/node_modules/playwright/index.mjs';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {openFixture} from './browser-fixture.mjs';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{const page=await browser.newPage();await openFixture(page);const source=await fs.readFile(new URL('../src/preview.js',import.meta.url),'utf8');
const result=await page.evaluate(async source=>{
 const api=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'}))),container=document.createElement('div');container.style.cssText='position:relative;width:500px;height:400px';document.body.append(container);
 const created=[],revoked=[],create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);created.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);revoke(url);};
 try{
  await api.mountPreview({container,html:'<main>Prior working preview</main>'});const first=container.querySelector('iframe').src;let error;
  try{await api.mountPreview({container,html:'<div><script>window.started=true;<\/script></div>',timeoutMs:300});}catch(e){error=e.message;}
  const candidate=created.at(-1),retained=container.querySelector('iframe').src===first,discarded=revoked.includes(candidate),priorLive=!revoked.includes(first);
  await api.mountPreview({container,html:'<main>Replacement preview</main>'});return {error,retained,discarded,priorLive,priorRevokedOnReplacement:revoked.includes(first)};
 }finally{container.querySelector('iframe')?._disposePreview?.();URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
},source);
assert.match(result.error,/did not report rendered content/);assert.equal(result.retained,true);assert.equal(result.discarded,true);assert.equal(result.priorLive,true);assert.equal(result.priorRevokedOnReplacement,true);console.log('PASS script-only wrapper rejection, last-good retention and blob URL cleanup');
}finally{await browser.close();}
