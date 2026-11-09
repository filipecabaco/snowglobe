// Login UI regression only: no model requests, real credentials, or VM startup.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/builder-api/codex/connect',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({connected:false,verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'})}));
 await page.route('**/builder-api/codex/status',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({connected:true,engine:'codex',account:{email:'test@example.invalid',planType:'plus'},models:[{id:'test-model',name:'Test model',isDefault:true}]})}));
 await page.goto(process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/');
 await page.waitForFunction(()=>document.getElementById('status').textContent!=='Loading Builder…');
 await page.getByText('AI settings',{exact:true}).click();await page.getByRole('button',{name:'Continue with ChatGPT'}).click();
 await page.getByText('TEST-CODE',{exact:true}).waitFor();assert.equal(await page.locator('#codex-link').getAttribute('href'),'https://auth.openai.com/codex/device');
 await page.getByRole('button',{name:'Check connection'}).click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Codex connected'));
 assert.equal(await page.locator('#settings').evaluate(el=>el.open),false);
 assert.equal(await page.locator('#codex-model').inputValue(),'test-model');
 await page.locator('#prompt').fill('Build a local poll');
 await page.getByRole('button',{name:'Build my app'}).click({trial:true,timeout:3000});
 assert.deepEqual(errors,[]);console.log('PASS ChatGPT device-code approval closes settings and leaves Build my app clickable');
}finally{await browser.close();}
