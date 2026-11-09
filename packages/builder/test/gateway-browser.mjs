// Real settings UI with intercepted gateway responses; no provider/VM execution.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage(),invitation='fixture-invitation-token-32-characters',key='fixture-provider-key-123456';let usage={requests:3,tokens:120,estimatedCostUsd:0.004,accountingComplete:true,limits:{maxRequests:100,maxCostUsd:2},metering:'catalog-estimate'},auth;
 const app=await fs.readFile(new URL('../../../site/builder/app.js',import.meta.url),'utf8');await page.route('**/builder/app.js',r=>r.fulfill({contentType:'text/javascript',body:app+'\nwindow.testUsage=refreshUsage;'}));
 await page.route('**/builder-api/**',async route=>{const name=new URL(route.request().url()).pathname.split('/').at(-1);let response={};
 if(name==='status')response={requiresAccessToken:true};
 if(name==='connect'){auth=route.request().headers().authorization;response={model:{id:'fixture',api:'openai-responses',provider:'openai',name:'fixture',baseUrl:'https://unused.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000}};}
 if(name==='usage')response=usage;
 await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
 });
 await page.goto(process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/');await page.waitForFunction(()=>document.getElementById('status').textContent!=='Loading Builder…');await page.locator('#settings').evaluate(el=>el.open=true);await page.locator('#gateway-token').waitFor({state:'visible'});
 await page.locator('#gateway-token').fill(invitation);await page.locator('#key').fill(key);await page.locator('#connect').click();await page.waitForFunction(()=>document.getElementById('stop').disabled);
 assert.equal(auth,'Bearer '+invitation);assert.equal(await page.locator('#gateway-token').inputValue(),'');assert.equal(await page.locator('#key').inputValue(),'');
 await page.evaluate(()=>testUsage());assert.match(await page.locator('#ai-usage').textContent(),/3 \/ 100 AI requests.*120 tokens.*\$0.004/);
 usage={...usage,metering:'request-count-only'};await page.evaluate(()=>testUsage());assert.match(await page.locator('#ai-usage').textContent(),/ChatGPT plan allowance/);assert(!(await page.locator('#ai-usage').textContent()).includes('$'));
 const storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));assert(!storage.includes(invitation));assert(!storage.includes(key));
 console.log('PASS invitation settings, authorization header, cleared credential fields, API estimates and separate subscription usage');
}finally{await browser.close();}
