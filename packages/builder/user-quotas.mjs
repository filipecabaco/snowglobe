import {sessionBudget} from './session-budget.mjs';
// Fixed in-memory windows survive reconnect/disconnect. One active request per
// identity prevents concurrent sessions spending against the same usage total.
export function userQuotas({limits={},windowMs=3600000,now=Date.now}={}){
 if(!Number.isSafeInteger(windowMs)||windowMs<1000)throw Error('Invalid user quota window');sessionBudget(limits);const records=new Map();
 function current(id){let record=records.get(id);if(record?.active)return record;if(!record||record.endsAt<=now()){if(!record&&records.size>=100)throw Error('User quota capacity reached');record={budget:sessionBudget(limits),endsAt:now()+windowMs,active:null};records.set(id,record);}return record;}
 return {
  begin(id,mode,request){if(!['api','codex'].includes(mode))throw Error('Invalid quota mode');const record=current(id);if(record.active){const error=Error('This user already has an active model request');error.status=409;throw error;}
   try{record.budget.begin(request);}catch{const error=Error('User usage limit reached. Retry after '+new Date(record.endsAt).toISOString());error.status=429;throw error;}
   const reservation={record,mode};record.active=reservation;return reservation;
  },
  finish(reservation,usage){if(!reservation||reservation.record.active!==reservation)return;if(reservation.mode==='api')reservation.record.budget.record(usage);reservation.record.active=null;},
  view(id){const record=current(id);return {...record.budget.view(),windowEndsAt:record.endsAt,active:!!record.active};}
 };
}
