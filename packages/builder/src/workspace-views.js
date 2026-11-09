let terminalAssets;
async function loadTerminal(base,doc){
 if(globalThis.Terminal&&globalThis.FitAddon)return;
 if(!terminalAssets)terminalAssets=(async()=>{
  if(base.origin!==location.origin)throw Error('Console assets must come from this Builder server');
  const css=doc.createElement('link');css.rel='stylesheet';css.href=new URL('xterm.css',base);doc.head.append(css);
  for(const name of ['xterm.js','addon-fit.js'])await new Promise((resolve,reject)=>{const script=doc.createElement('script');script.src=new URL(name,base);script.onload=resolve;script.onerror=()=>reject(Error('Could not load the console terminal'));doc.head.append(script);});
 })().catch(error=>{terminalAssets=null;throw error;});
 return terminalAssets;
}
export class WorkspaceViews{
 constructor({document:doc=document,onMode=()=>{},onConnect=()=>{},onDisconnect=()=>{},onInput=()=>{},onResize=()=>{}}={}){
  Object.assign(this,{doc,onMode,onConnect,onDisconnect,onInput,onResize});this.mode='builder';this.busy=false;this.ready=false;this.connected=false;
  for(const mode of ['builder','preview','console'])doc.getElementById('mode-'+mode).onclick=()=>this.setMode(mode);
  doc.getElementById('preview-full').onclick=()=>this.setMode(this.mode==='preview'?'builder':'preview');doc.getElementById('preview-exit').onclick=()=>this.setMode('builder');
  doc.getElementById('console-connect').onclick=()=>onConnect();doc.getElementById('console-disconnect').onclick=()=>onDisconnect();
  doc.getElementById('console-runtime').onchange=()=>{this.message(this.runtime==='supabase'?'Connect to inspect this project’s database. Use PostgreSQL to open psql.':'Connect to use Linux commands in /workspace.');if(this.mode==='console'&&this.connected)onConnect();};
  doc.getElementById('console-psql').onclick=()=>{if(this.connected&&this.runtime==='supabase'&&!this.busy){onInput('psql "$DB_URL"\r');this.term?.focus();}};
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.mode==='preview'){event.preventDefault();this.setMode('builder');doc.getElementById('preview-full').focus();}});
  this.update();
 }
 get runtime(){return this.doc.getElementById('console-runtime').value;}
 setMode(mode){if(!['builder','preview','console'].includes(mode)||this.mode===mode)return;this.mode=mode;this.doc.body.dataset.mode=mode;this.doc.getElementById('vm-console').hidden=mode!=='console';for(const name of ['builder','preview','console'])this.doc.getElementById('mode-'+name).setAttribute('aria-pressed',String(name===mode));this.doc.getElementById('preview-full').setAttribute('aria-pressed',String(mode==='preview'));this.doc.getElementById('preview-exit').hidden=mode!=='preview';this.update();this.onMode(mode);this.fitTerminal();}
 configure({ready=this.ready,busy=this.busy,database=true}={}){this.ready=ready;this.busy=busy;this.doc.querySelector('#console-runtime option[value="supabase"]').disabled=!database;if(!database&&this.runtime==='supabase')this.doc.getElementById('console-runtime').value='web';this.update();}
 update(){const disabled=!this.ready||this.busy;this.doc.getElementById('console-connect').disabled=disabled;this.doc.getElementById('console-runtime').disabled=disabled;this.doc.getElementById('console-disconnect').disabled=!this.connected&& !this.busy;this.doc.getElementById('console-psql').disabled=disabled||!this.connected||this.runtime!=='supabase';if(this.term)this.term.options.disableStdin=disabled||!this.connected||this.mode!=='console';}
 message(text){this.doc.getElementById('console-state').textContent=text;}
 setConnected(value){this.connected=value;this.update();}
 async openTerminal(base){
  if(!this.term){await loadTerminal(base,this.doc);if(!this.term){this.term=new globalThis.Terminal({cursorBlink:true,scrollback:5000,fontSize:14,fontFamily:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',theme:{background:'#101b18',foreground:'#e7efe8'},disableStdin:true});this.fit=new globalThis.FitAddon.FitAddon();this.term.loadAddon(this.fit);this.term.open(this.doc.getElementById('console-terminal'));this.term.onData(data=>{if(this.mode==='console'&&this.connected&&!this.busy)this.onInput(data);});this.observer=new ResizeObserver(()=>this.fitTerminal());this.observer.observe(this.doc.getElementById('console-terminal'));}}
  this.fitTerminal();this.term.focus();
 }
 fitTerminal(){if(!this.term||this.mode!=='console')return;requestAnimationFrame(()=>{if(this.mode!=='console')return;this.fit.fit();if(this.term.cols>500||this.term.rows>300)this.term.resize(Math.min(500,this.term.cols),Math.min(300,this.term.rows));this.onResize(this.term.cols,this.term.rows);});}
 get size(){return {cols:this.term?.cols||80,rows:this.term?.rows||24};}
 write(bytes){this.term?.write(bytes);}
 reset(){this.term?.reset();}
}
