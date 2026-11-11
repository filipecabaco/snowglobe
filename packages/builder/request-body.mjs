// Decode only after collecting bounded bytes: a UTF-8 character can span chunks.
export async function readJsonBody(request,{maxBytes=1024*1024}={}){
 const chunks=[];let size=0;
 for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(bytes);}
 const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
 const value=JSON.parse(text||'{}');
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('Request must be a JSON object');
 return value;
}
