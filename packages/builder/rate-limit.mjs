// Fixed-window admission limits for unauthenticated credential/session creation.
// No keys, account identifiers or request bodies are retained.
export function admissionLimiter({limit=10,windowMs=60000,maxClients=1000,now=Date.now}={}){
 const clients=new Map();
 return address=>{
  const time=now();
  for(const [key,value] of clients)if(value.until<=time)clients.delete(key);
  const key=address||'unknown';let entry=clients.get(key);
  if(!entry){if(clients.size>=maxClients)return false;entry={count:0,until:time+windowMs};clients.set(key,entry);}
  if(entry.count>=limit)return false;
  entry.count++;return true;
 };
}
