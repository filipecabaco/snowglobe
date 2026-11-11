// Real device-code creation/renewal/cancellation, with no account approval or inference.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();page.setDefaultTimeout(30000);
 await page.goto(process.env.BUILDER_TEST_URL||'https://aspire.tailb03e.ts.net:18445/builder-test/');
 await page.getByRole('heading',{name:'Test a complete build'}).waitFor();
 assert.equal(await page.locator('#signin').isVisible(),false);
 const start=page.getByRole('button',{name:'Get a fresh sign-in code'});
  await start.click();await page.locator('#signin').waitFor();const first=await page.locator('#code').inputValue();assert(first.trim());assert.equal(await page.locator('#link').getAttribute('href'),'https://auth.openai.com/codex/device');
  await start.click();await page.waitForFunction(old=>document.getElementById('code').value.trim()&&document.getElementById('code').value!==old,first);
 await page.getByRole('button',{name:'Cancel test and disconnect'}).click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('cancelled and disconnected'));
  assert.equal(await page.locator('#signin').isVisible(),false);assert.equal(await page.locator('#code').inputValue(),'');assert.equal(await page.locator('#link').getAttribute('href'),null);
 console.log('PASS native device codes are requested on click, renewed on demand, and cleared by cancel without running inference');
}finally{await browser.close();}
