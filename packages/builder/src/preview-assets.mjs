import fs from 'node:fs/promises';import path from 'node:path';
const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.mp3':'audio/mpeg','.wav':'audio/wav','.mp4':'video/mp4','.webm':'video/webm'};
// A blob preview has no project HTTP origin. Embed bounded built media assets so
// local URLs never resolve against Builder or require a privileged fetch bridge.
export async function embedPreviewAssets(html,directory,{referenceFile}={}){
 const assets=[];let total=0;
 async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Symlink in preview assets');if(entry.isDirectory())await walk(full);else if(entry.isFile()&&types[path.extname(entry.name).toLowerCase()]){const stat=await fs.lstat(full);if(stat.size>256*1024||(total+=stat.size)>600*1024||assets.length>=500)throw Error('Preview media exceeds asset limits');const bytes=await fs.readFile(full);assets.push({name:path.relative(directory,full).split(path.sep).join('/'),uri:'data:'+types[path.extname(entry.name).toLowerCase()]+';base64,'+bytes.toString('base64')});}}}
 await walk(directory);
 if(referenceFile)html=html.replace(/url\(\s*(["']?)([^"')\s]+)\1\s*\)/g,(match,_quote,ref)=>{
  if(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref))return match;
  const resolved=new URL(ref,'https://preview.invalid/'+referenceFile),asset=assets.find(item=>'/'+item.name===decodeURIComponent(resolved.pathname));
  return asset?'url("'+asset.uri+resolved.hash+'")':match;
 });

 for(const {name,uri} of assets){const relative=referenceFile?path.posix.relative(path.posix.dirname(referenceFile),name):name;for(const ref of new Set([name,'./'+name,'/'+name,relative,'./'+relative])){for(const quote of ['"',"'",'`'])html=html.split(quote+ref+quote).join(quote+uri+quote);html=html.split('url('+ref+')').join('url('+uri+')');}}
 if(Buffer.byteLength(html)>800*1024)throw Error('Preview with media exceeds 800 KiB');return html;
}
