import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import fs from 'node:fs/promises';import path from 'node:path';
import {validateMigration,isAuthExecutable} from '../src/supabase-guest.mjs';
const bundled=await build({entryPoints:[new URL('../src/backend.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'raw',setup(b){b.onResolve({filter:/\?raw$/},a=>({path:path.resolve(a.resolveDir,a.path.slice(0,-4)),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async a=>({contents:await fs.readFile(a.path,'utf8'),loader:'text'}));}}]});
const {validateBackendRequest,restoredBackendConfig,SUPABASE_ORIGIN,SupabaseBackend,supabaseSource}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text+'\n//# sourceURL=builder-backend-test.mjs').toString('base64'));
const jwt=role=>'header.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.signature';
const request=(path,extra={})=>({url:SUPABASE_ORIGIN+path,method:'GET',body:'',headers:[],...extra});
test('Supabase preview relay permits only fixed local Auth/Data routes and public credentials',()=>{
 const publicKey=jwt('anon');const result=validateBackendRequest(request('/auth/v1/signup',{method:'POST',body:'{"email":"test@example.invalid"}',headers:[['apikey',publicKey],['authorization','Bearer '+jwt('authenticated')],['cookie','builder-session=private']]}),publicKey);
 assert.equal(result.path,'/auth/v1/signup');assert.equal(result.headers.filter(([name])=>name==='apikey').length,1);assert(!result.headers.some(([name])=>name==='cookie'));
 assert.equal(validateBackendRequest(request('/rest/v1/rolls?select=*&order=created_at.desc'),publicKey).method,'GET');
 for(const path of ['/builder-api/status','/auth/v1/admin/users','/storage/v1/object','/rest/v1/../../auth/users','/rest/v1/%2ftokens','/rest/v1/rolls?apikey=secret'])assert.throws(()=>validateBackendRequest(request(path),publicKey));
 assert.throws(()=>validateBackendRequest({...request('/auth/v1/token'),url:'https://outside.invalid/auth/v1/token'},publicKey));
 for(const port of [54323,54324])assert.throws(()=>validateBackendRequest({...request('/rest/v1/recipes'),url:SUPABASE_ORIGIN+':'+port+'/bridge'},publicKey),'preview cannot reach owner console or upload ports');
 assert.throws(()=>validateBackendRequest(request('/auth/v1/user',{headers:[['authorization','Bearer '+jwt('service_role')]]}),publicKey),/Administrative/);
 assert.throws(()=>validateBackendRequest(request('/rest/v1/rolls',{headers:[['accept-profile','auth']]}),publicKey),/public/);
 assert.throws(()=>validateBackendRequest(request('/rest/v1/rolls',{headers:[['apikey','admin']]}),publicKey),/public/);
 assert.throws(()=>validateBackendRequest(request('/auth/v1/token',{body:'a'.repeat(131073)}),publicKey),/128 KiB/);
 assert.throws(()=>validateBackendRequest(request('/auth/v1/user',{headers:[['Accept','ok\r\nHost: attacker']]}),publicKey),/header/);
});
test('migration requests are named/bounded SQL and cannot invoke psql shell metacommands',()=>{
 assert.equal(validateMigration({name:'20261108000000_rolls.sql',sql:'create table public.rolls(id bigint);'}).name,'20261108000000_rolls.sql');
 for(const p of [{name:'../bad.sql',sql:'select 1'},{name:'20261108000000_rolls.sql',sql:'\\! env'},{name:'20261108000000_rolls.sql',sql:' '.repeat(65537)},{name:'20261108000000_rolls.sql',sql:'select\0 1'}])assert.throws(()=>validateMigration(p));
});
test('backend restore rejects mismatched database checkpoints and privileged or external configuration',()=>{
 const slot={saved:{savedAt:100},config:{build:'database-build'}},saved={backendSavedAt:100,backendBuild:'database-build',backendConfig:{url:SUPABASE_ORIGIN,anonKey:jwt('anon')}};
 assert.deepEqual(restoredBackendConfig(saved,slot),saved.backendConfig);
 assert.throws(()=>restoredBackendConfig({...saved,backendSavedAt:99},slot),/do not match/);
 assert.throws(()=>restoredBackendConfig({...saved,backendBuild:'other'},slot),/do not match/);
 assert.throws(()=>restoredBackendConfig({...saved,backendConfig:{url:'https://outside.invalid',anonKey:jwt('anon')}},slot),/invalid/);
 assert.throws(()=>restoredBackendConfig({...saved,backendConfig:{url:SUPABASE_ORIGIN,anonKey:jwt('service_role')}},slot),/invalid/);
 assert.equal(restoredBackendConfig({},slot),null);
});

test('enabling Supabase replaces the installed starter client; later upgrades preserve a custom client',async()=>{
 let text='export const supabase = legacyStarterClient;',writes=0;
 const sourceClient={async call(op,args){if(op==='fs.read')return {text,version:'v1'};if(op==='fs.write'){text=args.text;writes++;}}};
 const backend=new SupabaseBackend({}, {sourceClient});backend.client.call=async()=>({anonKey:jwt('anon'),scope:'local',services:[]});backend.ready=async()=>{};backend.http=async()=>({status:200});
 await backend.enable();assert.equal(text,supabaseSource);assert.equal(writes,1);
 await backend.enable();assert.equal(writes,1);
 text='export const custom = true;';await backend.enable();assert.equal(writes,1);assert.match(text,/custom/);
});

test('Auth timeout upgrade recognizes the native stack wrapped binary without targeting other services',()=>{
 assert.equal(isAuthExecutable('/home/supa/.supabase/cache/stack/slim-services/auth/v2/linux-arm64/bin/.auth-wrapped'),true);
 assert.equal(isAuthExecutable('/home/supa/app/bin/auth'),true);
 assert.equal(isAuthExecutable('/home/supa/app/bin/gotrue'),true);
 assert.equal(isAuthExecutable('/home/supa/app/bin/postgrest'),false);
 assert.equal(isAuthExecutable('/usr/local/bin/supabase'),false);
 assert.equal(isAuthExecutable('/bin/auth'),false);
});

test('migration approval is required before enabling, writing or changing the database',async()=>{
 const actions=[];const backend=new SupabaseBackend({}, {sourceClient:{async call(op,p){actions.push(op);if(op==='fs.read')throw Object.assign(new Error('ENOENT'),{code:'ENOENT'});return {};}}});
 backend.enable=async()=>actions.push('enable');backend.client.call=async(op,p)=>{actions.push(op);return {applied:true};};backend.api={_get:()=>({})};
 const params={name:'20261108000000_profiles.sql',sql:'DROP TABLE public.profiles;'};
 await assert.rejects(backend.migrate(params),/denied/);assert.deepEqual(actions,[]);
 backend.approve=async request=>{assert.match(request.content,/DROP TABLE public.profiles/);return false;};
 await assert.rejects(backend.migrate(params),/denied/);assert.deepEqual(actions,[]);
 backend.approve=async()=>true;await backend.migrate(params);assert.deepEqual(actions,['enable','fs.read','fs.write','backend.migrate']);
});
test('Stop while an approval is pending prevents migration execution; invalid SQL never prompts',async()=>{
 const controller=new AbortController();let requests=0;
 const backend=new SupabaseBackend({}, {approve:async()=>{requests++;controller.abort();return true;}});
 await assert.rejects(backend.migrate({name:'20261108000000_profiles.sql',sql:'DROP TABLE public.profiles;'},controller.signal),/abort/i);
 assert.equal(requests,1);
 await assert.rejects(backend.migrate({name:'../bad.sql',sql:'DROP TABLE public.profiles;'}),/timestamped/);assert.equal(requests,1);
 await assert.rejects(backend.migrate({name:'20261108000000_profiles.sql',sql:'\\! env'}),/bounded/);assert.equal(requests,1);
});

test('Backend None rejects setup, SQL and preview requests before any guest work or approval',async()=>{
 let operations=0,approvals=0;
 const backend=new SupabaseBackend({}, {allowed:()=>false,approve:async()=>{approvals++;return true;}});
 backend.client.call=async()=>{operations++;throw new Error('Must not run');};
 await assert.rejects(backend.enable(),/disabled/);
 await assert.rejects(backend.migrate({name:'20261108000000_disabled.sql',sql:'DROP TABLE public.profiles;'}),/disabled/);
 await assert.rejects(backend.http(request('/rest/v1/profiles')),/disabled/);
 assert.equal(operations,0);assert.equal(approvals,0);assert.equal(backend.enabled,false);
});
