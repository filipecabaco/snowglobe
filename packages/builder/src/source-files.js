export const MAX_SOURCE_FILE_BYTES=256*1024;
// Recovery keeps UTF-8 text unchanged for backward compatibility. Other bytes
// use an explicit envelope, never a sentinel string that can collide with source.
export function fileBytes(value){
 if(typeof value==='string'){if(value.length>MAX_SOURCE_FILE_BYTES)throw Error('Source file exceeds size limits');const bytes=new TextEncoder().encode(value);if(bytes.length>MAX_SOURCE_FILE_BYTES)throw Error('Source file exceeds size limits');return bytes;}
 if(!value||value.encoding!=='base64'||typeof value.data!=='string'||Object.keys(value).sort().join(',')!=='data,encoding'||value.data.length>Math.ceil(MAX_SOURCE_FILE_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))throw new Error('Invalid source file encoding');
 const bytes=Uint8Array.from(atob(value.data),c=>c.charCodeAt(0));
 if(bytes.length>MAX_SOURCE_FILE_BYTES)throw Error('Source file exceeds size limits');
 if(bytesToBase64(bytes)!==value.data)throw new Error('Noncanonical source file encoding');return bytes;
}
function bytesToBase64(bytes){let encoded='';for(let i=0;i<bytes.length;i+=16384)encoded+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(encoded);}
export function sourceFile(bytes){
 try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(!bytes.includes(0))return text;}catch{}
 return {encoding:'base64',data:bytesToBase64(bytes)};
}
export const sameFile=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const fileDescription=value=>typeof value==='string'?value:'[Binary file: '+fileBytes(value).length+' bytes; base64: '+value.data+']';
