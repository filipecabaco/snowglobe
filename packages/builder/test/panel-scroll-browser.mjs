// Real Builder markup/layout: wheel and keyboard access to the entire aside.
import {chromium,webkit} from '../../../bench/node_modules/playwright/index.mjs';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const html=(await fs.readFile(new URL('../../../site/builder/index.html',import.meta.url),'utf8')).replace(/<script\b[\s\S]*?<\/script>/gi,''),css=await fs.readFile(new URL('../../../site/builder/style.css',import.meta.url),'utf8');
for(const [name,engine,executablePath]of [['Chromium',chromium,undefined],['WebKit',webkit,process.env.BUILDER_WEBKIT_BIN]]){
 const browser=await engine.launch({headless:true,...(executablePath?{executablePath}:{}),...(engine===chromium?{args:['--no-sandbox']}:{})});
 try{for(const viewport of [{width:1440,height:900},{width:1100,height:650},{width:390,height:844}]){
  const page=await browser.newPage({viewport});await page.route('https://builder.test/**',route=>route.fulfill({contentType:route.request().url().endsWith('.css')?'text/css':'text/html',body:route.request().url().endsWith('.css')?css:html}));await page.goto('https://builder.test/builder/');
  await page.evaluate(()=>{const messages=document.getElementById('messages');for(let i=0;i<30;i++){const p=document.createElement('p');p.className='assistant';p.textContent='A longer conversation with project details and build results. '.repeat(8);messages.append(p);}for(const id of ['connection-guide','work-progress'])document.getElementById(id).hidden=false;for(const id of ['skills-panel','extensions-panel','history-panel','vm-backups','browser-support'])document.getElementById(id).open=true;});
  const aside=page.locator('aside');await aside.scrollIntoViewIfNeeded();
  assert(await aside.evaluate(el=>el.scrollHeight>el.clientHeight+500));assert.equal(await page.locator('#messages').evaluate(el=>getComputedStyle(el).overflowY),'visible');
  await aside.hover({position:{x:150,y:120}});await page.mouse.wheel(0,650);await page.waitForFunction(()=>document.querySelector('aside').scrollTop>200);
  // The composer and the controls below it remain reachable and focusable.
  await page.locator('#prompt').scrollIntoViewIfNeeded();await page.locator('#prompt').focus();await page.waitForFunction(()=>{const el=document.getElementById('prompt'),a=el.closest('aside').getBoundingClientRect(),r=el.getBoundingClientRect();return r.top>=a.top&&r.bottom<=a.bottom;});
  const end=page.locator('aside > .note').last();await end.scrollIntoViewIfNeeded();assert(await end.evaluate(el=>{const a=el.closest('aside').getBoundingClientRect(),r=el.getBoundingClientRect();return r.top>=a.top&&r.bottom<=a.bottom;}));
  await aside.hover({position:{x:150,y:120}});const bottom=await aside.evaluate(el=>el.scrollTop);await page.mouse.wheel(0,-1000);await page.waitForFunction(previous=>document.querySelector('aside').scrollTop<previous,bottom);
  await page.locator('.project details').evaluate(el=>el.open=true);await page.locator('#project-delete').scrollIntoViewIfNeeded();assert(await page.locator('.project details').evaluate(el=>getComputedStyle(el).overflowY==='auto'&&el.clientHeight<=innerHeight*.71));
  await page.close();console.log('PASS '+name+' '+viewport.width+'px entire Build together panel scrolls both ways; composer, backups, footer and project controls remain accessible');
 }}finally{await browser.close();}
}
