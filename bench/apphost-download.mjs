// Real VM regression: an HTTP 200 containing a truncated npm tarball must be retried
// before extraction, then a source-only rebuild must reuse the completed installation.
import {chromium} from './node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';

const metadata=await (await fetch('https://registry.npmjs.org/ms/2.1.3')).json();
const pkg={name:'download-recovery',private:true,scripts:{build:'node build.cjs'},dependencies:{ms:'2.1.3'}};
const lock={name:pkg.name,lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,dependencies:pkg.dependencies},'node_modules/ms':{version:'2.1.3',resolved:'http://127.0.0.1:4874/ms/-/ms-2.1.3.tgz',integrity:metadata.dist.integrity}}};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const context=await browser.newContext();let downloads=0;
  await context.route('https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',async route=>{
    downloads++;
    if(downloads!==1){await route.continue();return;}
    const response=await route.fetch(),body=(await response.body()).subarray(0,24);
    await route.fulfill({status:200,headers:{'content-type':'application/octet-stream','content-length':String(body.length),'access-control-allow-origin':'*'},body});
  });
  const page=await context.newPage();
  await page.addInitScript(({pkg,lock})=>{
    window.fixture={'package.json':JSON.stringify(pkg),'package-lock.json':JSON.stringify(lock),'build.cjs':`const fs=require('node:fs');const ms=require('ms');fs.mkdirSync('dist');fs.writeFileSync('dist/index.html','<h1>Recovered download: '+ms('2s')+'</h1>');`};
    window.showDirectoryPicker=async()=>({name:'download-recovery',kind:'directory',async *entries(){
      for(const [name,source] of Object.entries(window.fixture))yield [name,{kind:'file',getFile:async()=>new File([source],name)}];
    }});
  },{pkg,lock});
  await page.goto(process.env.APPHOST_URL||'http://127.0.0.1:18456/apphost/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.getElementById('choose-folder').disabled);
  await page.locator('#choose-folder').click();
  await page.waitForFunction(()=>!document.getElementById('choose-folder').disabled);
  await page.locator('#environment').selectOption('npm');
  async function build(){
    await page.getByRole('button',{name:'Build & deploy'}).click();
    let last='';
    const progress=setInterval(async()=>{try{const text=await page.locator('#build-log').textContent();if(text!==last){console.log(text.slice(last.length));last=text;}}catch{}},10000);
    try {await page.waitForFunction(()=>document.getElementById('log-state').textContent!=='BUILDING',null,{timeout:300000});}
    finally {clearInterval(progress);}
    const log=await page.locator('#build-log').textContent();console.log(log.slice(last.length));
    assert.equal(await page.locator('#log-state').textContent(),'DEPLOYED');return log;
  }
  const first=await build();
  assert.match(first,/Retrying incomplete package download \(2\/3\)/);
  assert.doesNotMatch(first,/npm warn.*(?:corrupted|unexpected end)/);
  assert.equal(downloads,2);
  const app=page.frameLocator('#app-frame');
  await app.getByRole('heading',{name:'Recovered download: 2000'}).waitFor({timeout:30000});
  console.log('PASS truncated locked-package download is rejected and retried in the real VM');
  await page.getByRole('tab',{name:'Build',exact:true}).click();
  await page.evaluate(()=>window.fixture['build.cjs']=window.fixture['build.cjs'].replace('Recovered download:','Cached rebuild:'));
  const second=await build();
  assert.match(second,/Reusing installed dependencies/);assert.doesNotMatch(second,/\$ npm (?:install|ci)\b/);
  await app.getByRole('heading',{name:'Cached rebuild: 2000'}).waitFor({timeout:30000});
  assert.equal(downloads,2);
  console.log('PASS cached rebuild performs no package downloads');
} finally {await browser.close();}
