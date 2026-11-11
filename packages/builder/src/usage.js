function sessionUsageLabel(usage){
 if(!usage||!Number.isSafeInteger(usage.requests)||usage.requests<0||!Number.isFinite(usage.limits?.maxRequests))return 'Usage unavailable';
 const requests=usage.requests+' / '+usage.limits.maxRequests+' requests';
 if(usage.metering==='request-count-only')return usage.engine==='pi'?'Provider session: '+requests+'. Billing and allowances are managed by your provider.':'Codex session: '+requests+'. Plan allowance is managed by Codex.';
 if(usage.accountingComplete===false)return 'API session: '+requests+'. Provider usage was incomplete; further requests are blocked. Check provider billing for the actual charge.';
 if(!Number.isFinite(usage.tokens)||usage.tokens<0||!Number.isFinite(usage.estimatedCostUsd)||usage.estimatedCostUsd<0||!Number.isFinite(usage.limits.maxCostUsd))return 'Usage unavailable';
 return 'API session: '+requests+' · '+usage.tokens+' tokens · estimated $'+usage.estimatedCostUsd.toFixed(4)+' / $'+usage.limits.maxCostUsd.toFixed(2)+'. Catalog estimate, not a provider invoice.';
}

export function usageLabel(usage){
 const label=sessionUsageLabel(usage),user=usage?.userUsage;if(label==='Usage unavailable'||!user)return label;
 if(!Number.isSafeInteger(user.requests)||user.requests<0||!Number.isSafeInteger(user.limits?.maxRequests)||(!Number.isSafeInteger(user.windowEndsAt)||user.windowEndsAt<=0||user.windowEndsAt>8640000000000000))return label;
 return label+' User window: '+user.requests+' / '+user.limits.maxRequests+' requests; resets '+new Date(user.windowEndsAt).toISOString()+'.'+(user.accountingComplete===false?' User usage was incomplete; further requests are blocked for this window.':'');
}
