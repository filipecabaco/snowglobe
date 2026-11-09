// Approval scope for the isolated synthetic profiles database test only.
export function allowedProfileSql(sql){
 if(typeof sql!=='string')return false;
 const text=sql.replace(/--[^\n]*/g,'').trim();
 if(!text)return false;
 if([...text.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)/gi)].some(match=>match[1].toLowerCase()!=='profiles'))return false;
 if(/\b(?:drop|truncate|reset|copy|execute|do|pg_\w+|security\s+definer)\b/i.test(text))return false;
 const statements=text.split(';').map(s=>s.trim()).filter(Boolean);
 return statements.length>0&&statements.every(s=>
  /^CREATE TABLE (?:IF NOT EXISTS )?public\.profiles\s*\(/i.test(s)||
  /^ALTER TABLE public\.profiles (?:ENABLE|FORCE) ROW LEVEL SECURITY$/i.test(s)||
  /^CREATE POLICY [a-z_][a-z0-9_]* ON public\.profiles\b/i.test(s)||
  /^GRANT (?:SELECT|INSERT|UPDATE|DELETE|,|\s)+ ON (?:TABLE )?public\.profiles TO authenticated$/i.test(s));
}
