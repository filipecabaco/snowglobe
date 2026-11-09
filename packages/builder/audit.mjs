// Deterministic npm provenance inventory. This is not a legal or VM-image audit.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const inputs=['package-lock.json','template-locks.json','templates.json'];
const allowed=new Set(['MIT','ISC','Apache-2.0','BSD-2-Clause','BSD-3-Clause','0BSD','CC0-1.0','BlueOak-1.0.0','Python-2.0','(MIT OR CC0-1.0)','(MIT OR WTFPL)','(MIT AND Zlib)','(MIT OR Apache-2.0)']);
const fingerprints={},packages=[],issues=[];
for(const name of inputs){
 const bytes=await fs.readFile(path.join(root,name));fingerprints[name]=createHash('sha256').update(bytes).digest('hex');
 const value=JSON.parse(bytes);if(name==='templates.json')continue;
 const locks=name==='package-lock.json'?{builder:value}:value;
 for(const [scope,lock] of Object.entries(locks))for(const [location,pkg] of Object.entries(lock.packages||{})){
  if(!location)continue;
  let provenance=pkg,bundledBy;
  if(pkg.inBundle&&!pkg.resolved){let ancestor=location;while(ancestor.includes('/node_modules/')){ancestor=ancestor.slice(0,ancestor.lastIndexOf('/node_modules/'));const parent=lock.packages[ancestor];if(parent?.resolved){provenance=parent;bundledBy=ancestor;break;}}}
  const item={scope,location,version:pkg.version,license:pkg.license||'UNKNOWN',resolved:provenance.resolved,integrity:provenance.integrity,...(bundledBy?{bundledBy}:{})};packages.push(item);
  if(!provenance.resolved?.startsWith('https://registry.npmjs.org/')||!/^sha(256|384|512)-/.test(provenance.integrity||''))issues.push({scope,location,reason:'Unverified registry origin or integrity'});
  if(!allowed.has(item.license))issues.push({scope,location,reason:'License needs review: '+item.license});
 }
}
const artifacts={};
for(const name of (await fs.readdir(path.join(root,'../../site/builder'))).filter(name=>/\.(js|css|html)$/.test(name)).sort()){try{const bytes=await fs.readFile(path.join(root,'../../site/builder',name));artifacts[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}catch(error){if(error.code!=='ENOENT')throw error;issues.push({artifact:name,reason:'Build artifact missing'});}}
const report={nodeVersion:process.version,artifacts,format:'snowglobe-builder-npm-audit-v1',fingerprints,packages,issues,scope:'npm lockfiles only; excludes guest OS, downloaded VM images, user dependencies, and provider eligibility'};
process.stdout.write(JSON.stringify(report,null,2)+'\n');
if(issues.length)process.exitCode=1;
