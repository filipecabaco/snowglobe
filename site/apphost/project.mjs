import {relativePath} from './environments.mjs';

export const limits = Object.freeze({files:2000, bytes:32 << 20, fileBytes:8 << 20, archiveBytes:8 << 20});
const ignored = new Set(['node_modules','.git','.hg','.svn','dist','build','coverage','.svelte-kit','.next','.nuxt','.cache','.turbo','.parcel-cache','.snowglobe','.DS_Store','.env','.npmrc','.yarnrc','.yarnrc.yml','.netrc','_netrc','.ssh','.aws','.azure','.gcloud','.gnupg','.git-credentials']);
export const excluded = path => path.split('/').some(part => ignored.has(part) || part.startsWith('.env.'));

export function sourcePath(path) {
  relativePath(path, {dot:false});
  if (excluded(path)) throw Error('Excluded project path: '+path);
  return path;
}

// Handles stay in this module's caller; reading never requests write permission.
export async function readFolder(handle, {signal, onProgress = () => {}} = {}) {
  const files = []; let bytes = 0, skipped = 0;
  async function walk(directory, prefix = '') {
    for await (const [name, entry] of directory.entries()) {
      signal?.throwIfAborted();
      const path = prefix+name;
      if (excluded(path)) {skipped++; continue;}
      sourcePath(path);
      if (entry.kind === 'directory') await walk(entry, path+'/');
      else if (entry.kind === 'file') {
        const file = await entry.getFile();
        if (file.size > limits.fileBytes) throw Error(path+' exceeds the 8 MiB file limit.');
        bytes += file.size;
        if (bytes > limits.bytes || files.length >= limits.files) throw Error('This folder exceeds 2,000 files or 32 MiB of source. Select a smaller app folder.');
        files.push({path, file});
        onProgress({files:files.length, bytes});
      }
    }
  }
  await walk(handle);
  if (!files.length) throw Error('This folder has no shareable files. Select the application folder, or select its built output folder directly.');
  files.sort((a,b) => a.path.localeCompare(b.path));
  const manifest = files.find(item => item.path === 'package.json');
  let pkg = null;
  if (manifest) {
    try {pkg = JSON.parse(await manifest.file.text());}
    catch {throw Error('package.json is not valid JSON. Fix it locally and refresh the folder.');}
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw Error('package.json must contain a package object.');
  }
  return {files, bytes, skipped, pkg, detection:detect(files.map(item => item.path), pkg)};
}

export function detect(paths, pkg) {
  const has = path => paths.includes(path);
  const dependencies = {...pkg?.dependencies, ...pkg?.devDependencies};
  for (const [name,label] of [['next','Next.js'],['@sveltejs/kit','SvelteKit'],['nuxt','Nuxt']]) if (Object.hasOwn(dependencies,name)) return {id:null, reason:label+' needs a server or a dedicated static export setup. It is not supported yet. You can share its exported static folder instead.'};
  if (pkg?.workspaces) return {id:null, reason:'Workspace installs are not supported yet. Select a standalone app or its exported static folder.'};
  if (pkg?.packageManager && !pkg.packageManager.startsWith('npm@')) return {id:null, reason:'This project specifies '+pkg.packageManager.split('@')[0]+'. The first environments use npm. Share a static export, or select an npm setup if the project supports it.'};
  if (!pkg) return has('index.html') ? {id:'static', reason:'Found index.html without a package manifest.'} : {id:null, reason:'No index.html or package.json found at this folder’s root. Select the app folder or choose a setup manually.'};
  if (Object.hasOwn(dependencies,'react-scripts')) return {id:'cra', reason:'Found react-scripts in package.json.'};
  if (Object.hasOwn(dependencies,'vite')) {
    const id = Object.hasOwn(dependencies,'svelte') ? 'svelte' : Object.hasOwn(dependencies,'react') ? 'react' : Object.hasOwn(dependencies,'vue') ? 'vue' : 'vite';
    return {id, reason:'Found '+(id === 'vite' ? 'Vite' : id+' and Vite')+' in package.json.'};
  }
  if (has('index.html') && !pkg.scripts?.build) return {id:'static', reason:'Found index.html and no build script.'};
  return {id:null, reason:'Could not identify a supported setup. Choose an environment and check its build script and output folder.'};
}

function base64(bytes) {
  let text = '';
  for (let i=0; i<bytes.length; i+=16384) text += String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(text);
}

export async function archiveProject(project, signal) {
  const files = [];
  for (const {path,file} of project.files) {
    signal?.throwIfAborted();
    files.push({path, data:base64(new Uint8Array(await file.arrayBuffer()))});
  }
  const stream = new Blob([JSON.stringify({version:1, files})]).stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(stream).blob();
  signal?.throwIfAborted();
  if (blob.size > limits.archiveBytes) throw Error('The compressed folder exceeds the 8 MiB transfer limit. Remove large assets and try again.');
  return blob;
}
