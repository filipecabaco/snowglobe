// In-memory limits for one authenticated gateway session. Prices are estimates
// from the pinned model catalog, not an invoice from the provider.
export function sessionBudget({maxRequests=100,maxTokens=250000,maxCostUsd=2}={}) {
 for(const n of [maxRequests,maxTokens,maxCostUsd])if(!Number.isFinite(n)||n<=0)throw new Error('Session limits must be positive finite numbers');
 if(!Number.isSafeInteger(maxRequests)||!Number.isSafeInteger(maxTokens))throw new Error('Request and token limits must be safe integers');
 let requests=0,tokens=0,costUsd=0,accountingComplete=true;
 return {
  begin({model,context,maxOutputTokens=4096}={}) {
   if(requests>=maxRequests||tokens>=maxTokens)throw new Error('Session usage limit reached. Reconnect to start a new session.');
   if(model){
    const input=Buffer.byteLength(JSON.stringify(context),'utf8'),prices=model.cost;
    if(!prices||![prices.input,prices.output].every(n=>Number.isFinite(n)&&n>=0))throw new Error('Model pricing unavailable; choose a model with catalog pricing');
    if(tokens+input+maxOutputTokens>maxTokens)throw new Error('Transcript exceeds the remaining session token budget');
    if(costUsd+(input*prices.input+maxOutputTokens*prices.output)/1e6>maxCostUsd)throw new Error('Estimated session spending limit reached. Reduce the transcript or reconnect.');
   }
   requests++;
  },
  record(usage) {
   // Missing usage (for example a disconnected stream) cannot be treated as free.
   const valid=usage&&Number.isFinite(usage.totalTokens)&&usage.totalTokens>=0&&Number.isFinite(usage.cost?.total)&&usage.cost.total>=0;
   if(!valid){tokens=maxTokens;accountingComplete=false;return;}
   tokens+=usage.totalTokens;costUsd+=usage.cost.total;
  },
  view(){return {requests,tokens,estimatedCostUsd:costUsd,accountingComplete,limits:{maxRequests,maxTokens,maxCostUsd}};}
 };
}
