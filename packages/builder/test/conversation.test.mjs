import {test} from 'node:test';import assert from 'node:assert/strict';import {Agent} from '@earendil-works/pi-agent-core';import {conversationText,restorePiConversation} from '../src/conversation.js';
test('restored conversation uses the pinned Pi state API and keeps its policy/tool baseline',()=>{
 const agent=new Agent({initialState:{systemPrompt:'Host policy',tools:[]},streamFn(){throw new Error('No inference in this test');}});
 const saved=[{role:'user',content:'Make a recipe app'},{role:'toolResult',content:[{type:'text',text:'private tool output'}]},{role:'assistant',content:[{type:'text',text:'Added search'}]}];
 restorePiConversation(agent,saved);assert.match(agent.state.systemPrompt,/Host policy/);assert.equal(agent.state.messages.at(-1).role,'user');assert.match(agent.state.messages.at(-1).content[0].text,/Added search/);assert(!conversationText(saved).includes('private tool output'));assert(conversationText([{role:'user',content:'x'.repeat(40000)}]).length<=16000);
});

test('between-task compaction bounds old tool output without changing policy or tools',async()=>{
 const {compactPiConversation,checkContextSize}=await import('../src/conversation.js');
 const agent=new Agent({initialState:{systemPrompt:'Persistent policy',tools:[]},streamFn(){throw Error('No inference');}});
 agent.state.messages=[...agent.state.messages,{role:'user',content:'Keep the recipe search'},{role:'toolResult',content:[{type:'text',text:'x'.repeat(100000)}]},{role:'assistant',content:[{type:'text',text:'Search is ready'}]}];
 assert.equal(compactPiConversation(agent),true);assert.equal(agent.state.systemPrompt,'Persistent policy');assert.match(conversationText(agent.state.messages),/recipe search/);assert(!JSON.stringify(agent.state.messages).includes('x'.repeat(100)));assert.equal(compactPiConversation(agent),false);
 const active=[{role:'assistant',content:[{type:'toolCall',id:'pair',name:'read_file',arguments:{}}]},{role:'toolResult',toolCallId:'pair',content:[{type:'text',text:'source'}]}];assert.equal(checkContextSize(active),active);assert.equal(active.length,2);assert.throws(()=>checkContextSize(active,2),/smaller follow-up/);
});
