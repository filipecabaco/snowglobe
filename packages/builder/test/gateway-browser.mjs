// Actual settings UI with admission and provider responses intercepted; no VM boot.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage(),invitation='fixture-invitation-token-32-characters',key='fixture-provider-key-123456';let usage={requests:3,tokens:120,estimatedCostUsd:0.004,accountingComplete:true,limits:{maxRequests:100,maxCostUsd:2},metering:'catalog-estimate'},auth,unlocked=false,completed=false;
 const model={id:'fixture',api:'openai-responses',provider:'openai',name:'fixture',baseUrl:'https://unused.invalid',reasoning:false,thinkingLevels:['off'],input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const providers=[{id:'openai',name:'OpenAI',chat:true,methods:[{type:'api_key',label:'OpenAI API key'}]}],connections=()=>completed?[{id:'openai:api_key',provider:'openai',name:'OpenAI',type:'api_key',models:[model]}]:[];
 const login=()=>({id:'login',connectionId:'openai:api_key',state:completed?'completed':'pending',events:[],prompt:completed?null:{id:'prompt',type:'secret',message:'Enter API key'}});
 const app=await fs.readFile(new URL('../../../site/builder/app.js',import.meta.url),'utf8');await page.route('**/builder/app.js',r=>r.fulfill({contentType:'text/javascript',body:app+'\nwindow.testUsage=refreshUsage;'}));
 await page.route('**/builder-api/**',async route=>{
  const pathname=new URL(route.request().url()).pathname.slice('/builder-api'.length),body=route.request().postDataJSON();let response={},status=200;
  if(pathname==='/status')response={requiresAccessToken:true,providersAvailable:true};
  if(pathname==='/providers/catalog')response={providers};
  if(pathname==='/providers/status'){if(!unlocked){status=401;response={error:'Unlock first'};}else response={providers,connections:connections()};}
  if(pathname==='/providers/open'){auth=route.request().headers().authorization;unlocked=true;response={providers,connections:connections()};}
  if(pathname==='/providers/login/start')response=login();
  if(pathname==='/providers/login/respond'){assert.equal(body.value,key);completed=true;response={ok:true};}
  if(pathname==='/providers/login/status')response={login:login()};
  if(pathname==='/providers/select')response={model,connectionId:'openai:api_key',thinking:'off'};
  if(pathname==='/providers/usage')response=usage;
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(response)});
 });
 await page.goto(process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/');await page.waitForFunction(()=>document.getElementById('provider').options.length===1&&document.getElementById('stop').disabled);await page.locator('#settings').evaluate(el=>el.open=true);
 await page.locator('#gateway-token').fill(invitation);await page.locator('#provider-method').selectOption('api_key');await page.locator('#connect').click();await page.locator('#provider-response').waitFor({state:'visible'});await page.locator('#key').fill(key);await page.locator('#provider-answer').click();await page.waitForFunction(()=>document.getElementById('ai-indicator').textContent.includes('fixture')&&document.getElementById('stop').disabled);
 assert.equal(auth,'Bearer '+invitation);assert.equal(await page.locator('#gateway-token').inputValue(),'');assert.equal(await page.locator('#key').inputValue(),'');
 await page.evaluate(()=>testUsage());assert.match(await page.locator('#ai-usage').textContent(),/3 \/ 100 AI requests.*120 tokens.*\$0.004/);
 usage={...usage,metering:'request-count-only',engine:'pi'};await page.evaluate(()=>testUsage());assert.match(await page.locator('#ai-usage').textContent(),/provider account usage/);assert(!(await page.locator('#ai-usage').textContent()).includes('$'));
 const storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));assert(!storage.includes(invitation));assert(!storage.includes(key));
 console.log('PASS invitation admission, authorization header, cleared credential fields, API estimates and separate provider account usage');
}finally{await browser.close();}
