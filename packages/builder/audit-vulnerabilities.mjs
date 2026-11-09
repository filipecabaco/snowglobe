// Query current npm advisories for the exact host and guest template lockfiles.
// Never installs packages or executes their lifecycle scripts.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
const run=promisify(execFile),root=new URL('./',import.meta.url),locks=JSON.parse(await fs.readFile(new URL('template-locks.json',root),'utf8')),builder=JSON.parse(await fs.readFile(new URL('package-lock.json',root),'utf8')),results=[];let failed=false;
for(const [scope,lock] of Object.entries({builder,...locks})){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'builder-advisories-'));
 try{
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:lock.name||'builder-audit',version:'0.0.0',private:true,...lock.packages['']}));await fs.writeFile(path.join(dir,'package-lock.json'),JSON.stringify(lock));
  let stdout;try{({stdout}=await run('npm',['audit','--json','--audit-level=high','--ignore-scripts','--registry=https://registry.npmjs.org','--userconfig=/dev/null'],{cwd:dir,timeout:120000,maxBuffer:2*1024*1024}));}catch(error){stdout=error.stdout;if(!stdout)throw error;}
  const audit=JSON.parse(stdout);if(audit.error||!audit.metadata?.vulnerabilities)throw Error('Advisory service did not return a complete report');const counts=audit.metadata.vulnerabilities;
  if(counts.high||counts.critical)failed=true;results.push({scope,lockSha256:createHash('sha256').update(JSON.stringify(lock)).digest('hex'),counts,vulnerabilities:audit.vulnerabilities});
 }catch(error){failed=true;results.push({scope,error:String(error.message).slice(0,300)});}finally{await fs.rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({format:'snowglobe-vulnerability-audit-v1',checkedAt:new Date().toISOString(),node:process.version,scope:'Pinned npm dependencies only; excludes guest OS/images and user-installed packages',results},null,2));process.exitCode=failed?1:0;
