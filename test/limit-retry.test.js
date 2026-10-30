import assert from 'node:assert/strict';
import { test } from 'node:test';
import extension, { isProviderLimitError, limitRetryOptions, planLimitRetry, waitForRetry } from '../extensions/recovery.js';
const model = {provider:'my_model_hub',api:'openai-responses'};
const providers=new Set([model.provider]);
const failure=(text='Requests have exceeded the throughput limit on your Provisioned-Managed deployment.')=>({id:'failed-1',type:'message',message:{role:'assistant',provider:model.provider,stopReason:'error',errorMessage:text,content:[]}});
const prior=[{id:'user',type:'message',message:{role:'user'}},{id:'tool',type:'message',message:{role:'toolResult',content:[{type:'text',text:'already executed'}]}}];
const event={outcome:'error',continue:false,entries:[]};
test('recognizes TPM, PTU and quota without requiring HTTP status',()=>{
 for(const text of ['TPM exceeded','tokens per minute exceeded',failure().message.errorMessage,'insufficient_quota','quota exceeded','exceeded your current quota','429 TooManyRequests'])assert.equal(isProviderLimitError(failure(text).message,model.provider),true,text);
 for(const text of ['billing quota exceeded','balance exhausted','401 unauthorized','invalid encrypted content','timeout'])assert.equal(isProviderLimitError(failure(text).message,model.provider),false,text);
 assert.equal(isProviderLimitError(failure().message,'other'),false);
});
test('preserves context and adds only a failed-attempt edit and durable retry marker',()=>{
 const branch=[...prior,failure()];const before=JSON.stringify(branch);
 const result=planLimitRetry(event,model,branch,providers);
 assert.equal(result.continue,true);assert.deepEqual(result.entries[0],{type:'context_edit',targetId:'failed-1',replacement:null});
 assert.equal(result.entries[1].type,'custom');assert.equal(result.entries[1].data.attempt,1);assert.equal(JSON.stringify(branch),before);
});
test('bounds retries and guards duplicate failures, abort, existing continuation, providers and tool calls',()=>{
 const result=planLimitRetry(event,model,[...prior,failure()],providers,{maxRetries:1,intervalMs:20});
 assert.equal(planLimitRetry(event,model,[...prior,result.entries[1],{...failure(),id:'failed-2'}],providers,{maxRetries:1,intervalMs:20}),undefined);
 assert.equal(planLimitRetry(event,model,[...prior,result.entries[1],failure()],providers),undefined);
 for(const e of [{...event,outcome:'aborted'},{...event,continue:true}])assert.equal(planLimitRetry(e,model,[...prior,failure()],providers),undefined);
 assert.equal(planLimitRetry(event,{...model,provider:'other'},[...prior,failure()],providers),undefined);
 const f=failure();f.message.content=[{type:'toolCall',id:'executed'}];assert.equal(planLimitRetry(event,model,[...prior,f],providers),undefined);
 assert.equal(planLimitRetry(event,model,[...prior,failure()],providers,{maxRetries:0,intervalMs:20}),undefined);
});
test('new user turn resets the limit-recovery budget',()=>{
 const marker=planLimitRetry(event,model,[...prior,failure()],providers).entries[1];
 const b=[...prior,marker,{type:'message',message:{role:'user'}},{...failure(),id:'failed-2'}];
 assert.equal(planLimitRetry(event,model,b,providers,{maxRetries:1,intervalMs:10}).entries[1].data.attempt,1);
});
test('configuration validates intervals and retry counts',()=>{
 assert.deepEqual(limitRetryOptions({}),{intervalMs:60000,maxRetries:5});
 assert.deepEqual(limitRetryOptions({PI_LIMIT_RETRY_INTERVAL_MS:'120000',PI_LIMIT_RETRY_MAX_RETRIES:'0'}),{intervalMs:120000,maxRetries:0});
 for(const env of [{PI_LIMIT_RETRY_INTERVAL_MS:'0'},{PI_LIMIT_RETRY_MAX_RETRIES:'-1'},{PI_LIMIT_RETRY_INTERVAL_MS:'oops'}])assert.throws(()=>limitRetryOptions(env));
});
test('provider boundary waits with live abort signal, consumes once and clears UI',async()=>{
 const hooks=new Map();const waited=[];const ui=[];const controller=new AbortController();
 extension({on(n,h){hooks.set(n,h)}},{env:{PI_LIMIT_RETRY_INTERVAL_MS:'123'},wait:async(ms,signal)=>waited.push([ms,signal])});
 const ctx={model,sessionManager:{getBranch:()=>[...prior,failure()],getSessionId:()=> 's1'},getSignal:()=>controller.signal,ui:{setStatus:(...v)=>ui.push(v)}};
 assert.equal(hooks.get('agent_before_settle')(event,ctx).continue,true);assert.equal(waited.length,0);
 await hooks.get('before_provider_request')({},ctx);await hooks.get('before_provider_request')({},ctx);
 assert.deepEqual(waited,[[123,controller.signal]]);assert.equal(ui.at(-1)[1],undefined);
});
test('actual wait aborts promptly and pre-aborted wait never sleeps',async()=>{
 const c=new AbortController();const p=waitForRetry(60000,c.signal);c.abort();await assert.rejects(p);
 await assert.rejects(waitForRetry(60000,c.signal));
 await waitForRetry(1,new AbortController().signal);
});
test('pending recovery is isolated by session and removed on shutdown',async()=>{
 const hooks=new Map();let calls=0;
 extension({on(n,h){hooks.set(n,h)}},{env:{},wait:async()=>calls++});
 const ctx=(s)=>({model,sessionManager:{getBranch:()=>[...prior,failure()],getSessionId:()=>s},getSignal:()=>new AbortController().signal});
 hooks.get('agent_before_settle')(event,ctx('a'));await hooks.get('before_provider_request')({},ctx('b'));assert.equal(calls,0);
 hooks.get('session_shutdown')({},ctx('a'));await hooks.get('before_provider_request')({},ctx('a'));assert.equal(calls,0);
});
