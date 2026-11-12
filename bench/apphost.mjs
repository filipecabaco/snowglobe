// The folder picker is a fixture; imports, builds, and previews use the real browser VM.
import {chromium} from './node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const apphostUrl=process.env.APPHOST_URL || 'http://127.0.0.1:18456/apphost/';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',error=>console.log('PAGE ERROR',error.message));
 await page.addInitScript(()=>{
   window.apphostFixture={'index.html':'<!doctype html><link rel="stylesheet" href="/style.css"><h1>Hosted from a local folder</h1><a href="/nested">Nested page</a><button id="count">Count: 0</button><script src="/app.js"></script>','style.css':'h1 { color: rgb(20, 90, 50); }','app.js':'console.warn("App Host fixture warning");let n=0; document.getElementById("count").onclick=()=>document.getElementById("count").textContent="Count: "+(++n);fetch("/data.json").then(r=>r.json()).then(data=>{const p=document.createElement("p");p.textContent=data.message;document.body.append(p);})','data.json':'{"message":"Data fetched from the hosted folder"}','nested/index.html':'<h1>A nested page</h1><a href="/">Home</a>'};
   window.showDirectoryPicker=async()=>({name:'existing-static-app',kind:'directory',async *entries(){for(const [path,source] of Object.entries(window.apphostFixture))yield [path,{kind:'file',async getFile(){return new File([source],path);}}];}});
 });
 await page.goto(apphostUrl,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>!document.getElementById('choose-folder').disabled,null,{timeout:20000});
 if(!process.argv.includes('--frameworks-only')) {
 await page.getByRole('button',{name:'Choose local folder'}).click();
 await page.waitForFunction(()=>!document.getElementById('deploy').disabled,null,{timeout:10000});
 assert.equal(await page.locator('#environment-name').textContent(),'Static site');
 await page.getByRole('button',{name:'Build & deploy'}).click();
 const progress=setInterval(async()=>{try{console.log(await page.locator('#app-status').textContent(),await page.locator('#build-activity').textContent());}catch{}},15000);
 try{await page.waitForFunction(()=>document.getElementById('log-state').textContent!=='BUILDING',null,{timeout:240000});}finally{clearInterval(progress);}
 console.log('BUILD LOG',await page.locator('#build-log').textContent());
 assert.equal(await page.locator('#log-state').textContent(),'DEPLOYED');
 const app=page.frameLocator('#app-frame');
 await app.getByRole('heading',{name:'Hosted from a local folder'}).waitFor({timeout:60000});
 await app.getByRole('button',{name:'Count: 0'}).click();
 assert.equal(await app.getByRole('button').textContent(),'Count: 1');
 assert.equal(await app.getByRole('heading').evaluate(el=>getComputedStyle(el).color),'rgb(20, 90, 50)');
 await app.getByText('Data fetched from the hosted folder').waitFor({timeout:30000});
 await page.waitForFunction(()=>document.getElementById('build-log').textContent.includes('[preview warn] App Host fixture warning'),null,{timeout:10000});
 await app.getByRole('link',{name:'Nested page'}).click();
 await app.getByRole('heading',{name:'A nested page'}).waitFor({timeout:30000});
 await app.getByRole('link',{name:'Home'}).click();
 await app.getByRole('heading',{name:'Hosted from a local folder'}).waitFor({timeout:30000});
 console.log('PASS real browser VM deployment, static assets, scripts, root-relative fetch, directory navigation, interactive preview');
 await page.getByRole('tab',{name:'Build',exact:true}).click();
 await page.evaluate(()=>window.apphostFixture['index.html']='<!doctype html><h1>Updated from local edits</h1>');
 await page.getByRole('button',{name:'Build & deploy'}).click();
 await page.waitForFunction(()=>document.getElementById('log-state').textContent!=='BUILDING',null,{timeout:120000});
 assert.equal(await page.locator('#log-state').textContent(),'DEPLOYED');
 await app.getByRole('heading',{name:'Updated from local edits'}).waitFor({timeout:30000});
 await page.getByRole('tab',{name:'Build',exact:true}).click();
 await page.evaluate(()=>{delete window.apphostFixture['index.html'];});
 await page.getByRole('button',{name:'Build & deploy'}).click();
 await page.waitForFunction(()=>document.getElementById('log-state').textContent!=='BUILDING',null,{timeout:120000});
 assert.equal(await page.locator('#log-state').textContent(),'FAILED');
 await page.getByRole('tab',{name:'Preview',exact:false}).click();
 await page.getByRole('button',{name:'Reload'}).click();
 await app.getByRole('heading',{name:'Updated from local edits'}).waitFor({timeout:30000});
 console.log('PASS rebuild reads local edits; failed build keeps the previous app live');
 const mobile=await browser.newPage({viewport:{width:390,height:844}});await mobile.goto(apphostUrl,{waitUntil:'domcontentloaded'});
 assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 console.log('PASS narrow layout has no horizontal overflow');

 }
 const appFrame=page.frameLocator('#app-frame');
 if(process.argv.includes('--npm') || process.argv.includes('--frameworks-only')) {
   async function share(files,id) {
     await page.getByRole('tab',{name:'Build',exact:true}).click();
     await page.evaluate(files=>{window.apphostFixture=files;},files);
     await page.locator('#environment').selectOption('auto');
     await page.locator('#choose-folder').click();
     if(id==='npm')await page.locator('#environment').selectOption('npm');
     const expected=id==='npm'?'Other npm frontend':id==='react'?'React + Vite':'Svelte + Vite';
     await page.waitForFunction(expected=>document.getElementById('environment-name').textContent===expected && !document.getElementById('choose-folder').disabled,expected,{timeout:10000});
     assert.equal(await page.locator('#environment-name').textContent(),expected);
   }
   async function build() {
     await page.getByRole('button',{name:'Build & deploy'}).click();
     const progress=setInterval(async()=>{try{console.log(await page.locator('#build-activity').textContent(),(await page.locator('#build-log').textContent()).slice(-200));}catch{}},20000);
     try{await page.waitForFunction(()=>document.getElementById('log-state').textContent!=='BUILDING',null,{timeout:900000});}finally{clearInterval(progress);}
     console.log(await page.locator('#build-log').textContent());
     assert.equal(await page.locator('#log-state').textContent(),'DEPLOYED');
   }
   if(!process.argv.includes('--frameworks-only')) {
   await share({'package.json':JSON.stringify({scripts:{build:'node build.cjs'},devDependencies:{ms:'2.1.3'}}),'build.cjs':`const fs=require('node:fs');const ms=require('ms');fs.mkdirSync('dist');fs.writeFileSync('dist/index.html','<h1>Installed npm dependency: '+ms('2s')+'</h1>');`},'npm');
   await build();
   await appFrame.getByRole('heading',{name:'Installed npm dependency: 2000'}).waitFor({timeout:30000});
   console.log('PASS npm dependency install and a custom static build');

   // Interrupt a real package script, then verify the previous deployment still serves.
   await page.getByRole('tab',{name:'Build',exact:true}).click();
   await page.evaluate(()=>window.apphostFixture['build.cjs']='setInterval(()=>console.log("waiting to cancel"),1000)');
   await page.getByRole('button',{name:'Build & deploy'}).click();
   await page.waitForFunction(()=>document.getElementById('build-log').textContent.includes('waiting to cancel'),null,{timeout:120000});
   await page.getByRole('button',{name:'Cancel build'}).click();
   await page.waitForFunction(()=>document.getElementById('log-state').textContent==='CANCELLED',null,{timeout:30000});
   await page.getByRole('tab',{name:'Preview',exact:false}).click();
   await page.getByRole('button',{name:'Reload'}).click();
   await appFrame.getByRole('heading',{name:'Installed npm dependency: 2000'}).waitFor({timeout:30000});
   console.log('PASS cancellation of a running build preserves the deployed app');

   }
   const json=async file=>JSON.parse(await fs.readFile(new URL(file,import.meta.url),'utf8'));
   const starter=await json('../examples/web/app/package.json');
   const react={'package.json':JSON.stringify({private:true,type:'module',scripts:{build:'vite build'},dependencies:{react:starter.dependencies.react,'react-dom':starter.dependencies['react-dom']},devDependencies:{vite:starter.devDependencies.vite}}),'index.html':'<!doctype html><div id="root"></div><script type="module" src="/src/main.js"></script>','src/main.js':`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';function App(){const [n,set]=useState(0);return React.createElement('button',{onClick:()=>set(n+1)},'React count: '+n)}createRoot(document.getElementById('root')).render(React.createElement(App));`};
   await share(react,'react');await build();
   await appFrame.getByRole('button',{name:'React count: 0'}).click({timeout:60000});
   assert.equal(await appFrame.getByRole('button').textContent(),'React count: 1');
   console.log('PASS React + Vite installs, builds, and runs interactively');

   const pkg={private:true,type:'module',scripts:{build:'vite build'},dependencies:{svelte:'5.57.3'},devDependencies:{'@sveltejs/vite-plugin-svelte':'7.3.1',vite:'8.3.8'}};
   const files={'package.json':JSON.stringify(pkg),'index.html':'<div id="app"></div><script type="module" src="/src/main.js"></script>',
     'vite.config.js':`import {defineConfig} from 'vite';import {svelte} from '@sveltejs/vite-plugin-svelte';export default defineConfig({plugins:[svelte()]});`,
     'src/main.js':`import {mount} from 'svelte';import App from './App.svelte';mount(App,{target:document.getElementById('app')});`,
     'src/App.svelte':`<script>let count=$state(0);</script><button onclick={()=>count++}>Count: {count}</button>`};
   await share(files,'svelte');await build();
   await appFrame.getByRole('button',{name:'Count: 0'}).click({timeout:60000});
   assert.equal(await appFrame.getByRole('button').textContent(),'Count: 1');
   console.log('PASS Svelte + Vite installs, builds, and runs interactively');
 }

} finally {await browser.close();}
