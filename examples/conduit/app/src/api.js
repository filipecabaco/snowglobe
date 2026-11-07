import { createClient } from "@supabase/supabase-js";
const base = new URL("./", location.href);
export const supabase = createClient(
  window.CONDUIT_CONFIG.apiUrl || new URL("supabase", base).href,
  window.CONDUIT_CONFIG.anonKey,
  {
    auth: { storageKey: `conduit:${base.pathname}` },
  },
);
export function result({ data, error }) {
  if (error) throw error;
  return data;
}
export const articleSelect =
  "*, author:profiles!author_id(*), favorites(user_id)";
export const profile = (id) =>
  supabase.from("profiles").select("*").eq("id", id).single().then(result);
export const article = (slug) =>
  supabase
    .from("articles")
    .select(articleSelect)
    .eq("slug", slug)
    .single()
    .then(result);
