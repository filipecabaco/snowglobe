// Mock only the folder picker. npm, source transfer, compilation and preview use the real VM.
import {chromium} from './node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';

const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page=await browser.newPage();
  await page.addInitScript(()=>{
    window.fixture={
      'package.json':JSON.stringify({scripts:{build:'node build.cjs'},dependencies:{ms:'2.1.3'}}),
      'build.cjs':`const fs=require('node:fs');const ms=require('ms');fs.mkdirSync('dist');fs.writeFileSync('dist/index.html','<h1>First build: '+ms('2s')+'</h1>');`,
    };
    window.showDirectoryPicker=async()=>({name:'cache-check',kind:'directory',async *entries(){
      for(const [name,source] of Object.entries(window.fixture))yield [name,{kind:'file',getFile:async()=>new File([source],name)}];
    }});
  });
  await page.goto(process.env.APPHOST_URL || 'http://127.0.0.1:18456/apphost/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.getElementById('choose-folder').disabled);
  await page.locator('#choose-folder').click();
  await page.waitForFunction(()=>!document.getElementById('choose-folder').disabled);
  await page.locator('#environment').selectOption('npm');
  async function build(){
    await page.getByRole('button',{name:'Build & deploy'}).click();
    await page.waitForFunction(()=>document.getElementById('log-state').textContent!=='BUILDING',null,{timeout:180000});
    const log=await page.locator('#build-log').textContent();
    console.log(log);
    assert.equal(await page.locator('#log-state').textContent(),'DEPLOYED');
    return log;
  }
  const first=await build();
  assert.match(first,/\$ npm install/);
  const app=page.frameLocator('#app-frame');
  await app.getByRole('heading',{name:'First build: 2000'}).waitFor({timeout:30000});
  await page.getByRole('tab',{name:'Build',exact:true}).click();
  await page.evaluate(()=>window.fixture['build.cjs']=window.fixture['build.cjs'].replace('First build:','Source edit:'));
  const second=await build();
  assert.match(second,/Reusing installed dependencies/);
  assert.doesNotMatch(second,/\$ npm (?:install|ci)\b/);
  await app.getByRole('heading',{name:'Source edit: 2000'}).waitFor({timeout:30000});
  console.log('PASS source-only rebuild skips installation and resolves the reused package in the real VM');

  await page.getByRole('tab',{name:'Build',exact:true}).click();
  await page.evaluate(()=>window.fixture['build.cjs']='require("ms");throw Error("Intentional build failure")');
  await page.getByRole('button',{name:'Build & deploy'}).click();
  await page.waitForFunction(()=>document.getElementById('log-state').textContent==='FAILED',null,{timeout:60000});
  await page.evaluate(()=>window.fixture['build.cjs']=`const fs=require('node:fs');const ms=require('ms');fs.mkdirSync('dist');fs.writeFileSync('dist/index.html','<h1>Recovered: '+ms('2s')+'</h1>');`);
  const recovered=await build();
  assert.match(recovered,/Reusing installed dependencies/);
  assert.doesNotMatch(recovered,/\$ npm (?:install|ci)\b/);
  await app.getByRole('heading',{name:'Recovered: 2000'}).waitFor({timeout:30000});
  console.log('PASS failed compilation preserves the installed dependency tree');
} finally {await browser.close();}
