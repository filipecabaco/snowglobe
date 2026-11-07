import { createClient } from "@supabase/supabase-js";

// Supabase for the app: Auth, and the Data API over the tables in its public schema (row level
// security decides what each user reads and writes). Use it from any component:
//
//   import { supabase } from "./supabase.js";
//   await supabase.auth.signUp({ email, password });           // or signInWithPassword
//   const { data, error } = await supabase.from("todos").select("*");
//
// Create tables with SQL on the supabase machine (run_sql), and keep each migration in
// supabase/migrations/.
//
// The API is on port 54321 of the supabase machine. In the agent page's preview this page is at
// <preview_base>web/4173/, and every machine's server is beside it, same origin:
// <preview_base>supabase/54321. Elsewhere, VITE_SUPABASE_URL says where it is. The anon key is in
// .env (VITE_SUPABASE_ANON_KEY).
const inPreview = location.pathname.match(/^(.*\/preview\/)[^/]+\/\d+\//);
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  ?? (inPreview ? location.origin + inPreview[1] + "supabase/54321" : "http://localhost:54321");

// The session is kept in localStorage under a key of this app's own (the preview shares its
// origin with the agent page), so a reload after each rebuild keeps you signed in
export const supabase = createClient(supabaseUrl, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { storageKey: "snowglobe-web-app" },
});
