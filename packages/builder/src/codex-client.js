// Browser-side tool adapter. The Codex process owns authentication and its agent loop.
import {conversationText} from './conversation.js';
export class CodexAgent {
 constructor({model,post,execute,onText,onTool,projectId='local-builder'}){this.projectId=projectId;this.model=model;this.fresh=true;this.post=post;this.execute=execute;this.onText=onText;this.onTool=onTool;this.state={messages:[]};}
 async prompt(prompt){
  this.controller=new AbortController();const signal=this.controller.signal;
  const conversation=conversationText(this.state.messages);
  this.onText('',true);this.state.messages.push({role:'user',content:prompt});let text='',completed=false,writes=0;
  const response=await fetch('/builder-api/codex/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,model:this.model,thinking:this.thinking,newConversation:this.fresh,projectId:this.projectId,context:this.projectContext||'',conversation}),signal});
  if(!response.ok){const error=await response.json();throw new Error(error.error||'Codex connection failed');}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  try{for(;;){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.startsWith('data: '))continue;const event=JSON.parse(line.slice(6));signal.throwIfAborted();
    if(event.type==='text'){text+=event.delta;this.onText(event.delta);}
    if(event.type==='tool'){this.onTool(event.name);let result;try{result=await this.execute(event.name,event.args,signal);}catch(e){result={isError:true,error:e.message};}if(['vm_write_file','vm_edit_file','vm_remove_file'].includes(event.name)&&!result.isError&&!result.unchanged)writes++;signal.throwIfAborted();await this.post('codex/tool-result',{callId:event.callId,result});}
    if(event.type==='error')throw new Error(event.message);
    if(event.type==='done'){if(event.error||event.status!=='completed')throw new Error(event.error||'Codex task was interrupted');completed=true;}
   }if(done)break;}
   if(!completed)throw new Error('Codex disconnected before the task completed');
   if(!text.trim()&&!writes)throw new Error('Codex returned no response and made no project changes. Retry or reconnect.');
   this.fresh=false;this.state.messages.push({role:'assistant',content:[{type:'text',text}]});
  }finally{if(!completed)this.controller.abort();reader.releaseLock();}
 }
 abort(){this.controller?.abort();this.post('codex/cancel').catch(()=>{});}
}
