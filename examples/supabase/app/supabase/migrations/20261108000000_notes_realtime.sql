-- Realtime streams changes to the notes (notes watch, or supabase-js's channel().on("postgres_changes")):
-- a table's changes reach Realtime once it's in the supabase_realtime publication. Row level
-- security still applies, so each subscriber hears only the inserts it may read.
alter publication supabase_realtime add table public.notes;
