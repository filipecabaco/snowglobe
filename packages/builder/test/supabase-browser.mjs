import os from 'node:os';import path from 'node:path';
// Real two-VM Supabase acceptance. No mocked Auth, database, HTTP responses or VM operations.
import {chromium,webkit,devices} from '../../../bench/node_modules/playwright/index.mjs';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const migration=`CREATE TABLE public.dice_rolls(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id),value integer NOT NULL CHECK(value BETWEEN 1 AND 6),created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.dice_rolls ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rolls ON public.dice_rolls FOR ALL TO authenticated USING(auth.uid()=user_id) WITH CHECK(auth.uid()=user_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.dice_rolls TO authenticated;`;
const backupDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'builder-vm-backup-acceptance-'));
const backupOnly=process.env.BUILDER_BACKUP_ONLY==='1';
const mobile=process.env.BUILDER_BROWSER==='webkit';
const server=await (mobile?webkit:chromium).launchServer({headless:true,...(mobile?{executablePath:process.env.BUILDER_WEBKIT_BIN}:{args:['--no-sandbox']})});
const browser=await (mobile?webkit:chromium).connect(server.wsEndpoint());let failed=false;
if(process.env.BUILDER_DEBUG)await fs.writeFile('.local-dev/builder-supabase-test-control.json',JSON.stringify({endpoint:server.wsEndpoint(),engine:mobile?'webkit':'chromium'}),{mode:0o600});
try{
 const page=await browser.newPage(mobile?devices['iPhone 13']:{});page.setDefaultTimeout(300000);const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.log('PAGEERROR',error.message);});
 if(process.env.BUILDER_DEBUG)globalThis.fixturePage=page;
 const script=await fs.readFile(new URL('../../../site/builder/app.js',import.meta.url),'utf8');
 await page.route('**/builder/app.js',r=>r.fulfill({contentType:'text/javascript',body:script+'\nwindow.testBuilder=()=>({api,client,backend});'}));
 await page.goto(process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/');await page.waitForFunction(()=>window.testBuilder?.().backend);
 const timer=setInterval(async()=>{try{console.log('STATUS',await page.locator('#status').textContent());}catch{}},15000);
 try{
  await page.locator('#backend').selectOption('supabase');await page.waitForFunction(()=>document.getElementById('stop').disabled,null,{timeout:720000});
  assert.equal(await page.evaluate(()=>testBuilder().backend.enabled),true,await page.locator('#status').textContent());
  console.log('BACKEND_READY');
  async function reviewedMigration(params,approve=true){const result=page.evaluate(p=>testBuilder().backend.migrate(p),params).then(value=>({value}),error=>({error:error.message}));await page.locator('#approval').waitFor({state:'visible'});assert((await page.locator('#approval [data-content]').textContent()).includes(params.sql));await page.locator(approve?'#approval [data-approve]':'#approval [data-deny]').click();return result;}
  const params={name:'20261108000000_dice_rolls.sql',sql:migration};
  assert((await reviewedMigration(params)).value.applied);
  assert((await reviewedMigration(params)).value.unchanged);
  const schema=await page.evaluate(()=>testBuilder().backend.schema());assert(schema.columns.some(c=>c.table_name==='dice_rolls'));assert(schema.rls.find(t=>t.table_name==='dice_rolls').enabled);assert(schema.policies.some(p=>p.policyname==='own_rolls'));
  const denial=await reviewedMigration({name:'20261108000003_drop_dice.sql',sql:'DROP TABLE public.dice_rolls;'},false);assert.match(denial.error,/denied/);assert((await page.evaluate(()=>testBuilder().backend.schema())).columns.some(c=>c.table_name==='dice_rolls'));console.log('PASS schema inspection and denied destructive migration leave table intact');
  // SQL connects as a limited login role, not postgres with SET ROLE that could be reset.
  const denied=await page.evaluate(async()=>{try{await testBuilder().backend.client.call('backend.migrate',{name:'20261108000001_forbidden.sql',sql:"RESET ROLE; SELECT pg_read_file('/etc/passwd');"});return false;}catch(error){return /permission denied|must be superuser/i.test(error.message);}});assert.equal(denied,true);console.log('PASS migrations are idempotent and cannot read guest files as superuser');
  const source=await fs.readFile(new URL('./fixtures/supabase-dice.jsx',import.meta.url),'utf8');
  await page.evaluate(async text=>{const client=testBuilder().client,old=await client.call('fs.read',{path:'src/App.jsx'});await client.call('fs.write',{path:old.path,text,version:old.version});},source);
  await page.getByRole('button',{name:'Rebuild preview'}).click();await page.waitForFunction(()=>document.getElementById('stop').disabled,null,{timeout:720000});
  assert(!await page.locator('#work-progress').evaluate(el=>el.classList.contains('failed')),await page.locator('#status').textContent());
  let frame=page.frameLocator('#preview iframe');await frame.getByRole('heading',{name:'Supabase dice'}).waitFor();
  const nonce=Date.now(),alice='alice-'+nonce+'@example.com',bob='bob-'+nonce+'@example.com',password='builder-fixture-password-2026';
  async function auth(email,action){await frame.getByLabel('Email',{exact:true}).fill(email);await frame.getByLabel('Password',{exact:true}).fill(password);await frame.getByRole('button',{name:action,exact:true}).click();const child=page.frames().find(f=>f!==page.mainFrame());await child.waitForFunction(email=>document.body.innerText.includes(email)||document.querySelector('[role=alert]')?.textContent,email);if(await frame.getByRole('alert').count())assert.fail(await frame.getByRole('alert').textContent());await frame.getByText(email,{exact:true}).waitFor();}
  await auth(alice,'Sign up');await frame.getByRole('button',{name:'Roll dice',exact:true}).click();await frame.getByText('Rolls: 1',{exact:true}).waitFor();
  const child=page.frames().find(f=>f!==page.mainFrame());const aliceId=await child.evaluate(async()=>{const {data}=await fixtureSupabase.auth.getSession();return data.session.user.id;});
  await frame.getByRole('button',{name:'Sign out',exact:true}).click();await frame.getByRole('button',{name:'Sign up',exact:true}).waitFor();await auth(bob,'Sign up');await frame.getByText('Rolls: 0',{exact:true}).waitFor();
  const isolation=await child.evaluate(async owner=>{const s=fixtureSupabase;const {data}=await s.from('dice_rolls').select('*');const {error}=await s.from('dice_rolls').insert({user_id:owner,value:6});let parentDenied=false;try{void parent.document;}catch{parentDenied=true;}return {visibleRows:data.length,crossUserInsertDenied:!!error,parentDenied};},aliceId);
  assert.deepEqual(isolation,{visibleRows:0,crossUserInsertDenied:true,parentDenied:true});console.log('PASS real signup, dice insert, and row-level user isolation');
  await frame.getByRole('button',{name:'Sign out',exact:true}).click();await frame.getByRole('button',{name:'Log in',exact:true}).waitFor();await auth(alice,'Log in');await frame.getByText('Rolls: 1',{exact:true}).waitFor();console.log('PASS real password login restores the account roll log');
  if(!backupOnly){
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='snowglobe-builder-checkpoint-v1')throw new DOMException('Storage full','QuotaExceededError');return original.call(this,key,value);};});
  await page.getByRole('button',{name:'Save VM',exact:true}).click();await page.waitForFunction(()=>document.getElementById('status').textContent==='Source and Supabase checkpoints saved in this browser',null,{timeout:720000});console.log('PAIRED_CHECKPOINT_SAVED');
  await page.reload();await page.waitForFunction(()=>window.testBuilder?.().backend);frame=page.frameLocator('#preview iframe');await frame.getByText(alice,{exact:true}).waitFor();await frame.getByText('Rolls: 1',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS paired VM reload preserves real Auth session and database roll history with localStorage quota exhausted');
  // A failed source capture after the database is saved must recover newer source,
  // not silently restore the older VM checkpoint or initialize the starter.
  await page.evaluate(async()=>{const {api,client}=testBuilder();await client.call('project.initialize');const file=await client.call('fs.read',{path:'src/App.jsx'});await client.call('fs.write',{path:file.path,version:file.version,text:file.text.replace('Supabase dice','Recovered dice work')});const suspend=api.suspend;api.suspend=runtime=>{if(runtime==='web')throw new Error('Injected source capture failure');return suspend(runtime);};});
  await page.getByRole('button',{name:'Save VM',exact:true}).click();await page.waitForFunction(()=>document.getElementById('stop').disabled);
  assert.match(await page.locator('#status').textContent(),/source recovery copy is saved/);
  await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Source recovered'));
  await page.getByRole('button',{name:'Rebuild preview'}).click();await page.locator('#approval').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#approval [data-title]').textContent==='Recover saved source');assert.match(await page.locator('#approval [data-content]').textContent(),/Recovered dice work/);await page.locator('#approval [data-approve]').click();await page.waitForFunction(()=>document.querySelector('#approval').open&&document.querySelector('#approval [data-title]').textContent!=='Recover saved source');assert.match(await page.locator('#approval [data-content]').textContent(),/20261108000000_dice_rolls.sql/);await page.locator('#approval [data-approve]').click();await page.waitForFunction(()=>document.getElementById('stop').disabled,null,{timeout:720000});
  frame=page.frameLocator('#preview iframe');await frame.getByRole('heading',{name:'Recovered dice work'}).waitFor();await frame.getByText(alice,{exact:true}).waitFor();await frame.getByText('Rolls: 1',{exact:true}).waitFor();
  console.log('PASS failed source capture recovers latest source, account and roll history after reload');
  }
  // Restore actual downloaded source/database VM files into an isolated project.
  await page.getByRole('button',{name:'Save VM',exact:true}).click();await page.waitForFunction(()=>document.getElementById('status').textContent==='Source and Supabase checkpoints saved in this browser',null,{timeout:720000});
  async function downloadBackup(selector,review=false){console.log('BACKUP_DOWNLOAD_START',selector);const download=page.waitForEvent('download');await page.locator(selector).click();if(review){await page.locator('#approval').waitFor({state:'visible'});await page.locator('#approval [data-approve]').click();}const result=await download;await page.waitForFunction(()=>document.getElementById('stop').disabled);const destination=path.join(backupDirectory,path.basename(result.suggestedFilename()));await result.saveAs(destination);console.log('BACKUP_DOWNLOAD_SAVED',selector,(await fs.stat(destination)).size);return destination;}
  await page.locator('#vm-backups').evaluate(element=>element.open=true);
  const manifestPath=await downloadBackup('#backup-manifest'),sourcePath=await downloadBackup('#backup-web',true),databasePath=await downloadBackup('#backup-supabase',true),originalUrl=page.url();
  await page.locator('#backup-manifest-file').setInputFiles(manifestPath);await page.locator('#backup-source-file').setInputFiles(sourcePath);await page.locator('#backup-database-file').setInputFiles(databasePath);await page.locator('#backup-import').click();await page.locator('#approval').waitFor({state:'visible'});assert.match(await page.locator('#approval [data-title]').textContent(),/new project/);await page.locator('#approval [data-approve]').click();await page.waitForURL(url=>url.href!==originalUrl);await page.waitForFunction(()=>window.testBuilder?.().backend.enabled&&document.getElementById('stop').disabled);
  await page.getByRole('button',{name:'Rebuild preview'}).click();await page.waitForFunction(()=>document.getElementById('stop').disabled,null,{timeout:720000});assert(!await page.locator('#work-progress').evaluate(el=>el.classList.contains('failed')),await page.locator('#status').textContent());
  frame=page.frameLocator('#preview iframe');await frame.getByRole('heading',{name:backupOnly?'Supabase dice':'Recovered dice work'}).waitFor();await auth(alice,'Log in');await frame.getByText('Rolls: 1',{exact:true}).waitFor();await frame.getByRole('button',{name:'Sign out',exact:true}).click();await auth(bob,'Log in');await frame.getByText('Rolls: 0',{exact:true}).waitFor();assert.deepEqual(errors,[]);console.log('PASS downloaded paired VM backups restore real source, accounts and isolated database rows into a new project');

 }finally{clearInterval(timer);}
}catch(error){failed=true;console.error('ACCEPTANCE_FAILURE',error.message);throw error;}finally{if(failed&&process.env.BUILDER_DEBUG){console.error('DEBUG_BROWSER_RETAINED');await new Promise(()=>{});}await browser.close();await server.close();await fs.rm(backupDirectory,{recursive:true,force:true});if(process.env.BUILDER_DEBUG)await fs.rm('.local-dev/builder-supabase-test-control.json',{force:true});}
