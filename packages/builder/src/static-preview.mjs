import {embedPreviewAssets} from './preview-assets.mjs';
// Static SvelteKit SPA output is repackaged, not executed in the host page.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
export async function buildKit(root,onProgress=()=>{}){
 onProgress('compiler-start','Compiling the SvelteKit static application');
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build'],{cwd:root,detached:true,env:{...process.env,NODE_OPTIONS:process.env.NODE_OPTIONS||'--max-old-space-size=256'},stdio:['ignore','pipe','pipe']});let output='',timedOut=false;
  const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
  process.once('SIGINT',kill);process.once('SIGTERM',kill);
  const timer=setTimeout(()=>{timedOut=true;kill();},600000),heartbeat=setInterval(()=>onProgress('heartbeat','The SvelteKit compiler is running'),2500);
  const cleanup=()=>{clearTimeout(timer);clearInterval(heartbeat);process.removeListener('SIGINT',kill);process.removeListener('SIGTERM',kill);};
  const capture=chunk=>{const text=chunk.toString();output=(output+text).slice(-12000);onProgress('compiler-output','SvelteKit is compiling',{log:text.slice(-1000)});};child.stdout.on('data',capture);child.stderr.on('data',capture);
  child.once('error',()=>{cleanup();reject(new Error('SvelteKit compiler could not start'));});child.once('close',code=>{cleanup();code===0?resolve({version:1,diagnostics:output,warm:false}):reject(new Error(timedOut?'SvelteKit compilation timed out':'SvelteKit compilation failed: '+output));});
 });
}
export async function kitPreview(root,{esbuildPath='/root/app/node_modules/esbuild/lib/main.js'}={}){
 const directory=path.join(root,'build'),files=[];
 async function walk(dir){const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Invalid static output directory');for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Symlink in static output');if(entry.isDirectory())await walk(file);else if(entry.isFile()){const stat=await fs.stat(file);if(stat.size>1024*1024||files.length>=300)throw new Error('Static output exceeds preview limits');files.push(file);}}}
 await walk(directory);let html=await fs.readFile(path.join(directory,'index.html'),'utf8');
 const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];if(!scripts.length)throw new Error('No static application startup script');
 const source=scripts.map(match=>match[1]).join('\n').replace(/\b(__sveltekit_[a-zA-Z0-9_]+)\s*=/g,'globalThis.$1 =');
 const esbuild=await import(pathToFileURL(esbuildPath).href);
 const result=await esbuild.build({stdin:{contents:source,resolveDir:directory,loader:'js'},bundle:true,write:false,outdir:path.join(directory,'.preview'),format:'iife',platform:'browser',target:'es2022',logLevel:'silent',plugins:[{name:'static-kit-output',setup(build){
  build.onResolve({filter:/^\/_app\//},args=>{const relative=args.path.slice(1);if(relative.includes('..')||relative.includes('\\'))throw new Error('Invalid static module path');return {path:path.join(directory,relative)};});
  build.onLoad({filter:/\.js$/},async args=>{const relative=path.relative(directory,args.path);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Static modules must stay inside build output');const stat=await fs.lstat(args.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new Error('Invalid static module');return {contents:(await fs.readFile(args.path,'utf8')).replace(/__vite__mapDeps\(\[[\d,\s]*\]\)/g,'[]'),loader:'js'};});
 }}]});
 const js=result.outputFiles.find(file=>file.path.endsWith('.js'))?.text;if(!js)throw new Error('Static application bundling failed');
 const css=(await Promise.all(files.filter(file=>file.endsWith('.css')).map(async file=>embedPreviewAssets(await fs.readFile(file,'utf8'),directory,{referenceFile:path.relative(directory,file).split(path.sep).join('/')})))).join('\n');
 html=html.replace(/<link\b[^>]*rel=["'](?:modulepreload|stylesheet)["'][^>]*>/gi,'');
 for(const script of scripts)html=html.replace(script[0],()=>script===scripts[0]?'<script>'+js.replace(/<\/script/gi,'<\\/script')+'</script>':'');
 html=html.replace('</head>',()=>'<style>'+css.replace(/<\/style/gi,'<\\/style')+'</style></head>');
 if(Buffer.byteLength(html)>800*1024)throw new Error('Static preview exceeds 800 KiB');
 return embedPreviewAssets(html,directory);
}
