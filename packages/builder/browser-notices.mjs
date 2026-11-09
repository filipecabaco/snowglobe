import fs from 'node:fs/promises';import path from 'node:path';
export async function browserNotices(metafile,output){
 const roots=new Set();for(const artifact of Object.values(metafile.outputs))for(const [input,info] of Object.entries(artifact.inputs||{})){
  if(!info.bytesInOutput)continue;const absolute=path.resolve(input),parts=absolute.split(path.sep),index=parts.lastIndexOf('node_modules');if(index<0)continue;const end=index+(parts[index+1]?.startsWith('@')?3:2);roots.add(parts.slice(0,end).join(path.sep));
 }
 const packages=[],issues=[];for(const root of [...roots].sort()){
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')),notices=[];
  for(const entry of (await fs.readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)))if(entry.isFile()&&/^(?:licen[sc]e|copying|notice|unlicense)(?:$|[._-])/i.test(entry.name)){
   const bytes=await fs.readFile(path.join(root,entry.name));if(bytes.length>256*1024)throw Error('Dependency notice exceeds limit');notices.push({file:entry.name,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)});
  }
  if(!notices.length)issues.push({name:pkg.name,version:pkg.version,reason:'No license/notice file found at installed package root'});
  packages.push({name:pkg.name,version:pkg.version,license:pkg.license||'UNKNOWN',notices});
 }
 const header='Third-party dependencies in the Snowglobe Builder browser bundle\n\nGenerated from installed, pinned package notices and esbuild output inputs.\nThis is not a license approval or a guest OS/VM dependency audit.\n';
 const text=header+packages.map(pkg=>'\n'+pkg.name+' '+pkg.version+'\nDeclared license: '+pkg.license+'\n'+(pkg.notices.length?pkg.notices.map(notice=>'\n--- '+notice.file+' ---\n'+notice.text).join('\n'):'NOTICE REVIEW REQUIRED: missing license text\n')).join('\n');
 await fs.writeFile(output,text);return {packages:packages.map(({notices,...pkg})=>({...pkg,noticeFiles:notices.map(n=>n.file)})),issues};
}
