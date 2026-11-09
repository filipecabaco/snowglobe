import {privatePathSegment} from './path-policy.js';
// This module is shared by the browser and guest. It never executes manifest strings.
export const PACKAGE_NAME=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const EXACT_VERSION=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export function validatePackages(packages){
 if(!packages||typeof packages!=='object'||Array.isArray(packages)||Object.keys(packages).length>60)throw new Error('Dependencies must be a bounded package/version map');
 for(const [name,version] of Object.entries(packages))if(name.length>214||!PACKAGE_NAME.test(name)||['constructor','prototype','__proto__'].includes(name)||typeof version!=='string'||!EXACT_VERSION.test(version))throw new Error('Use exact npm registry versions, for example package@1.2.3; URLs, tags, ranges and Git dependencies are unavailable');
 return packages;
}
export function validateInstallPackages(packages){
 validatePackages(packages);
 const count=Object.keys(packages).length;
 if(count<1||count>10)throw new Error('Install 1–10 pinned packages per request');
 return packages;
}
export function validateTemplate(value){
 if(!value||typeof value.id!=='string'||!/^[-a-z0-9]+$/.test(value.id)||typeof value.version!=='string'||!EXACT_VERSION.test(value.version)||value.runtime!=='node'||value.workspace!=='/workspace'||typeof value.entry!=='string'||!/^src\/[a-zA-Z0-9_+./-]+$/.test(value.entry)||value.entry.split('/').includes('..'))throw new Error('Invalid framework manifest');
 if(!['vite','sveltekit-static'].includes(value.scripts?.build)||!['tsc','svelte-check'].includes(value.scripts?.check)||!['vite-static','sveltekit-static'].includes(value.preview?.kind)||!['dist','build'].includes(value.preview?.outputDirectory))throw new Error('Unsupported framework command or preview adapter');
 if(value.install?.registry!=='https://registry.npmjs.org'||value.install.lifecycleScripts!==false||value.install.strategy!=='npm-ci-from-lockfile')throw new Error('Unsupported dependency policy');
 validatePackages(value.dependencies);validatePackages(value.devDependencies);
 if(!value.files||typeof value.files!=='object'||Object.keys(value.files).length>40)throw new Error('Invalid template sources');
 for(const [path,text] of Object.entries(value.files))if(path.length>256||/[\\\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||privatePathSegment(p)||['node_modules','.git'].includes(p))||typeof text!=='string'||text.length>32768)throw new Error('Invalid template source path/content');
 return value;
}
export function templateFor(catalog,id='react-vite'){
 if(catalog?.version!==1||!Array.isArray(catalog.templates))throw new Error('Unsupported template registry version');
 const matches=catalog.templates.filter(t=>t.id===id);if(matches.length!==1)throw new Error('Unknown or duplicate framework template');return validateTemplate(matches[0]);
}
export function templateSummary(template){return {id:template.id,version:template.version,displayName:template.displayName,status:template.status,entry:template.entry,preview:template.preview,backend:template.backend,capabilities:template.capabilities};}
export function packageManifest(template){
 validateTemplate(template);
 return {name:'app',private:true,type:'module',scripts:{build:'vite build',preview:'vite preview --host 127.0.0.1',check:template.scripts.check==='svelte-check'?'svelte-check --tsconfig ./tsconfig.json':'tsc --noEmit'},dependencies:{...template.dependencies},devDependencies:{...template.devDependencies}};
}
