// Fingerprint current development inputs/output. This does not attest tests or
// turn an uncommitted worktree into a reproducible release commit.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),repository=path.resolve(root,'../..'),sources={},artifacts={};
async function inventory(directory,target,prefix=''){
 for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const relative=prefix+entry.name,full=path.join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Symlink in provenance inputs');if(entry.isDirectory()){if(['src','test','fixtures'].includes(entry.name)||prefix)await inventory(full,target,relative+'/');}else if(entry.isFile()&&/\.(?:js|mjs|cjs|json|html|css|jsx|ts|svelte|md)$/.test(entry.name)){const bytes=await fs.readFile(full);target[relative]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}}
}
await inventory(root,sources);await inventory(path.join(repository,'site/builder'),artifacts);
const git=args=>execFileSync('git',args,{cwd:repository,encoding:'utf8'}).trim();
console.log(JSON.stringify({status:'development-only',capturedAt:new Date().toISOString(),repositoryHead:git(['rev-parse','HEAD']),worktreeDirty:!!git(['status','--porcelain']),nodeVersion:process.version,sources,artifacts,scope:'Builder sources and site/builder artifacts only; excludes VM images/guest OS and does not attest release acceptance'},null,2));
