import {useEffect,useState} from 'react';
import {supabase} from './supabase.js';
window.fixtureSupabase=supabase;
export default function App(){
 const [session,setSession]=useState(null),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[rows,setRows]=useState([]),[error,setError]=useState('');
 const load=async()=>{const {data,error}=await supabase.from('dice_rolls').select('*').order('created_at',{ascending:false});if(error)setError(error.message);else setRows(data);};
 useEffect(()=>{supabase.auth.getSession().then(({data})=>setSession(data.session));const {data}=supabase.auth.onAuthStateChange(async(_event,session)=>{if(session){const {error}=await supabase.from('dice_rolls').select('id').limit(1);if(error)setError(error.message);}setSession(session);});return()=>data.subscription.unsubscribe();},[]);
 useEffect(()=>{setRows([]);if(session)load();},[session?.user.id]);
 async function auth(signup){setError('');const result=await (signup?supabase.auth.signUp({email,password}):supabase.auth.signInWithPassword({email,password}));if(result.error)setError(result.error.message);}
 async function roll(){const value=Math.floor(Math.random()*6)+1;const result=await supabase.from('dice_rolls').insert({user_id:session.user.id,value});if(result.error)setError(result.error.message);else await load();}
 return <main style={{fontFamily:'system-ui',padding:24}}><h1>Supabase dice</h1>{error&&<p role="alert">{error}</p>}{session?<><p>{session.user.email}</p><button onClick={roll}>Roll dice</button><button onClick={()=>supabase.auth.signOut()}>Sign out</button><p>Rolls: {rows.length}</p><ul>{rows.map(row=><li key={row.id}>Roll: {row.value}</li>)}</ul></>:<><label>Email<input aria-label="Email" value={email} onChange={event=>setEmail(event.target.value)}/></label><label>Password<input aria-label="Password" type="password" value={password} onChange={event=>setPassword(event.target.value)}/></label><button onClick={()=>auth(true)}>Sign up</button><button onClick={()=>auth(false)}>Log in</button></>}</main>;
}
