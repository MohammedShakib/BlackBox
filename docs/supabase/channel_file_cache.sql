-- Run this once in Supabase SQL Editor.
-- Stores file metadata per channel/folder, enabling offline browsing and fast load.

create table if not exists public.channel_file_cache (
  channel_id text primary key,
  files jsonb not null default '[]'::jsonb,
  total integer not null default 0,
  synced_at timestamptz not null default now()
);

create or replace function public.touch_synced_at_channel_file_cache()
returns trigger
language plpgsql
as $$
begin
  new.synced_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_synced_at_channel_file_cache on public.channel_file_cache;
create trigger trg_touch_synced_at_channel_file_cache
before update on public.channel_file_cache
for each row
execute function public.touch_synced_at_channel_file_cache();

alter table public.channel_file_cache enable row level security;

grant select, insert, update on table public.channel_file_cache to anon, authenticated;

drop policy if exists "channel_file_cache_select" on public.channel_file_cache;
create policy "channel_file_cache_select"
on public.channel_file_cache
for select
to anon, authenticated
using (true);

drop policy if exists "channel_file_cache_insert" on public.channel_file_cache;
create policy "channel_file_cache_insert"
on public.channel_file_cache
for insert
to anon, authenticated
with check (true);

drop policy if exists "channel_file_cache_update" on public.channel_file_cache;
create policy "channel_file_cache_update"
on public.channel_file_cache
for update
to anon, authenticated
using (true)
with check (true);
