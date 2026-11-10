const $=id=>document.getElementById(id);
const valueFor=(connectionId,id)=>JSON.stringify([connectionId,id]);
export class ProviderSettings {
 constructor({post,run,onPi,onCodex,onNativeConnect,preference=()=>null,onClear=()=>{}}){
  Object.assign(this,{post,run,onPi,onCodex,onNativeConnect,preference,onClear});this.connections=[];this.providers=[];this.busy=false;this.native=null;this.active=null;this.login=null;
  $('connection').onsubmit=e=>{e.preventDefault();const provider=$('provider').value,type=$('provider-method').value;void run(async()=>{if(type==='codex'){this.showLogin(null);return this.onNativeConnect();}$('codex-login').hidden=true;await this.open();const login=await post('providers/login/start',{provider,type});this.showLogin(login);this.poll();});};
  $('provider').onchange=()=>this.methods();
  $('model-filter').oninput=()=>this.models();
  $('model').onchange=()=>{const value=$('model').value;void run(()=>this.choose(value));};
  $('thinking').onchange=()=>{const value=$('model').value,thinking=$('thinking').value;void run(()=>this.choose(value,thinking));};
  $('provider-response').onsubmit=e=>{e.preventDefault();void run(async()=>{const value=this.login?.prompt?.type==='select'?$('provider-answer-select').value:$('key').value;$('key').value='';await post('providers/login/respond',{id:this.login.id,promptId:this.login.prompt.id,value});this.showLogin({...this.login,prompt:null});await this.check();this.poll();});};
  $('provider-login-check').onclick=()=>void run(()=>this.check());
  $('provider-login-cancel').onclick=()=>void run(async()=>{clearTimeout(this.timer);await post('providers/login/cancel',{id:this.login?.id});this.showLogin(null);});
 }
 async initialize({requiresAccessToken=false}={}){
  try{this.apply(await this.post('providers/status'));}catch{if(requiresAccessToken){this.apply(await this.post('providers/catalog'));$('provider-feedback').textContent='Enter the gateway access token, then Continue to unlock or add connections.';return;}await this.open();}
  const preferred=this.preference();const connection=this.connections.find(c=>c.id===(preferred?.connectionId||'openai:api_key'));
  if(preferred?.engine==='pi'&&connection?.models.some(m=>m.id===preferred.id))await this.choose(valueFor(connection.id,preferred.id),preferred.thinking);
  else if(!preferred&&!this.active&&this.connections.some(c=>c.models.length)){const c=this.connections.find(c=>c.models.length);await this.choose(valueFor(c.id,c.models[0].id));}
  else if(preferred&&!this.active)$('provider-feedback').textContent='The saved model connection is unavailable. Choose a connected model or sign in again.';
  if(this.login?.state==='pending')this.poll();
 }
 async open(){this.apply(await this.post('providers/open'));}
 apply(info){
  this.connections=info.connections||[];this.providers=info.providers||[];
  const selected=$('provider').value;$('provider').replaceChildren(...this.providers.map(p=>new Option(p.name+(p.chat?'':' · no coding models'),p.id)));if(this.providers.some(p=>p.id===selected))$('provider').value=selected;else if(this.providers.some(p=>p.id==='openai'))$('provider').value='openai';this.methods();this.renderConnections();this.models();if(info.login)this.showLogin(info.login);
 }
 methods(){const p=this.providers.find(p=>p.id===$('provider').value),current=$('provider-method').value,methods=p?.id==='openai'?[{type:'codex',label:'Sign in with ChatGPT (Codex)'},...p.methods.map(m=>m.type==='oauth'?{...m,label:'ChatGPT sign-in (Pi)'}:m)]:p?.methods||[];$('provider-method').replaceChildren(...methods.map(m=>new Option(m.label,m.type)));if(methods.some(m=>m.type===current))$('provider-method').value=current;$('connect').disabled=this.busy||!methods.length;}
 allConnections(){return [...(this.native?[{id:'codex',name:'ChatGPT (Codex)',type:'oauth',models:this.native.models.map(m=>({...m,thinkingLevels:m.thinkingLevels||['default']}))}]:[]),...this.connections];}
 models(){
  const filter=$('model-filter').value.trim().toLowerCase(),select=$('model'),current=this.active?valueFor(this.active.connectionId,this.active.id):select.value;const groups=[];
  for(const c of this.allConnections()){
   const models=c.models.filter(m=>(c.name+' '+m.name+' '+m.id).toLowerCase().includes(filter)||valueFor(c.id,m.id)===current);if(!models.length)continue;
   const group=document.createElement('optgroup');group.label=c.name+' · '+(c.type==='api_key'?'API key':'sign-in');group.append(...models.map(m=>new Option(m.name===m.id?m.id:m.name+' · '+m.id,valueFor(c.id,m.id))));groups.push(group);
  }
  select.replaceChildren(new Option(groups.length?'Choose a model':'Connect a provider first',''),...groups);select.value=current||'';select.disabled=this.busy||!groups.length;
  this.thinking();
  const c=this.allConnections().find(c=>c.id===this.active?.connectionId);$('model-description').textContent=c?c.name+' · '+(c.id==='codex'?'ChatGPT plan usage':c.type==='api_key'?'API billing':c.subscription===false?'provider account billing':'provider account / plan usage'):'';
 }
 thinking(){
  const m=this.active&&this.allConnections().find(c=>c.id===this.active.connectionId)?.models.find(m=>m.id===this.active.id);const levels=m?.thinkingLevels||['off'];
  $('thinking').replaceChildren(...levels.map(level=>new Option(level==='default'?'Provider default':level==='off'?'Off':level[0].toUpperCase()+level.slice(1),level)));$('thinking').value=levels.includes(this.active?.thinking)?this.active.thinking:levels[0];$('thinking').disabled=this.busy||levels.length<=1||!m;
 }
 async choose(value,thinking){
  if(!value)return;const [connectionId,id]=JSON.parse(value),connection=this.allConnections().find(c=>c.id===connectionId),model=connection?.models.find(m=>m.id===id);if(!model)throw Error('This model is no longer available. Refresh the connection.');
  const levels=model.thinkingLevels||['off'];thinking=levels.includes(thinking)?thinking:levels.includes(this.active?.thinking)?this.active.thinking:levels.includes('off')?'off':levels[0];
  if(connectionId==='codex')await this.onCodex(this.native,{id,thinking});
  else await this.onPi({...await this.post('providers/select',{connectionId,model:id,thinking}),connection});
  this.active={connectionId,id,thinking};this.models();$('provider-feedback').textContent='';
 }
 setNative(info,id,thinking='default'){this.native=info;this.active={connectionId:'codex',id,thinking};this.models();this.renderConnections();}
 clearNative(){this.native=null;if(this.active?.connectionId==='codex')this.active=null;this.models();this.renderConnections();}
 renderConnections(){
  const list=$('provider-connections');list.replaceChildren();
  const connections=this.allConnections();if(!connections.length)list.textContent='No saved connections yet.';
  for(const c of connections){
   const row=document.createElement('div'),label=document.createElement('div');row.dataset.connectionId=c.id;label.textContent=c.name+' · '+(c.type==='api_key'?'API key':'sign-in')+' · '+c.models.length+' models';row.append(label);
   for(const [text,action] of [['Refresh models','refresh'],['Forget connection','forget']]){const button=document.createElement('button');button.type='button';button.textContent=text;button.disabled=this.busy;button.onclick=()=>void this.run(async()=>{
    if(c.id==='codex'){
     if(action==='forget'){await this.post('disconnect');const active=this.active?.connectionId==='codex';this.clearNative();if(active)this.onClear();$('codex-login').hidden=true;return;}
     const info=await this.post('codex/status');if(!info.connected)throw Error('ChatGPT is signed out. Add the connection again.');this.native=info;this.renderConnections();this.models();
    }else{const info=await this.post('providers/'+action,{connectionId:c.id});this.apply(info);if(info.warning)$('provider-feedback').textContent=info.warning;}
    if(this.active?.connectionId===c.id&&!this.allConnections().find(connection=>connection.id===c.id)?.models.some(model=>model.id===this.active.id)){this.active=null;this.onClear();this.models();}
   });row.append(button);}list.append(row);
  }
 }
 showLogin(login){
  this.login=login;$('provider-login').hidden=!login;if(!login)return;
  $('provider-login-status').textContent=login.error||({pending:'Complete the provider sign-in below.',completed:'Connection saved.',cancelled:'Sign-in cancelled.',failed:'Sign-in failed.'}[login.state]||'');
  const container=$('provider-login-events');container.replaceChildren();
  for(const event of login.events||[]){
   const p=document.createElement('p');p.textContent=event.message||event.instructions||'';
   if(event.type==='device_code')p.textContent='Enter code '+event.userCode+' on the provider sign-in page.';
   const links=event.type==='auth_url'?[{url:event.url,label:'Open provider sign-in'}]:event.type==='device_code'?[{url:event.verificationUri,label:'Open provider sign-in'}]:event.links||[];
   for(const link of links){try{const url=new URL(link.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)continue;const a=document.createElement('a');a.href=url.href;a.textContent=link.label||'Provider instructions';a.target='_blank';a.rel='noopener noreferrer';p.append(document.createElement('br'),a);}catch{}}
   container.append(p);
  }
  const prompt=login.prompt;const changed=this.promptId!==prompt?.id;this.promptId=prompt?.id;$('provider-response').hidden=!prompt;
  if(prompt){
   $('provider-prompt-label').textContent=prompt.message;$('key').hidden=prompt.type==='select';$('provider-answer-select').hidden=prompt.type!=='select';$('provider-prompt-label').htmlFor=prompt.type==='select'?'provider-answer-select':'key';
   if(changed){$('key').value='';$('key').type=['secret','manual_code'].includes(prompt.type)?'password':'text';$('key').placeholder=prompt.placeholder||'';if(prompt.type==='select'){const options=[...prompt.options].sort((a,b)=>Number(/device|copy_code/.test(b.id))-Number(/device|copy_code/.test(a.id)));$('provider-answer-select').replaceChildren(...options.map(o=>new Option(o.label,o.id)));}}
  }
  $('provider-login-cancel').disabled=this.busy||login.state!=='pending';
 }
 async check(){
  const {login}=await this.post('providers/login/status');this.showLogin(login);
  if(login?.state==='completed'&&this.completedLogin!==login.id){this.apply(await this.post('providers/status'));const c=this.connections.find(c=>c.id===login.connectionId);if(c?.models.length)await this.choose(valueFor(c.id,c.models[0].id));else $('provider-feedback').textContent='Connection saved. This provider currently offers no chat models for Builder.';this.completedLogin=login.id;}
 }
 poll(){
  clearTimeout(this.timer);if(this.login?.state!=='pending')return;
  this.timer=setTimeout(async()=>{try{if(!this.busy)await this.run(()=>this.check());}catch{$('provider-feedback').textContent='Could not check sign-in. Use Check sign-in to retry.';}this.poll();},1200);
 }
 setBusy(busy){this.busy=busy;for(const id of ['provider','provider-method','connect','provider-answer','key','provider-answer-select','provider-login-check','provider-login-cancel'])$(id).disabled=busy;this.renderConnections();this.models();}
}
