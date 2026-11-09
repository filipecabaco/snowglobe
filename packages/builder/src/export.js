import {privatePathSegment} from './path-policy.js';
import {strToU8} from 'fflate';
import {fileBytes} from './source-files.js';
export async function exportFiles(data,{backend=false,exportedAt=new Date().toISOString()}={}){
 for(const name of Object.keys(data.files))if(!name||/[\\\x00-\x1f]/.test(name)||name.split('/').some(segment=>!segment||segment==='.'||segment==='..'||privatePathSegment(segment)||segment==='node_modules'))throw new Error('Source archive contains an excluded path');
 const files=Object.fromEntries(Object.entries(data.files).map(([name,value])=>[name,fileBytes(value)]));
 const reserved=['snowglobe-export.json','SNOWGLOBE-README.md'];
 if(reserved.some(name=>Object.hasOwn(files,name)))throw new Error('Rename reserved export files before exporting: '+reserved.join(', '));
 const inventory=[];
 for(const [name,bytes] of Object.entries(files).sort(([a],[b])=>a.localeCompare(b))){const digest=await crypto.subtle.digest('SHA-256',bytes);inventory.push({path:name,bytes:bytes.length,sha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')});}
 files['snowglobe-export.json']=strToU8(JSON.stringify({format:data.format,template:data.template,backend:backend?'supabase':'none',exportedAt,files:inventory},null,2));
 files['SNOWGLOBE-README.md']=strToU8(`# Exported from Snowglobe Builder

Use a current Node.js version satisfying package.json. In this directory run:

\`\`\`sh
npm ci
npm run build
npm run preview -- --host 127.0.0.1
\`\`\`

Read the localhost URL printed by the preview command. For development use
npm run dev. This archive includes the pinned lockfile and binary source assets.
The export manifest lists source byte lengths and SHA-256 hashes.

Deploy the built static output (${data.template==='sveltekit-spa'?'build/':'dist/'}) to a static host. ${data.template==='sveltekit-spa'?'This SvelteKit app uses hash routing; server rendering and server endpoints are unavailable.':'Configure your host to serve index.html for client-side routes if your app uses them.'}
Review application behavior and any external services before deployment.

This archive contains source, not VM state, database rows or Auth accounts.
Browser-local preview storage is not migrated to the exported app.
${backend?`\nCreate your own Supabase project. Review and apply supabase/migrations in filename
order using your database migration workflow. Configure VITE_SUPABASE_URL and
VITE_SUPABASE_ANON_KEY in your local environment before building. These are public
client settings: never use a service-role key. Configure Auth redirect URLs for
your deployed origin, review RLS policies, and test with separate users. The local
development stack's accounts, keys and data are not included.\n`:''}`);
 return files;
}
