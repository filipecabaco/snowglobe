import {test} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import fs from 'node:fs/promises';import {createHash} from 'node:crypto';
test('provenance inventory fingerprints the actual inputs and fails closed on review issues',async()=>{
 const result=spawnSync(process.execPath,[new URL('../audit.mjs',import.meta.url).pathname],{encoding:'utf8',maxBuffer:4*1024*1024,timeout:10000});assert.equal(result.error,undefined);
 const report=JSON.parse(result.stdout);assert.equal(result.status,report.issues.length?1:0);assert(report.packages.length>0);assert.match(report.scope,/excludes guest OS/);
 for(const name of ['package-lock.json','templates.json','template-locks.json']){const bytes=await fs.readFile(new URL('../'+name,import.meta.url));assert.equal(report.fingerprints[name],createHash('sha256').update(bytes).digest('hex'));}
 for(const issue of report.issues)assert(report.packages.some(pkg=>pkg.scope===issue.scope&&pkg.location===issue.location),'every issue must identify a real inventory entry');
});
