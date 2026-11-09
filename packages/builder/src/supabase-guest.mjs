// Runs only in the Supabase guest. No administrative credential is returned to the browser.
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
const directory='/var/lib/snowglobe-builder';
const role='snowglobe_builder';
export const isAuthExecutable=exe=>typeof exe==='string'&&exe.startsWith('/home/supa/')&&/(?:\/auth|\/gotrue|\/\.auth-wrapped)$/.test(exe);
async function startApi(authPort){
 if(!/^\d+$/.test(authPort||''))throw new Error('Local Auth did not supply its API port');
 await fs.writeFile(directory+'/auth-port.json',JSON.stringify({port:Number(authPort)}),{mode:0o600});
 const healthy=async()=>{try{return (await fetch('http://127.0.0.1:54322/auth/v1/health',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}};
 if(await healthy())return;
 const log=await fs.open(directory+'/api.log','a',0o600);
 try{const child=spawn(process.execPath,['run',directory+'/bridge.mjs','--serve'],{env:{...process.env,BUN_BE_BUN:'1'},detached:true,stdio:['ignore',log.fd,log.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('Local Builder API could not start')));});child.unref();}finally{await log.close();}
 const deadline=Date.now()+45000;while(Date.now()<deadline){if(await healthy())return;await new Promise(resolve=>setTimeout(resolve,250));}
 throw new Error('Local Builder API did not become ready');
}
// Auth's native 10-second request limit can expire during password hashing under
// WebKit's ARM emulation. Upgrade the running service without resetting its DB.
// Its existing environment (including private keys) stays entirely in this guest.
async function configureAuth(){
 for(const entry of await fs.readdir('/proc')){
  if(!/^\d+$/.test(entry))continue;
  const proc='/proc/'+entry;let exe,env,args,cwd,identity;
  try{
   exe=await fs.readlink(proc+'/exe');if(!isAuthExecutable(exe))continue;
   env=Object.fromEntries((await fs.readFile(proc+'/environ','utf8')).split('\0').filter(Boolean).map(item=>{const at=item.indexOf('=');return [item.slice(0,at),item.slice(at+1)];}));
   if(env.GOTRUE_DB_DRIVER!=='postgres')continue;
   if(env.GOTRUE_API_MAX_REQUEST_DURATION==='120s'){await startApi(env.GOTRUE_API_PORT);return;}
   args=(await fs.readFile(proc+'/cmdline','utf8')).split('\0').filter(Boolean).slice(1);cwd=await fs.readlink(proc+'/cwd');identity=await fs.stat(proc);
  }catch{continue;}
  const log=await fs.open(directory+'/auth.log','a',0o600);
  const launch=async values=>{const child=spawn(exe,args,{cwd,env:values,uid:identity.uid,gid:identity.gid,detached:true,stdio:['ignore',log.fd,log.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('Local Auth could not restart')));});child.unref();};
  const health=async()=>{const deadline=Date.now()+45000;while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:'+env.GOTRUE_API_PORT+'/health',{signal:AbortSignal.timeout(2000)});if(response.ok)return true;}catch{}await new Promise(resolve=>setTimeout(resolve,250));}return false;};
  try{
   process.kill(Number(entry),'SIGTERM');
   for(let i=0;i<100;i++){try{process.kill(Number(entry),0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,100));}
   await launch({...env,GOTRUE_API_MAX_REQUEST_DURATION:'120s'});
   if(!await health())throw new Error('Local Auth did not become ready after its timeout upgrade');
   await startApi(env.GOTRUE_API_PORT);
   return;
  }catch(error){await launch(env).catch(()=>{});throw error;}
  finally{await log.close();}
 }
 throw new Error('The local Auth service could not be found for its browser timeout upgrade');
}
export function validateMigration({name,sql}){
 if(typeof name!=='string'||!/^\d{14}_[a-z0-9_]+\.sql$/.test(name))throw new Error('Use a migration name such as 20261108000000_create_rolls.sql');
 if(typeof sql!=='string'||!sql.trim()||Buffer.byteLength(sql)>65536||/[\\\0]/.test(sql))throw new Error('Migration SQL must be bounded text without psql metacommands or backslashes');
 return {name,sql};
}
export async function psql(url,sql,{spawnProcess=spawn,timeoutMs=120000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawnProcess('psql',[url,'-X','-q','-v','ON_ERROR_STOP=1','-A','-t','-f','-'],{stdio:['pipe','pipe','pipe']});let output='',error='',settled=false;
  const fail=message=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(new Error(message));};
  const timer=setTimeout(()=>fail('Database operation timed out'),timeoutMs);
  child.stdout.on('data',b=>{output+=b.toString();if(Buffer.byteLength(output)>32768)fail('Database output exceeds 32 KiB; narrow the request');});
  child.stderr.on('data',b=>{error=(error+b).slice(-4000);});
  child.on('error',()=>fail('Postgres client could not start'));
  child.on('exit',code=>{if(settled)return;settled=true;clearTimeout(timer);code===0?resolve(output.trim()):reject(new Error(error||'Database operation failed'));});
  child.stdin.on('error',()=>{});child.stdin.end(sql);
 });
}

async function connection(){
 if(!process.env.DB_URL||!process.env.ANON_KEY)throw new Error('The local Supabase stack has not supplied its configuration');
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 let config;try{config=JSON.parse(await fs.readFile(directory+'/database.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;config={password:randomBytes(24).toString('hex')};await fs.writeFile(directory+'/database.json',JSON.stringify(config),{mode:0o600,flag:'wx'});}
 if(!/^[a-f0-9]{48}$/.test(config.password))throw new Error('Invalid database tool configuration');
 const db=new URL(process.env.DB_URL);db.username=role;db.password=config.password;
 await psql(process.env.DB_URL,`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD '${config.password}'; END IF; END $$;
 GRANT USAGE,CREATE ON SCHEMA public TO ${role}; GRANT USAGE ON SCHEMA auth TO ${role}; GRANT REFERENCES(id) ON TABLE auth.users TO ${role}; GRANT EXECUTE ON FUNCTION auth.uid(),auth.role(),auth.jwt() TO ${role};`);
 await psql(db.href,`CREATE TABLE IF NOT EXISTS public.snowglobe_builder_migrations(name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz DEFAULT now());`);
 return db.href;
}
export async function dispatch(req){
 if(req.protocol!=='snowglobe-builder-rpc-v1'||typeof req.id!=='string'||typeof req.projectId!=='string'||!/^local-builder$|^[a-f0-9-]{36}$/.test(req.projectId)||!Number.isInteger(req.vmGeneration))throw new Error('Invalid Supabase request envelope');
 if(!['backend.info','backend.migrate','backend.schema'].includes(req.op))throw new Error('Unsupported Supabase operation');
 const url=await connection();let result;
 if(req.op==='backend.info'){
  await configureAuth();
  const anonKey=process.env.ANON_KEY;let claims;try{claims=JSON.parse(Buffer.from(anonKey.split('.')[1],'base64url').toString());}catch{}
  if(claims?.role!=='anon')throw new Error('The Supabase stack did not provide a public anon key');
  result={anonKey,services:['auth','rest','postgres'],scope:'browser-local development'};
 }else if(req.op==='backend.schema'){
  const query=`SELECT json_build_object(
   'columns',COALESCE((SELECT json_agg(row_to_json(c)) FROM (SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name NOT LIKE 'snowglobe_builder_%' ORDER BY table_name,ordinal_position LIMIT 300) c),'[]'::json),
   'policies',COALESCE((SELECT json_agg(row_to_json(p)) FROM (SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' LIMIT 100) p),'[]'::json),
   'rls',COALESCE((SELECT json_agg(row_to_json(t)) FROM (SELECT c.relname AS table_name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT LIKE 'snowglobe_builder_%' LIMIT 100) t),'[]'::json)
  );`;
  result=JSON.parse(await psql(url,'BEGIN READ ONLY;\n'+query+'\nCOMMIT;'));
 }else if(req.op==='backend.migrate'){
  const {name,sql}=validateMigration(req.params);const hash=createHash('sha256').update(sql).digest('hex');
  const previous=await psql(url,`SELECT hash FROM public.snowglobe_builder_migrations WHERE name='${name}'`);
  if(previous&&previous!==hash)throw new Error('An applied migration cannot be changed. Add a new repair migration.');
  if(previous)result={name,unchanged:true};
  else{await psql(url,`BEGIN;\n${sql}\nINSERT INTO public.snowglobe_builder_migrations(name,hash) VALUES('${name}','${hash}');\nCOMMIT;\nNOTIFY pgrst,'reload schema';`);result={name,applied:true};}
 }else throw new Error('Unsupported Supabase operation');
 return {id:req.id,projectId:req.projectId,vmGeneration:req.vmGeneration,ok:true,result};
}
if(process.argv[2]==='--serve'){
 const {port}=JSON.parse(await fs.readFile(directory+'/auth-port.json','utf8'));
 Bun.serve({hostname:'0.0.0.0',port:54322,maxRequestBodySize:131072,idleTimeout:150,fetch:async request=>{
  const url=new URL(request.url),auth=/^\/auth\/v1\/(health|settings|signup|token|logout|user)$/.test(url.pathname),rest=/^\/rest\/v1\//.test(url.pathname);
  if(!auth&&!rest)return new Response('Not found',{status:404});
  const target=auth?'http://127.0.0.1:'+port+url.pathname.slice('/auth/v1'.length)+url.search:process.env.API_URL+url.pathname+url.search;
  const headers=new Headers(request.headers);headers.delete('host');
  try{return await fetch(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),signal:AbortSignal.timeout(130000),redirect:'manual'});}catch{return new Response('Local Supabase did not answer',{status:503});}
 }});
}else if(process.argv[2]){let heartbeat;try{const req=JSON.parse(await fs.readFile(process.argv[2],'utf8'));const progress=(stage,message)=>console.log('SG_BUILDER_PROGRESS '+JSON.stringify({id:req.id,projectId:req.projectId,vmGeneration:req.vmGeneration,stage,message}));progress('supabase-database',req.op==='backend.migrate'?'Applying your database migration':'Checking Supabase Auth and database configuration');heartbeat=setInterval(()=>progress('heartbeat','Supabase is working'),5000);console.log(JSON.stringify(await dispatch(req)));}catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}finally{clearInterval(heartbeat);}}
