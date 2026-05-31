-- Run this once in Supabase SQL Editor.
-- It creates a single shared row used by the WebMode frontend.

create table if not exists public.web_mode_settings (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at_web_mode_settings()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_updated_at_web_mode_settings on public.web_mode_settings;
create trigger trg_touch_updated_at_web_mode_settings
before update on public.web_mode_settings
for each row
execute function public.touch_updated_at_web_mode_settings();

alter table public.web_mode_settings enable row level security;

grant select, insert, update on table public.web_mode_settings to anon, authenticated;

drop policy if exists "web_mode_settings_select_global" on public.web_mode_settings;
create policy "web_mode_settings_select_global"
on public.web_mode_settings
for select
to anon, authenticated
using (id = 'global');

drop policy if exists "web_mode_settings_insert_global" on public.web_mode_settings;
create policy "web_mode_settings_insert_global"
on public.web_mode_settings
for insert
to anon, authenticated
with check (id = 'global');

drop policy if exists "web_mode_settings_update_global" on public.web_mode_settings;
create policy "web_mode_settings_update_global"
on public.web_mode_settings
for update
to anon, authenticated
using (id = 'global')
with check (id = 'global');
