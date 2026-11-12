// Regression for Svelte icon barrels, Tailwind, and installed-dependency reuse in the real VM.
// Only the folder picker is mocked. The manifest matches the reported three-in-a-row app.
import {chromium} from './node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const names=['ArrowUpRight','RotateCcw','Hash','ShieldCheck','Sparkles','ArrowRight','Trophy','Leaf','Layers','Zap','Check','HardDrive','Info'];
const manifest={
  name:'apphost-svelte-regression',private:true,type:'module',
  scripts:{build:'node verify.mjs && vite build'},
  dependencies:{'@lucide/svelte':'1.72.0',clsx:'2.1.1',svelte:'5.57.3','tailwind-merge':'3.7.0','tailwind-variants':'4.0.2'},
  devDependencies:{'@sveltejs/vite-plugin-svelte':'7.3.1','@tailwindcss/vite':'4.3.5','@types/node':'26.6.6','svelte-check':'4.7.8',tailwindcss:'4.3.5','tw-animate-css':'1.4.0',typescript:'5.9.3',vite:'8.3.8'},
};
const files={
  'package.json':JSON.stringify(manifest),
  'index.html':'<div id="app"></div><script type="module" src="/src/main.js"></script>',
  'vite.config.js':`import {defineConfig} from 'vite';import {svelte} from '@sveltejs/vite-plugin-svelte';import tailwindcss from '@tailwindcss/vite';export default defineConfig({plugins:[svelte(),tailwindcss()]});`,
  'src/main.js':`import {mount} from 'svelte';import App from './App.svelte';import './style.css';mount(App,{target:document.getElementById('app')});`,
  'src/style.css':`@import 'tailwindcss';@import 'tw-animate-css';`,
  'src/App.svelte':`<script>import {${names.join(',')}} from '@lucide/svelte';let count=$state(0);</script><h1 class="font-bold">Svelte icons work</h1><button onclick={()=>count++}>Count: {count}</button>${names.map(name=>'<'+name+'/>').join('')}`,
  // These files are not imported by the app. Verify the optimizer also handles aliases,
  // type-only imports, module scripts, and misleading strings without changing their meaning.
  'src/Cases.svelte':`<script module lang="ts">import { TrophyIcon as Cup } from '@lucide/svelte';export const trophy=Cup;</script>\n<script lang="ts">import type {IconProps} from '@lucide/svelte';import {type IconNode, RotateCcw as Reset, Icon} from '@lucide/svelte';const text="import {Trophy} from '@lucide/svelte';";</script>`,
  'src/Namespace.svelte':`<script>import * as icons from '@lucide/svelte';const name=icons.Trophy;</script>`,
  'verify.mjs':`import assert from 'node:assert/strict';import fs from 'node:fs';const app=fs.readFileSync('src/App.svelte','utf8');assert.ok(!app.includes("from '@lucide/svelte'"));assert.equal((app.match(/@lucide\\/svelte\\/icons\\//g)||[]).length,13);const cases=fs.readFileSync('src/Cases.svelte','utf8');assert.ok(cases.includes('import Cup from "@lucide/svelte/icons/trophy"'));assert.ok(cases.includes('import Reset from "@lucide/svelte/icons/rotate-ccw"'));assert.ok(cases.includes("import type {IconProps} from '@lucide/svelte'"));assert.ok(cases.includes('type IconNode, Icon'));assert.ok(cases.includes('const text="import {Trophy} from'));assert.ok(fs.readFileSync('src/Namespace.svelte','utf8').includes("import * as icons from '@lucide/svelte'"));console.log('PASS safe build-copy icon rewrite');`,
};
if (process.env.APPHOST_LOCKFILE) files['package-lock.json']=await fs.readFile(process.env.APPHOST_LOCKFILE,'utf8');
const fixtureIndex=process.argv.indexOf('--write-fixture');
if (fixtureIndex!==-1) {
  const directory=process.argv[fixtureIndex+1];
  assert.ok(directory,'--write-fixture needs a directory');
  for (const [name,source] of Object.entries(files)) {
    const target=path.join(directory,name);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,source);
  }
  process.exit(0);
}

const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page=await browser.newPage();
  await page.addInitScript(files=>{
    window.fixture=files;
    window.showDirectoryPicker=async()=>({name:'svelte-icons',kind:'directory',async *entries(){
      for(const [name,text] of Object.entries(window.fixture)) yield [name,{kind:'file',getFile:async()=>new File([text],name)}];
    }});
  },files);
  await page.goto(process.env.APPHOST_URL||'http://127.0.0.1:18456/apphost/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.getElementById('choose-folder').disabled);
  await page.locator('#choose-folder').click();
  await page.waitForFunction(()=>!document.getElementById('deploy').disabled);
  const app=page.frameLocator('#app-frame');
  async function build() {
    await page.getByRole('button',{name:'Build & deploy'}).click();
    let last='';
    const progress=setInterval(async()=>{
      try {const text=await page.locator('#build-log').textContent();if(text!==last){console.log(text.slice(last.length));last=text;}} catch {}
    },10000);
    try {await page.waitForFunction(()=>document.getElementById('log-state').textContent!=='BUILDING',null,{timeout:1200000});}
    finally {clearInterval(progress);}
    const log=await page.locator('#build-log').textContent();console.log(log.slice(last.length));
    assert.equal(await page.locator('#log-state').textContent(),'DEPLOYED');
    assert.match(log,/Optimized 15 Svelte icon imports/);
    assert.match(log,/PASS safe build-copy icon rewrite/);
    const transformed=Number(log.match(/([\d,]+) modules transformed/)?.[1].replaceAll(',',''));
    assert.ok(transformed>0 && transformed<250,'only the requested icon graph should be compiled');
    await app.getByRole('heading',{name:'Svelte icons work'}).waitFor({timeout:30000});
    assert.equal(await app.locator('svg').count(),13);
    assert.equal(await app.getByRole('heading').evaluate(el=>getComputedStyle(el).fontWeight),'700');
    await app.getByRole('button',{name:'Count: 0'}).click();
    await app.getByRole('button',{name:'Count: 1'}).waitFor();
    return log;
  }
  await build();console.log('PASS exact Svelte/Lucide/Tailwind versions build and run in the browser VM');
  await page.getByRole('tab',{name:'Build',exact:true}).click();
  await page.evaluate(()=>window.fixture['src/App.svelte']+='\n<!-- Source-only edit -->');
  const rebuilt=await build();
  assert.match(rebuilt,/Reusing installed dependencies/);
  assert.doesNotMatch(rebuilt,/\$ npm (?:install|ci)\b/);
  console.log('PASS Svelte source-only rebuild skips installation and optimizes the fresh snapshot');
} finally {await browser.close();}
