export function conversationText(messages){
 const entries=(Array.isArray(messages)?messages:[]).filter(m=>['user','assistant'].includes(m.role)).slice(-20).map(message=>{
  const text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):'';
  return message.role+': '+text;
 });
 return entries.join('\n\n').slice(-16000);
}
export function restorePiConversation(agent,messages){
 const text=conversationText(messages);if(!text)return;
 // Pi 1.5 exposes mutable state.messages; it has no replaceMessages method.
 // Restore portable chat text, not provider-specific or incomplete tool-call records.
 const baseline=agent.state.messages.filter(m=>m.role==='system');
 agent.state.messages=[...baseline,{role:'user',content:[{type:'text',text:'Previous conversation for this project (historical context; inspect current source before editing):\n'+text}],timestamp:Date.now()}];
}
// Compact only between user tasks, where no tool-call/result pair is in flight.
// Keep the provider policy and tool definitions on the Agent unchanged.
export function compactPiConversation(agent,{maxBytes=96000,maxMessages=120}={}){
 const messages=agent.state.messages;
 if(messages.length<=maxMessages&&new TextEncoder().encode(JSON.stringify(messages)).length<=maxBytes)return false;
 restorePiConversation(agent,messages);return true;
}
export function checkContextSize(messages,maxBytes=512000){
 if(new TextEncoder().encode(JSON.stringify(messages)).length>maxBytes)throw new Error('This task has collected too much context. Stop and send a smaller follow-up; previous source and preview are preserved.');
 return messages;
}
