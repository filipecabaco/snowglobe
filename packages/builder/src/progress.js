export const PROGRESS_PREFIX = 'SG_BUILDER_PROGRESS ';
export function parseGuestOutput(output, request, complete=false) {
  const events=[];let response;
  const lines=output.split('\n');
  // Only consume complete records; the serial transport may split a JSON line.
  for(const line of (complete?lines:lines.slice(0,-1))) {
    if(line.startsWith(PROGRESS_PREFIX)) {
      try {const e=JSON.parse(line.slice(PROGRESS_PREFIX.length));if(e.id===request.id&&e.projectId===request.projectId&&e.vmGeneration===request.vmGeneration)events.push(e);}catch{}
    } else if(line.trim()) {try{response=JSON.parse(line);}catch{}}
  }
  return {events,response};
}
export function formatElapsed(ms) {const seconds=Math.floor(ms/1000);return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${String(seconds%60).padStart(2,'0')}s`;}
