// Opt-in real subscription inference and Linux VM acceptance. No API-key fallback.
// Synthetic accounts/data only; SQL review permits this empty test DB's profiles schema.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {allowedProfileSql as allowedTestSql} from './profile-acceptance-contract.mjs';
const fixture=process.env.BUILDER_PROFILE_FIXTURE==='1';
const resultName=process.env.BUILDER_PROFILE_RESULT_NAME||(fixture?'profile-fixture':'live-profile')+'-acceptance-result.json';
if(!/^[a-zA-Z0-9-]+\.json$/.test(resultName))throw Error('Invalid test result filename');
if(!fixture&&process.env.BUILDER_LIVE_SUBSCRIPTION!=='1')throw Error('Set BUILDER_LIVE_SUBSCRIPTION=1 to request a user-approved live subscription test');
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});
const page=await browser.newPage();page.setDefaultTimeout(120000);
const bundle=await fs.readFile(new URL('../../../site/builder/app.js',import.meta.url),'utf8');
await page.route('**/builder/app.js',route=>route.fulfill({contentType:'text/javascript',body:bundle+'\nwindow.liveProfile=()=>({client,backend});'}));
const checks=[],errors=[];let timer,connected=false,passed=false,shutdownPromise,repairAttempts=0,sourceCapture=0,uiCapture=0;
const diagnosticPrefix=new URL('../../../.local-dev/profile-test-'+Date.now(),import.meta.url);
async function diagnostics(){
 const frame=page.frames().find(frame=>frame!==page.mainFrame());const body=await frame?.locator('body').innerText().catch(()=>null);
 const evidence={body:body?.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted token]'),errors,status:await page.locator('#status').textContent().catch(()=>null)};
 await fs.writeFile(new URL(diagnosticPrefix.href+'-ui-'+(++uiCapture)+'.json'),JSON.stringify(evidence,null,2),{mode:0o600});
 return evidence;
}
async function captureSource(){
 const source=await page.evaluate(()=>window.liveProfile?.().client.call('project.export'));
 if(source)await fs.writeFile(new URL(diagnosticPrefix.href+'-source-'+(++sourceCapture)+'.json'),JSON.stringify(source),{mode:0o600});
}

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void shutdown().finally(()=>process.exit(130));});
page.on('pageerror',error=>errors.push(error.message));
const idle=timeout=>page.waitForFunction(()=>document.getElementById('stop').disabled,null,{timeout});
const succeeded=async()=>assert.equal(await page.locator('#work-progress').evaluate(el=>el.classList.contains('failed')),false,await page.locator('#status').textContent());
// Reject SQL outside the declared synthetic profiles workflow. Host/backend approvals
// remain real dialogs, and denial is never overridden by a tool result.

async function modelTurn(prompt){
 await page.locator('#prompt').fill(prompt);await page.locator('#send').click();await page.waitForFunction(()=>!document.getElementById('stop').disabled);
 const deadline=Date.now()+16*60*1000;
 while(Date.now()<deadline){
  if(await page.locator('#approval').evaluate(el=>el.open)){
   const title=await page.locator('#approval [data-title]').textContent(),content=await page.locator('#approval [data-content]').textContent();
   if(title!=='Review database change'||!allowedTestSql(content.replace(/^\d{14}_[a-z0-9_]+\.sql\s*/,''))){await page.locator('#approval [data-deny]').click();throw Error('Live model requested a change outside the test schema approval scope');}
   await page.locator('#approval [data-approve]').click();console.log('APPROVED synthetic profiles schema migration');
  }
  if(await page.locator('#stop').isDisabled()){await succeeded();return;}
  await page.waitForTimeout(500);
 }
 await page.locator('#stop').click();throw Error('Live profile task exceeded its bounded deadline');
}
try{
 await page.goto(process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/');await page.waitForFunction(()=>document.getElementById('status').textContent!=='Loading Builder…');
 timer=setInterval(async()=>{try{console.log('STATUS',await page.locator('#status').textContent());}catch{}},15000);
 if(!fixture){
 await page.locator('#settings').evaluate(el=>el.open=true);await page.locator('#provider').selectOption('openai');await page.locator('#provider-method').selectOption('codex');await page.locator('#connect').click();await idle(90000);
 const userCode=(await page.locator('#codex-code').textContent()).trim(),verificationUrl=await page.locator('#codex-link').getAttribute('href');
 assert(userCode);assert.equal(verificationUrl,'https://auth.openai.com/codex/device');console.log('SIGN_IN',JSON.stringify({verificationUrl,userCode}));
 const loginDeadline=Date.now()+10*60*1000;
 while(Date.now()<loginDeadline){const state=await page.evaluate(async()=>{const r=await fetch('/builder-api/codex/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const j=await r.json();return {connected:j.connected,failed:j.login?.status==='failed'};});if(state.connected){connected=true;break;}if(state.failed)throw Error('Subscription approval expired or failed');await page.waitForTimeout(3000);}
 if(!connected)throw Error('Subscription approval was not completed within ten minutes');
 await page.locator('#codex-refresh').click();await idle(90000);assert.match(await page.locator('#ai-indicator').textContent(),/Codex/);checks.push('user-approved-subscription');
 }
 await page.locator('#framework').selectOption('react-vite');await idle(300000);await page.locator('#backend').selectOption('supabase');await idle(900000);await succeeded();
 assert.equal(await page.evaluate(()=>liveProfile().backend.enabled),true);checks.push('real-source-and-database-prepared');console.log('PASS real source and Supabase VMs prepared before live model request');
 if(fixture){
 const sql="CREATE TABLE public.profiles(user_id uuid PRIMARY KEY REFERENCES auth.users(id), display_name text NOT NULL DEFAULT ''); ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY; CREATE POLICY own_profiles ON public.profiles FOR ALL TO authenticated USING(auth.uid()=user_id) WITH CHECK(auth.uid()=user_id); GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;";assert(allowedTestSql(sql));
 const migration=page.evaluate(sql=>liveProfile().backend.migrate({name:'20261109000000_profiles.sql',sql}),sql);await page.locator('#approval').waitFor({state:'visible'});await page.locator('#approval [data-approve]').click();await migration;
 const source=await fs.readFile(new URL('./fixtures/supabase-profiles.jsx',import.meta.url),'utf8');await page.evaluate(async text=>{const client=liveProfile().client,file=await client.call('fs.read',{path:'src/App.jsx'});await client.call('fs.write',{path:file.path,version:file.version,text});},source);await page.locator('#build').click();await idle(900000);await succeeded();
 }else{
 await modelTurn(`Create a working local Supabase accounts and editable profiles app. Use the existing managed src/supabase.js client, React/Vite and installed packages only; do not install packages. Read the project and inspect the schema. Apply a new timestamped migration creating public.profiles(user_id uuid PRIMARY KEY REFERENCES auth.users(id), display_name text NOT NULL DEFAULT ''). Enable RLS and policies using auth.uid()=user_id with WITH CHECK for writes; grant SELECT, INSERT, UPDATE, DELETE to authenticated. Use unquoted public.profiles identifiers and ordinary CREATE TABLE, ALTER TABLE ENABLE ROW LEVEL SECURITY, CREATE POLICY and GRANT statements; the host reviews the exact SQL. Do not drop anything or create functions/extensions. Build a heading exactly "Builder profiles". When logged out show labeled Email and Password inputs and buttons exactly "Sign up" and "Log in". When logged in show the current email as exact text, a field labeled "Display name", a button "Save profile" and a button "Sign out". Load only this user's saved profile, save it with upsert on user_id, and display success as exact text "Profile saved". Use real email/password Auth and database calls, never mock data. Call build_preview and fix errors before finishing.`);
 }
 checks.push(fixture?'fixture-schema-and-app-build':'live-model-schema-and-app-build');await captureSource();
 const schema=await page.evaluate(()=>liveProfile().backend.schema());assert(schema.rls.some(t=>t.table_name==='profiles'&&t.enabled));assert(schema.policies.some(p=>p.tablename==='profiles'));checks.push('profiles-rls-schema');
 let frame=page.frameLocator('#preview iframe');await frame.getByRole('heading',{name:'Builder profiles',exact:true}).waitFor();
 const nonce=Date.now(),alice='profile-alice-'+nonce+'@example.com',bob='profile-bob-'+nonce+'@example.com',password='Synthetic-builder-profile-password-2026';
 async function login(email,action){await frame.getByLabel('Email',{exact:true}).fill(email);await frame.getByLabel('Password',{exact:true}).fill(password);await frame.getByRole('button',{name:action,exact:true}).click();await frame.getByText(email,{exact:true}).waitFor();await frame.getByLabel('Display name',{exact:true}).waitFor();}
 async function saveProfile(name){
 await frame.getByLabel('Display name',{exact:true}).fill(name);await frame.getByRole('button',{name:'Save profile',exact:true}).click();
 try{await frame.getByText('Profile saved',{exact:true}).waitFor({timeout:60000});}
 catch(error){const evidence=await diagnostics();if(fixture||repairAttempts++>=1)throw error;
 console.log('REPAIR live profile save did not confirm; requesting one bounded functional repair');
 await modelTurn('The functional acceptance check failed: after signing in and saving a display name, the exact success message Profile saved did not appear. Visible app state (synthetic test data): '+JSON.stringify(evidence).slice(0,8000)+'. Inspect the current source and database diagnostics. Fix real profile upsert/save and confirmation behavior, preserve current authentication and existing rows, do not install packages or drop/change tables, and build the preview.');await captureSource();checks.push('bounded-live-functional-repair');await frame.getByLabel('Display name',{exact:true}).waitFor();await saveProfile(name);
 }
 }
 const previewFrame=()=>page.frames().find(f=>f!==page.mainFrame());
 async function expectProfile(name){const deadline=Date.now()+120000;while(Date.now()<deadline){const value=await frame.getByLabel('Display name',{exact:true}).inputValue({timeout:5000}).catch(()=>null);if(value===name)return;await page.waitForTimeout(250);}assert.equal(await frame.getByLabel('Display name',{exact:true}).inputValue(),name);}
 async function identity(){return previewFrame().evaluate(()=>JSON.parse(localStorage.getItem('snowglobe-project-auth')).user.id);}
 await login(alice,'Sign up');await saveProfile('Alice private profile');const aliceId=await identity();await frame.getByRole('button',{name:'Sign out',exact:true}).click();await login(bob,'Sign up');await frame.getByLabel('Display name',{exact:true}).waitFor();
 assert.notEqual(await frame.getByLabel('Display name',{exact:true}).inputValue(),'Alice private profile');await saveProfile('Bob private profile');const bobId=await identity();
 const isolation=await previewFrame().evaluate(async owner=>{const config=window.SNOWGLOBE_SUPABASE,session=JSON.parse(localStorage.getItem('snowglobe-project-auth')),headers={apikey:config.anonKey,Authorization:'Bearer '+session.access_token,'Content-Type':'application/json',Prefer:'return=representation'};const all=await fetch(config.url+'/rest/v1/profiles?select=user_id,display_name',{headers}).then(r=>r.json());const cross=await fetch(config.url+'/rest/v1/profiles?user_id=eq.'+owner,{method:'PATCH',headers,body:JSON.stringify({display_name:'FORBIDDEN'})});let body;try{body=await cross.json();}catch{}return {ownOnly:Array.isArray(all)&&all.length===1&&all[0].user_id===session.user.id,crossDenied:cross.status===401||cross.status===403||Array.isArray(body)&&body.length===0};},aliceId);
 assert.deepEqual(isolation,{ownOnly:true,crossDenied:true});assert.notEqual(aliceId,bobId);checks.push('two-real-accounts','profile-crud','cross-user-read-write-isolation');
 await frame.getByRole('button',{name:'Sign out',exact:true}).click();await login(alice,'Log in');await expectProfile('Alice private profile');
 console.log('PASS',fixture?'deterministic profile fixture':'live generated profile app','two accounts, database persistence and direct RLS isolation');
 await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='Source and Supabase checkpoints saved in this browser',null,{timeout:900000});await page.reload();await page.waitForFunction(()=>window.liveProfile?.().backend.enabled);frame=page.frameLocator('#preview iframe');await frame.getByText(alice,{exact:true}).waitFor();await expectProfile('Alice private profile');checks.push('paired-save-reload-auth-profile');
 const denial=page.evaluate(async()=>{try{await liveProfile().backend.migrate({name:'20261109000099_drop_profiles.sql',sql:'DROP TABLE public.profiles;'});return false;}catch(error){return /denied/i.test(error.message);}});await page.locator('#approval').waitFor({state:'visible'});await page.locator('#approval [data-deny]').click();assert.equal(await denial,true);const after=await page.evaluate(()=>liveProfile().backend.schema());assert(after.columns.some(c=>c.table_name==='profiles'));checks.push('denied-destructive-sql-retains-profile-table');
 assert.deepEqual(errors,[]);passed=true;console.log('PASS paired checkpoint/reload and denied destructive SQL');
}catch(error){await diagnostics().catch(()=>{});await captureSource().catch(()=>{});throw error;}finally{await shutdown();}
async function shutdown(){
 if(shutdownPromise)return shutdownPromise;
 shutdownPromise=(async()=>{
 clearInterval(timer);const disconnected=await page.evaluate(async()=>{const r=await fetch('/builder-api/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return r.ok||r.status===401;}).catch(()=>false);
 if(disconnected)console.log('PASS test provider session disconnected');
 await fs.writeFile(new URL('../../../.local-dev/'+resultName,import.meta.url),JSON.stringify({status:passed&&disconnected?'passed':'failed',mode:fixture?'deterministic-fixture':'live-subscription',diagnosticPrefix:diagnosticPrefix.pathname,model:await page.locator('#model').inputValue().then(value=>JSON.parse(value)[1]).catch(()=>null),checks,disconnected,completedAt:new Date().toISOString(),browserArtifactSha256:createHash('sha256').update(bundle).digest('hex')},null,2)+'\n',{mode:0o600});
 await browser.close();
})();return shutdownPromise;
}
