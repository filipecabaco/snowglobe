import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../gateway.mjs';
import {createProvider,envApiKeyAuth} from '@earendil-works/pi-ai';
export const fixtureUsage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export const fixtureModel=(provider,id='test-model',reasoning=true)=>({id,name:id,api:'openai-responses',provider,baseUrl:'https://provider.invalid',reasoning,thinkingLevelMap:reasoning?{off:null,xhigh:null,max:null}:undefined,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000});
export function fixtureProviders({refresh=()=>{}}={}){
 return ['first','second'].map(id=>createProvider({id,name:id,models:[fixtureModel(id),fixtureModel(id,'simple',false)],auth:{apiKey:envApiKeyAuth('Test key',['HOST_SECRET_MUST_NOT_BE_USED']),oauth:{name:'Test OAuth',isSubscription:true,async login(i){i.notify({type:'auth_url',url:'https://provider.invalid/authorize'});const code=await i.prompt({type:'manual_code',message:'Paste the callback code'});if(code!=='approved')throw Error('rejected secret-value');return {type:'oauth',access:'oauth-secret-initial',refresh:'refresh-secret',expires:0};},async refresh(c){refresh();return {...c,access:'oauth-secret-refreshed',refresh:'rotated-refresh-secret',expires:Date.now()+3600000};},async toAuth(c){return {apiKey:c.access};}}},api:{stream(){throw Error('inject stream');},streamSimple(){throw Error('inject stream');}}}));
}
export async function fixture(t,options={}){
 const directory=options.credentialDirectory||await fs.mkdtemp(path.join(os.tmpdir(),'builder-provider-test-'));if(!options.credentialDirectory)t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const server=createGateway({origin:'http://test.local',credentialDirectory:directory,providerFactory:fixtureProviders,...options});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await server.dispose();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port;
 const client=(initial='')=>{let cookie=initial;return {get cookie(){return cookie;},async post(route,data={},headers={}){const response=await fetch(base+route,{method:'POST',headers:{Origin:'http://test.local',Cookie:cookie,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0];cookie=cookie.split('; ').filter(p=>p.split('=')[0]!==pair.split('=')[0]).concat(pair).filter(Boolean).join('; ');}return response;},async json(route,data={},headers={}){const r=await this.post(route,data,headers),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;}};};
 return {server,base,client,directory};
}
export async function login(client,provider='first',type='api_key',value='fixture-key'){
 await client.json('/providers/open');const job=await client.json('/providers/login/start',{provider,type});let state;
 for(let n=0;n<30;n++){state=(await client.json('/providers/login/status')).login;if(state.prompt)break;await new Promise(r=>setTimeout(r,5));}
 assert(state.prompt);await client.json('/providers/login/respond',{id:job.id,promptId:state.prompt.id,value});
 for(let n=0;n<30;n++){state=(await client.json('/providers/login/status')).login;if(state.state!=='pending')break;await new Promise(r=>setTimeout(r,5));}assert.equal(state.state,'completed',state.error);return client.json('/providers/status');
}
