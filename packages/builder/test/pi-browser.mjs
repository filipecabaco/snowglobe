// Actual browser bundle and Pi loop; fixture model, no provider credentials.
import {chromium,firefox,webkit} from '../../../bench/node_modules/playwright/index.mjs';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {openFixture} from './browser-fixture.mjs';
const contents=`import {Agent} from '@earendil-works/pi-agent-core';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {obj,str} from '@earendil-works/pi-schema';
window.piProof=async()=>{
 let turns=0,read=false,cancelled=false;const events=[];
 const model={id:'fixture',api:'openai-responses',provider:'openai',name:'fixture',baseUrl:'https://unused.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 const streamFn=()=>{const stream=createAssistantMessageEventStream(),n=turns++,reason=n===1||n>2?'stop':'toolUse',content=n===1||n>2?[{type:'text',text:'Read the source.'}]:[{type:'toolCall',id:'call-'+n,name:n===0?'read_file':'wait_for_stop',arguments:{path:'src/App.jsx'}}],message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage,stopReason:reason,content};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason,message});stream.end();});return stream;};
 const agent=new Agent({initialState:{model,tools:[{name:'read_file',label:'Read',description:'Read source',parameters:obj({path:str()}),execute:async(_id,p)=>{read=p.path==='src/App.jsx';return {content:[{type:'text',text:'source'}],details:{}};}},{name:'wait_for_stop',label:'Wait',description:'Cancellation proof',parameters:obj({path:str()}),execute:async(_id,_p,signal)=>new Promise(resolve=>{const stop=()=>{cancelled=true;resolve({content:[{type:'text',text:'cancelled'}],details:{}});};if(signal.aborted){stop();return;}signal.addEventListener('abort',stop,{once:true});setTimeout(()=>agent.abort(),10);})}]},streamFn});
 agent.subscribe(e=>events.push(e.type));await agent.prompt('Read the file');const text=agent.state.messages.at(-1).content[0].text;await agent.prompt('Wait, then stop');return {read,text,cancelled,events};
};`;
const result=await build({stdin:{contents,resolveDir:new URL('..',import.meta.url).pathname},bundle:true,write:false,platform:'browser',format:'esm'});
for(const [name,type,options] of [['Chromium',chromium,{args:['--no-sandbox']}],['Firefox',firefox,{...(process.env.BUILDER_FIREFOX_BIN?{executablePath:process.env.BUILDER_FIREFOX_BIN}:{})}],['WebKit',webkit,{...(process.env.BUILDER_WEBKIT_BIN?{executablePath:process.env.BUILDER_WEBKIT_BIN}:{})}]]){
 const browser=await type.launch({headless:true,...options});try{const page=await browser.newPage();await openFixture(page);await page.evaluate(async source=>{await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));},result.outputFiles[0].text);const proof=await page.evaluate(()=>Promise.race([piProof(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Pi browser proof timed out')),15000))]));assert.equal(proof.read,true);assert.equal(proof.text,'Read the source.');assert.equal(proof.cancelled,true);assert(proof.events.includes('tool_execution_end'));assert(proof.events.includes('agent_end'));console.log('PASS',name,'real Pi browser bundle, model stream, tool execution and cancellation');}finally{await browser.close();}
}
