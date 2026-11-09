import {randomUUID,randomBytes} from 'node:crypto';
import {createModels,getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import {builtinProviders} from '@earendil-works/pi-ai/providers/all';
import {personalizeOpenRouterCatalog} from '@earendil-works/pi-ai/providers/openrouter';
import {sessionBudget} from './session-budget.mjs';

// No gateway process environment, SDK profiles or host credential files are offered to users.
const isolatedAuth={env:async()=>undefined,fileExists:async()=>false};
const fail=(message,status=400)=>Object.assign(new Error(message),{status,public:true});
function builderProviders(){
 return builtinProviders().map(provider=>{
  if(provider.id!=='openrouter')return provider;
  let personalized;return {...provider,getModels:()=>personalized??provider.getModels(),async refreshModels(context){
   if(context.stored)await context.publish({update:()=>{personalized=context.stored.models;}});
   if(!context.allowNetwork)return;
   const models=await personalizeOpenRouterCatalog(provider.getModels(),context);
   await context.publish({persist:{models,checkedAt:Date.now()},update:()=>{personalized=models;}});
  }};
 });
}
export function publicModel(model){
 const {id,name,api,provider,baseUrl,reasoning,input,cost,contextWindow,maxTokens}=model;
 return {id,name,api,provider,baseUrl,reasoning,input,cost,contextWindow,maxTokens,thinkingLevels:getSupportedThinkingLevels(model)};
}
export class ProviderConnections {
 constructor({vaults,providers=builderProviders,limits={},stream,quotas,users}={}){this.vaults=vaults;this.providers=providers;this.limits=limits;this.stream=stream;this.quotas=quotas;this.users=users;this.profiles=new Map();}
 async profile(identity){
  let profile=this.profiles.get(identity.id);if(profile){profile.lastUsed=Date.now();await profile.ready;return profile;}
  if(this.profiles.size>=50)throw fail('Too many active provider connections. Retry later.',429);
  profile={identity,collections:{},budget:sessionBudget(this.limits),lastUsed:Date.now()};
  for(const type of ['api_key','oauth']){
   const models=createModels({credentials:this.vaults.store(identity.token,type),modelsStore:this.vaults.modelsStore(identity.token,type),authContext:isolatedAuth});
   for(const provider of this.providers())models.setProvider(provider);profile.collections[type]=models;
  }
  this.profiles.set(identity.id,profile);profile.ready=Promise.all(Object.values(profile.collections).map(models=>models.refresh({allowNetwork:false})));await profile.ready;return profile;
 }
 catalog(profile){return (profile?.collections.api_key.getProviders()||this.providers()).map(p=>({id:p.id,name:p.name,chat:!!p.getModels().length||!!p.refreshModels,methods:[...(p.auth.apiKey?.login?[{type:'api_key',label:p.auth.apiKey.name}]:[]),...(p.auth.oauth?[{type:'oauth',label:p.auth.oauth.loginLabel||p.auth.oauth.name,subscription:!!p.auth.oauth.isSubscription}]:[])]}));}
 connection(profile,id){
  if(typeof id!=='string')throw fail('Choose a saved provider connection');
  const [provider,type,...rest]=id.split(':');const models=profile.collections[type];
  if(rest.length||!models||!models.getProvider(provider))throw fail('Unknown provider connection');return {provider,type,models};
 }
 async status(profile){
  const connections=[];
  for(const [type,models] of Object.entries(profile.collections))for(const credential of await this.vaults.store(profile.identity.token,type).list()){
   const provider=models.getProvider(credential.providerId);if(!provider)continue;
   const available=await models.getAvailable(provider.id);
   connections.push({id:provider.id+':'+type,provider:provider.id,name:provider.name,type,subscription:type==='oauth'&&!!provider.auth.oauth?.isSubscription,models:available.map(publicModel)});
  }
  return {providers:this.catalog(profile),connections,login:this.loginState(profile),persistence:'gateway-encrypted'};
 }
 loginState(profile){
  const job=profile.login;if(!job)return null;
  return {id:job.id,connectionId:job.connectionId,state:job.state,events:job.events,prompt:job.prompt,error:job.error};
 }
 async start(profile,{provider:providerId,type}){
  const {models,provider}=this.connection(profile,providerId+':'+type),definition=models.getProvider(provider);
  if(!['api_key','oauth'].includes(type)||!definition.auth[type==='api_key'?'apiKey':'oauth']?.login)throw fail('This provider does not support that sign-in method');
  if(profile.controller)throw fail('Stop the current AI request before changing connections',409);
  if(profile.login?.state==='pending')throw fail('Finish or cancel the current provider sign-in first',409);
  const controller=new AbortController(),job={id:randomBytes(16).toString('hex'),connectionId:provider+':'+type,state:'pending',events:[],controller};profile.login=job;
  const timer=setTimeout(()=>controller.abort(),15*60*1000);timer.unref();
  const prompt=async supplied=>{
   controller.signal.throwIfAborted();
   // These Pi options refer to the gateway host, not the user's computer.
   if(provider==='amazon-bedrock'&&supplied.type==='select'&&supplied.options.some(o=>o.id==='aws-profile'))return 'bearer-token';
   if(provider==='google-vertex'&&supplied.type==='select'&&supplied.options.some(o=>o.id==='adc'))return 'api-key';
   const signal=supplied.signal?AbortSignal.any([supplied.signal,controller.signal]):controller.signal;
   signal.throwIfAborted();
   const {signal:_,...view}=supplied;const id=randomBytes(12).toString('hex');job.prompt={...view,id};
   return new Promise((resolve,reject)=>{
    const clear=()=>{signal.removeEventListener('abort',abort);if(job.prompt?.id===id)job.prompt=null;job.answer=null;};
    const abort=()=>{clear();reject(signal.reason||Error('Sign-in cancelled'));};
    job.answer=value=>{if(supplied.type==='select'&&!supplied.options.some(o=>o.id===value))throw fail('Choose one of the offered options');clear();resolve(value);};
    signal.addEventListener('abort',abort,{once:true});
   });
  };
  job.finished=(async()=>{
   // Stage login separately: cancellation or failed setup never replaces working credentials.
   const interaction={signal:controller.signal,prompt,notify:event=>{if(job.events.length>=20)job.events.shift();job.events.push(event);}};
   const credential=await definition.auth[type==='api_key'?'apiKey':'oauth'].login(interaction,{getDeviceId:()=>profile.identity.deviceId,agentName:'Snowglobe Builder'});
   if(type==='api_key'&&(!credential.key||credential.key.length>16384))throw fail('Enter a valid API key or bearer token');
   if(provider==='azure'){
    const resource=await prompt({type:'text',message:'Enter your Azure OpenAI resource name (the name before .openai.azure.com)'});
    if(!/^[a-zA-Z0-9-]{1,63}$/.test(resource))throw fail('Invalid Azure resource name');
    const mapping=await prompt({type:'text',message:'Azure deployment mapping (optional: model-id=deployment-name, separated by commas)'});
    credential.env={...credential.env,AZURE_OPENAI_BASE_URL:'https://'+resource+'.openai.azure.com/openai/v1',AZURE_OPENAI_RESOURCE_NAME:resource,AZURE_OPENAI_DEPLOYMENT_NAME_MAP:mapping};
   }
   if(provider==='amazon-bedrock'){
    const region=await prompt({type:'text',message:'Enter your AWS region (for example us-east-1)'});
    if(!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))throw fail('Invalid AWS region');credential.env={...credential.env,AWS_REGION:region,AWS_BEDROCK_SKIP_AUTH:'0'};
   }
   controller.signal.throwIfAborted();
   await this.vaults.store(profile.identity.token,type).modify(provider,async()=>credential,{signal:controller.signal});
   const result=await models.refresh({providers:[provider],signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
   if(result.errors.size)job.events.push({type:'info',message:'Connection saved. The model catalog could not refresh; use Refresh models to retry.'});
   job.state='completed';
  })().catch(error=>{job.state=controller.signal.aborted?'cancelled':'failed';job.error=error.public?error.message:'Provider sign-in failed. Retry and check your provider account and authorization.';}).finally(()=>{clearTimeout(timer);job.prompt=null;job.answer=null;});
  return this.loginState(profile);
 }
 async select(profile,{connectionId,model:id,thinking='off'}){
  const {models,provider}=this.connection(profile,connectionId);
  const model=(await models.getAvailable(provider)).find(m=>m.id===id);
  if(!model)throw fail('Choose a model available through this saved connection');
  if(!getSupportedThinkingLevels(model).includes(thinking))throw fail('That thinking level is not supported by this model');
  return {model:publicModel(model),thinking,connectionId};
 }
 async route(profile,route,data,json,res,proxyEvent){
  if(route==='/providers/status')return json(200,await this.status(profile));
  if(route==='/providers/login/start')return json(200,await this.start(profile,data));
  if(route==='/providers/login/status')return json(200,{login:this.loginState(profile)});
  if(route==='/providers/login/respond'){
   const job=profile.login;
   if(job?.state!=='pending'||job.id!==data.id||job.prompt?.id!==data.promptId||!job.answer)throw fail('This sign-in step expired. Check connection status and try again.');
   if(typeof data.value!=='string'||data.value.length>16384)throw fail('Sign-in response is too large');
   job.answer(data.value);return json(200,{ok:true});
  }
  if(route==='/providers/login/cancel'){if(profile.login?.id===data.id)profile.login.controller.abort();return json(200,{ok:true});}
  if(route==='/providers/select')return json(200,await this.select(profile,data));
  if(route==='/providers/refresh'){
   const {models,provider}=this.connection(profile,data.connectionId);const result=await models.refresh({providers:[provider],force:true,signal:AbortSignal.timeout(30000)});
   return json(200,{...await this.status(profile),warning:result.errors.size?'The provider catalog could not refresh. Showing the last available models.':undefined});
  }
  if(route==='/providers/forget'){
   if(profile.controller)throw fail('Stop the current AI request before forgetting a connection',409);
   const {models,provider}=this.connection(profile,data.connectionId);
   if(profile.login?.connectionId===data.connectionId){profile.login.controller.abort();await profile.login.finished;}
   await models.logout(provider);await this.vaults.modelsStore(profile.identity.token,data.connectionId.split(':')[1]).delete(provider);return json(200,await this.status(profile));
  }
  if(route==='/providers/usage')return json(200,{...profile.budget.view(),engine:'pi',metering:profile.subscription?'request-count-only':'catalog-estimate',userUsage:this.users?this.quotas.view(profile.identity.ownerId):undefined});
  const match=/^\/providers\/([^/]+)\/api\/stream$/.exec(route);
  if(!match)throw fail('Unknown provider route',404);
  if(profile.controller)throw fail('A provider request is already running',409);
  // Reserve before any auth/catalog awaits so simultaneous tabs cannot both enter.
  const controller=profile.controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);res.on('close',()=>controller.abort());
  let reservation,usage,started=false;
  const emit=event=>{if(!res.destroyed)res.write('data: '+JSON.stringify(event)+'\n\n');};
  try{
   const connectionId=decodeURIComponent(match[1]),thinking=data.options?.reasoning||'off';
   const selected=await this.select(profile,{connectionId,model:data.model?.id,thinking});
   const {provider,type,models}=this.connection(profile,connectionId),model=models.getModel(provider,selected.model.id);
   if(!data.context||!Array.isArray(data.context.messages))throw fail('Invalid transcript');
   // Resolve/refresh under Pi's credential-store lock before charging a request.
   const auth=await models.getAuth(model,{signal:controller.signal});if(!auth)throw fail('Reconnect this provider in AI settings',401);
   controller.signal.throwIfAborted();
   const subscription=type==='oauth'&&!!models.getProvider(provider).auth.oauth?.isSubscription,maxTokens=Math.min(model.maxTokens||4096,16384);
   try{profile.budget.begin(subscription?{}:{model,context:data.context,maxOutputTokens:maxTokens});if(this.users)reservation=this.quotas.begin(profile.identity.ownerId,subscription?'codex':'api',subscription?{}:{model,context:data.context,maxOutputTokens:maxTokens});}catch(error){throw fail(error.message,error.status||429);}
   profile.subscription=subscription;started=true;
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
   // Client headers, endpoints, model objects and arbitrary stream options are never forwarded.
   const options={...auth.auth,env:auth.env,signal:controller.signal,maxTokens,reasoning:thinking==='off'?undefined:thinking};
   const events=this.stream?this.stream(model,data.context,options):models.streamSimple(model,data.context,{signal:controller.signal,maxTokens,reasoning:options.reasoning});
   for await(const event of events){if(event.type==='done'||event.type==='error')usage=(event.message??event.error)?.usage;if(res.destroyed)break;emit(proxyEvent(event));}
  }catch(error){if(!res.headersSent)throw error;emit({type:'error',reason:controller.signal.aborted?'aborted':'error',errorMessage:controller.signal.aborted?'Provider request stopped or timed out.':'Provider unavailable. Check your connection, authorization, billing, and model access.'});}
  finally{if(started)profile.budget.record(usage);this.quotas?.finish(reservation,usage);clearTimeout(timer);profile.controller=null;if(res.headersSent)res.end();}
 }
 sweep(){for(const [id,p] of this.profiles)if(Date.now()-p.lastUsed>3600000&&!p.controller&&p.login?.state!=='pending')this.profiles.delete(id);}
 async dispose(){for(const p of this.profiles.values()){p.controller?.abort();p.login?.controller.abort();await p.login?.finished;}this.profiles.clear();}
 async device(identity){
  let data=await this.vaults.read(identity.token);if(!data.deviceId)data=await this.vaults.modify(identity.token,data=>{data.deviceId??=randomUUID();return data;});identity.deviceId=data.deviceId;return identity;
 }
}
