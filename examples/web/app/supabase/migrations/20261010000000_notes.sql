-- Each user's notes; row level security lets a user see and write only their own
create table public.notes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  body text not null check (length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "read own notes" on public.notes for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "write own notes" on public.notes for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "delete own notes" on public.notes for delete to authenticated
  using ((select auth.uid()) = user_id);
