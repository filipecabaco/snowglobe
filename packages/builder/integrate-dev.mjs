// Optional integration for this checkout's existing, ignored local server.
import fs from 'node:fs/promises';
const serverPath=new URL('../../.local-dev/server.mjs',import.meta.url);
const dispatcherPath=new URL('../../.local-dev/dispatcher.mjs',import.meta.url);
let server=await fs.readFile(serverPath,'utf8');
if(!server.includes("import { createGateway }")){
 server="import { createGateway } from '../packages/builder/gateway.mjs';\n"+server;
 server=server.replace('const server = http.createServer',"const builderGateway = createGateway();\nbuilderGateway.listen(18447,'127.0.0.1');\nconst server = http.createServer");
 server=server.replace("if (url.pathname === '/')",`if (url.pathname.startsWith('/builder-api/')) {
    const upstream=http.request({host:'127.0.0.1',port:18447,path:url.pathname.slice('/builder-api'.length),method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
    upstream.on('error',()=>fail(res,503,'Builder gateway unavailable'));res.on('close',()=>upstream.destroy());req.pipe(upstream);return;
  }
  if (url.pathname === '/')`);
 server=server.replace("if(ext==='.html') {let html=data.toString();","if(ext==='.html' && !url.pathname.startsWith('/builder/')) {let html=data.toString();");
 await fs.writeFile(serverPath,server);
}
let dispatcher=await fs.readFile(dispatcherPath,'utf8');
if(!dispatcher.includes("card('/builder/'")){
 dispatcher=dispatcher.replace("${card('/site/'", "${card('/builder/','Snowglobe Builder','Build apps in a browser VM. Try a counter without an AI key, or connect an API account for Pi chat.','Development')}\n ${card('/site/'");
 await fs.writeFile(dispatcherPath,dispatcher);
}
console.log('Builder routes installed. Restart .local-dev/dev.sh to load the gateway.');

let current=await fs.readFile(serverPath,'utf8');if(!current.includes('await builderGateway.dispose()')){current=current.replace("for(const p of children)p.kill('SIGTERM');await vite.close();","for(const p of children)p.kill('SIGTERM');await builderGateway.dispose();builderGateway.close();await vite.close();");await fs.writeFile(serverPath,current);}
