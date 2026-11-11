// Gateway-only storage. Browser cookies are capabilities; only their hashes name files.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';

export function appendCookie(res,value){res.setHeader('Set-Cookie',[...(res.getHeader('Set-Cookie')?[res.getHeader('Set-Cookie')].flat():[]),value]);}
export class CredentialVaults {
 constructor(directory){this.directory=directory;this.chains=new Map();}
 async key(){
  return this.keyPromise??= (async()=>{
   await fs.mkdir(this.directory,{recursive:true,mode:0o700});await fs.chmod(this.directory,0o700);
   const name=path.join(this.directory,'master.key');
   try{await fs.writeFile(name,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
   await fs.chmod(name,0o600);const key=await fs.readFile(name);if(key.length!==32)throw Error('Invalid credential vault key');return key;
  })();
 }
 id(token){if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid credential profile');return createHash('sha256').update(token).digest('hex');}
 async read(token){
  const id=this.id(token),key=await this.key();let bytes;
  try{bytes=await fs.readFile(path.join(this.directory,id+'.vault'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(Buffer.from(id));cipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));
 }
 async modify(token,fn){
  const id=this.id(token),previous=this.chains.get(id)||Promise.resolve();
  const current=previous.catch(()=>{}).then(async()=>{
   const data=await fn(await this.read(token));if(!data)return;
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await this.key(),iv);cipher.setAAD(Buffer.from(id));
   const body=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]),temporary=path.join(this.directory,id+'.'+randomBytes(8).toString('hex')+'.tmp');
   try{await fs.writeFile(temporary,Buffer.concat([iv,cipher.getAuthTag(),body]),{mode:0o600,flag:'wx'});await fs.rename(temporary,path.join(this.directory,id+'.vault'));}finally{await fs.rm(temporary,{force:true});}
   return data;
  });this.chains.set(id,current);try{return await current;}finally{if(this.chains.get(id)===current)this.chains.delete(id);}
 }
 async identity(req,res,{ownerId,create=false,secure=true}={}){
  let token=/(?:^|;\s*)sg_builder_profile=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
  let data=token?await this.read(token):undefined;
  if(data&&ownerId&&data.ownerId!==ownerId){data=undefined;token=undefined;}
  if(!data&&create){token=randomBytes(32).toString('hex');data=await this.modify(token,()=>({version:1,ownerId,credentials:{}}));}
  if(!data)return;
  appendCookie(res,`sg_builder_profile=${token}; Path=/builder-api/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure?'; Secure':''}`);
  return {token,id:this.id(token),ownerId:data.ownerId};
 }
 store(token,type){
  const name=id=>id+':'+type;
  return {
   read:async id=>(await this.read(token))?.credentials[name(id)],
   list:async()=>Object.entries((await this.read(token))?.credentials||{}).filter(([id])=>id.endsWith(':'+type)).map(([id,value])=>({providerId:id.slice(0,-type.length-1),type:value.type})),
   modify:async(id,fn,{signal}={})=>{let result;await this.modify(token,async data=>{signal?.throwIfAborted();if(!data)throw Error('Credential profile is unavailable');const next=await fn(data.credentials[name(id)]);signal?.throwIfAborted();if(next)data.credentials[name(id)]=next;result=data.credentials[name(id)];return data;});return result;},
   delete:async id=>{await this.modify(token,data=>{if(data)delete data.credentials[name(id)];return data;});},
  };
 }
 modelsStore(token,type){
  const name=id=>id+':'+type;
  return {
   read:async id=>(await this.read(token))?.catalogs?.[name(id)],
   write:async(id,entry,{signal}={})=>{await this.modify(token,data=>{signal?.throwIfAborted();data.catalogs??={};data.catalogs[name(id)]=entry;return data;});},
   delete:async id=>{await this.modify(token,data=>{if(data?.catalogs)delete data.catalogs[name(id)];return data;});},
  };
 }
}
