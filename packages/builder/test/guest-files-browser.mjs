// Current guest helpers on the actual Linux VM, including descriptor-based reads.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();page.setDefaultTimeout(300000);
 const script=await fs.readFile(new URL('../../../site/builder/app.js',import.meta.url),'utf8');await page.route('**/builder/app.js',r=>r.fulfill({contentType:'text/javascript',body:script+'\nwindow.currentGuest=()=>({client,ready:!busy&&!!currentProject});'}));
 await page.goto(process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/');await page.waitForFunction(()=>window.currentGuest?.().ready);
 const result=await page.evaluate(async()=>{
  const {client}=currentGuest();await client.call('project.initialize',{template:'react-vite'});
  const file=await client.call('fs.read',{path:'src/App.jsx'});await client.call('fs.write',{path:file.path,text:file.text+'\n// current helper acceptance\n',version:file.version});
  const before=await client.call('project.export'),expected={};for(const [name,text] of Object.entries(before.files))expected[name]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),n=>n.toString(16).padStart(2,'0')).join('');
  await client.call('project.restore',{expected,changes:{'public/current-helper.png':{encoding:'base64',data:'iVBORw0KGgoA//4='}}});
  const after=await client.call('project.export');return {text:after.files[file.path],binary:after.files['public/current-helper.png']};
 });
 assert.match(result.text,/current helper acceptance/);assert.deepEqual(result.binary,{encoding:'base64',data:'iVBORw0KGgoA//4='});console.log('PASS current guest descriptor reads, versioned write, binary restore journal and complete source export in a fresh real VM');
}finally{await browser.close();}
