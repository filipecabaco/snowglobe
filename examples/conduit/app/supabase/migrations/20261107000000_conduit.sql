-- All browser access uses the public key and the caller's Auth JWT. No privileged client.
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text not null unique check (length(username) between 1 and 40),
  bio text not null default '', image text not null default ''
);
create function public.new_profile() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, username) values (new.id, coalesce(nullif(new.raw_user_meta_data->>'username',''), 'reader-' || left(new.id::text, 8)));
  return new;
end $$;
create trigger new_profile after insert on auth.users for each row execute function public.new_profile();
create table public.articles (
 id uuid primary key default gen_random_uuid(), slug text not null unique,
 author_id uuid not null references public.profiles on delete cascade,
 title text not null check(length(trim(title)) > 0), description text not null default '',
 body text not null check(length(trim(body)) > 0), tags text[] not null default '{}',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.comments (
 id uuid primary key default gen_random_uuid(), article_id uuid not null references public.articles on delete cascade,
 author_id uuid not null references public.profiles on delete cascade,
 body text not null check(length(trim(body)) > 0), created_at timestamptz not null default now()
);
create table public.favorites (
 article_id uuid not null references public.articles on delete cascade,
 user_id uuid not null references public.profiles on delete cascade, primary key(article_id,user_id)
);
create table public.follows (
 follower_id uuid not null references public.profiles on delete cascade,
 followed_id uuid not null references public.profiles on delete cascade,
 primary key(follower_id,followed_id), check(follower_id <> followed_id)
);
create index on public.articles (created_at desc);
create index on public.articles (author_id);
create index on public.articles using gin(tags);
create index on public.comments(article_id);
create index on public.favorites(user_id);
create function public.touch_article() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create trigger touch_article before update on public.articles for each row execute function public.touch_article();
alter table public.profiles enable row level security;
alter table public.articles enable row level security;
alter table public.comments enable row level security;
alter table public.favorites enable row level security;
alter table public.follows enable row level security;
create policy read_profiles on public.profiles for select using (true);
create policy edit_profile on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy read_articles on public.articles for select using (true);
create policy add_article on public.articles for insert to authenticated with check (author_id = (select auth.uid()));
create policy edit_article on public.articles for update to authenticated using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy delete_article on public.articles for delete to authenticated using (author_id = (select auth.uid()));
create policy read_comments on public.comments for select using (true);
create policy add_comment on public.comments for insert to authenticated with check (author_id = (select auth.uid()));
create policy delete_comment on public.comments for delete to authenticated using (author_id = (select auth.uid()));
create policy read_favorites on public.favorites for select using (true);
create policy add_favorite on public.favorites for insert to authenticated with check (user_id = (select auth.uid()));
create policy delete_favorite on public.favorites for delete to authenticated using (user_id = (select auth.uid()));
create policy read_follows on public.follows for select using (true);
create policy add_follow on public.follows for insert to authenticated with check (follower_id = (select auth.uid()));
create policy delete_follow on public.follows for delete to authenticated using (follower_id = (select auth.uid()));
grant select on public.profiles, public.articles, public.comments, public.favorites, public.follows to anon, authenticated;
grant update(username,bio,image) on public.profiles to authenticated;
grant insert, update, delete on public.articles to authenticated;
grant insert, delete on public.comments, public.favorites, public.follows to authenticated;
create function public.tags() returns table(tag text) language sql stable security invoker set search_path = '' as $$
 select distinct unnest(tags) from public.articles order by 1;
$$;
