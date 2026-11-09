import {createHash,timingSafeEqual} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest();
export function userAccess(configuration){
 if(configuration===undefined)return null;
 let value=configuration;if(typeof value==='string')try{value=JSON.parse(value);}catch{throw Error('Invalid gateway user-token configuration');}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length<1||Object.keys(value).length>100)throw Error('Configure 1–100 gateway users');
 const entries=[],seen=new Set();for(const [id,token] of Object.entries(value)){
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||typeof token!=='string'||token.length<32||token.length>512)throw Error('Invalid gateway user identity or token');const hash=digest(token),hex=hash.toString('hex');if(seen.has(hex))throw Error('Gateway users need distinct access tokens');seen.add(hex);entries.push({id,hash});
 }
 return {authenticate(token){const hash=digest(typeof token==='string'?token:'');let identity=null;for(const entry of entries)if(timingSafeEqual(hash,entry.hash))identity=entry.id;return identity;}};
}
