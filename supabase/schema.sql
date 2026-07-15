-- Notification Connector — database schema
-- Run this once in the Supabase SQL editor (or via `supabase db push`).

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  source      text        not null,          -- 'ios-shortcut', 'gmail', 'github'...
  title       text        not null,
  body        text,
  url         text,                           -- optional deep link
  icon        text,                           -- optional emoji / icon key
  received_at timestamptz not null default now(),
  occurred_at timestamptz,                    -- when the event happened, if known
  dedupe_key  text,                           -- optional, for idempotent retries
  raw         jsonb                           -- original payload, for debugging
);

create index if not exists events_received_at_idx on public.events (received_at desc);

-- Plain unique index (not partial): Postgres treats NULLs as distinct, so many
-- rows may have dedupe_key = null, while non-null keys stay unique. This lets the
-- ingest route use ON CONFLICT (dedupe_key) as a valid arbiter for both cases.
create unique index if not exists events_dedupe_idx
  on public.events (dedupe_key);

-- Realtime: stream INSERTs to subscribed browsers.
alter publication supabase_realtime add table public.events;

-- Row Level Security.
-- Inserts happen server-side with the service-role key, which bypasses RLS,
-- so we do NOT grant insert to anon. The browser only needs SELECT to receive
-- realtime rows and to load the initial feed.
alter table public.events enable row level security;

drop policy if exists "anon can read events" on public.events;
create policy "anon can read events"
  on public.events for select
  to anon
  using (true);

-- NOTE: this makes the feed readable by anyone holding the anon key + URL.
-- Fine for phase 1. Before storing anything sensitive, put the dashboard behind
-- auth and tighten this policy (e.g. scope by user_id).
