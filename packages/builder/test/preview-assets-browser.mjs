import {chromium,webkit} from '../../../bench/node_modules/playwright/index.mjs';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {embedPreviewAssets} from '../src/preview-assets.mjs';import {openFixture} from './browser-fixture.mjs';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'builder-media-browser-'));
try{
 await fs.writeFile(path.join(directory,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64'));
 const html=await embedPreviewAssets('<main><img alt="Exported asset" src="/pixel.png"></main>',directory),source=await fs.readFile(new URL('../src/preview.js',import.meta.url),'utf8');
 for(const [name,type,options] of [['Chromium',chromium,{args:['--no-sandbox']}],['WebKit',webkit,process.env.BUILDER_WEBKIT_BIN?{executablePath:process.env.BUILDER_WEBKIT_BIN}:{}]]){
  const browser=await type.launch({headless:true,...options});try{const page=await browser.newPage();const fixture=await openFixture(page);await page.evaluate(async({source,html})=>{const api=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'}))),container=document.createElement('div');document.body.append(container);await api.mountPreview({container,html});},{source,html});const frame=page.frames().find(f=>f!==page.mainFrame());await frame.waitForFunction(()=>{const image=document.querySelector('img');return image.complete&&image.naturalWidth===1;});assert.deepEqual(fixture.attempts,[]);console.log('PASS',name,'binary asset renders in opaque preview without project HTTP requests');}finally{await browser.close();}
 }
}finally{await fs.rm(directory,{recursive:true,force:true});}
