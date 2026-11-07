import { createClient } from "@supabase/supabase-js";

// Supabase's API, on port 54321 of the supabase machine. In the agent page's preview this page is
// at <preview_base>web/4173/, and every machine's server is beside it, same origin:
// <preview_base>supabase/54321. Elsewhere, VITE_SUPABASE_URL says where it is.
const inPreview = location.pathname.match(/^(.*\/preview\/)[^/]+\/\d+\//);
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  ?? (inPreview ? location.origin + inPreview[1] + "supabase/54321" : "http://localhost:54321");

// The session is kept in localStorage under a key of this app's own (the preview shares its
// origin with the agent page), so a reload after each rebuild keeps you signed in
export const supabase = createClient(supabaseUrl, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { storageKey: "snowglobe-web-notes" },
});
