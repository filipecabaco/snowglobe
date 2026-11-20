// One static server in the browser VM; the deployment pointer changes atomically.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.txt':'text/plain; charset=utf-8','.webmanifest':'application/manifest+json'};

export function rewritePaths(text,prefix) {
  const rewrite = (_match, start, url) => start+(url === prefix || url.startsWith(prefix+'/') ? url : prefix+url);
  return text.replace(/(\b(?:src|href|action|poster)\s*=\s*["'])(\/(?!\/)[^"']*)/gi, rewrite)
    .replace(/(url\(\s*["']?)(\/(?!\/)[^"')\s]*)/gi, rewrite);
}

export function createAppServer({base='/var/lib/snowglobe-apphost'} = {}) {
  return http.createServer(async (req,res) => {
    try {
      if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405, {Allow:'GET, HEAD'}).end(); return;}
      if (req.url === '/__apphost_health') {res.writeHead(200,{'Content-Type':'text/plain'}).end('App Host'); return;}
      const deployment = JSON.parse(await fs.readFile(path.join(base,'deployment.json'),'utf8'));
      let pathname;
      try {pathname = decodeURIComponent(new URL(req.url,'http://apphost').pathname);}
      catch {res.writeHead(400).end('Invalid URL'); return;}
      if (pathname.includes('\\') || pathname.includes('\0')) {res.writeHead(400).end('Invalid path'); return;}
      if (pathname === deployment.prefix || pathname.startsWith(deployment.prefix+'/')) pathname = pathname.slice(deployment.prefix.length) || '/';
      const root = await fs.realpath(deployment.root);
      let target = path.resolve(root,'.'+pathname);
      if (target !== root && !target.startsWith(root+path.sep)) {res.writeHead(403).end('Forbidden'); return;}
      // Source credentials and package metadata are never public static assets.
      if (pathname.split('/').some(p => p.startsWith('.') || p === 'node_modules') || /\/(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/.test(pathname)) {res.writeHead(404).end('Not found'); return;}
      let stat = await fs.stat(target).catch(()=>null);
      if (stat?.isDirectory()) {
        if (!pathname.endsWith('/')) {res.writeHead(301,{Location:pathname+'/'}).end(); return;}
        target = path.join(target,'index.html'); stat = await fs.stat(target).catch(()=>null);
      }
      if (!stat && deployment.spa && !path.extname(pathname)) {target = path.join(root,'index.html'); stat = await fs.stat(target);}
      if (!stat?.isFile()) {res.writeHead(404).end('Not found'); return;}
      const real = await fs.realpath(target);
      if (!real.startsWith(root+path.sep)) {res.writeHead(403).end('Forbidden'); return;}
      if (stat.size > (32 << 20)) {res.writeHead(413).end('Asset exceeds 32 MiB'); return;}
      const ext = path.extname(real).toLowerCase();
      let body = await fs.readFile(real);
      if (ext === '.html' || ext === '.css') body = Buffer.from(rewritePaths(body.toString('utf8'),deployment.prefix));
      res.writeHead(200,{'Content-Type':types[ext] || 'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-store'});
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {res.writeHead(error.code === 'ENOENT' ? 503 : 500).end(error.code === 'ENOENT' ? 'Build and deploy an app first.' : 'The app could not be served.');}
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) createAppServer().listen(4180,'0.0.0.0',()=>console.log('App Host listening on port 4180'));
