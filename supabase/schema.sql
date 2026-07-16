-- Notification Connector — append-only, tamper-evident ledger
-- Run this once in the Supabase SQL editor (or via `supabase db push`).
--
-- Integrity model:
--   * Rows can only be INSERTed. UPDATE and DELETE are blocked by triggers, so
--     "no notification can be deleted" is enforced by the database itself.
--   * Every row is hash-chained to the previous one (prev_hash + row_hash). Any
--     deletion, reordering, or edit breaks the chain and is detectable by
--     recomputing the hashes.
--   * The device is only a courier: it holds each notification in onboard flash
--     until this ledger ACKs the insert, then wipes it. The durable copy is here.

create extension if not exists pgcrypto;

create table if not exists public.events (
  id          bigint generated always as identity primary key,  -- server sequence
  source      text        not null,          -- 'ios-ancs', 'ios-shortcut', ...
  title       text        not null,
  body        text,
  url         text,
  icon        text,
  received_at timestamptz not null default now(),   -- server receipt time
  occurred_at timestamptz,                    -- event time, if known
  device_seq  bigint,                          -- monotonic counter from the device
  device_ts   timestamptz,                     -- device clock (RTC/NTP-reconciled)
  dedupe_key  text,                            -- optional, for idempotent retries
  raw         jsonb,                           -- original payload, for debugging
  prev_hash   text        not null,            -- row_hash of the previous row
  row_hash    text        not null             -- sha256 over prev_hash + this row
);

create index if not exists events_received_at_idx on public.events (received_at desc);

-- Plain unique index (NULLs are distinct in Postgres), so many rows may have
-- dedupe_key = null while non-null keys stay unique. Enables ON CONFLICT.
create unique index if not exists events_dedupe_idx
  on public.events (dedupe_key);

-- ---------------------------------------------------------------------------
-- Hash chain: computed server-side in a BEFORE INSERT trigger so the device
-- cannot forge it. An advisory lock serializes concurrent inserts, keeping the
-- chain strictly linear.
-- ---------------------------------------------------------------------------
create or replace function public.events_hash_chain()
returns trigger
language plpgsql
as $$
declare
  last_hash text;
  canonical text;
begin
  perform pg_advisory_xact_lock(4242424242);

  select row_hash into last_hash
  from public.events
  order by id desc
  limit 1;

  new.prev_hash := coalesce(last_hash, 'GENESIS');

  -- Canonical string over the immutable, meaningful fields.
  canonical := concat_ws('|',
    new.prev_hash,
    new.source,
    new.title,
    coalesce(new.body, ''),
    coalesce(new.url, ''),
    coalesce(new.icon, ''),
    to_char(new.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(new.occurred_at::text, ''),
    coalesce(new.device_seq::text, ''),
    coalesce(new.device_ts::text, ''),
    coalesce(new.dedupe_key, '')
  );

  new.row_hash := encode(digest(canonical, 'sha256'), 'hex');
  return new;
end;
$$;

drop trigger if exists events_hash_chain_trg on public.events;
create trigger events_hash_chain_trg
  before insert on public.events
  for each row execute function public.events_hash_chain();

-- ---------------------------------------------------------------------------
-- Append-only enforcement: block UPDATE and DELETE for everyone, including the
-- service role. (A superuser could still drop these triggers; for true WORM,
-- pair this with immutable storage / restricted DB roles — see PLAN.md.)
-- ---------------------------------------------------------------------------
create or replace function public.events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'events is append-only: % is not allowed', tg_op;
end;
$$;

drop trigger if exists events_no_update on public.events;
create trigger events_no_update
  before update on public.events
  for each row execute function public.events_block_mutation();

drop trigger if exists events_no_delete on public.events;
create trigger events_no_delete
  before delete on public.events
  for each row execute function public.events_block_mutation();

-- ---------------------------------------------------------------------------
-- Realtime + RLS.
-- Inserts happen server-side with the service-role key (bypasses RLS). The
-- browser only needs SELECT to receive realtime rows and load the feed.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.events;

alter table public.events enable row level security;

drop policy if exists "anon can read events" on public.events;
create policy "anon can read events"
  on public.events for select
  to anon
  using (true);

-- NOTE: this makes the feed readable by anyone holding the anon key + URL.
-- For a security deployment, put the dashboard behind auth and scope this policy
-- (e.g. by an authenticated operator role) before going live.

-- ---------------------------------------------------------------------------
-- Integrity check helper: returns the first row where the chain breaks, or no
-- rows if the ledger is intact. Run periodically as an audit.
-- ---------------------------------------------------------------------------
create or replace function public.events_verify_chain()
returns table (broken_id bigint, reason text)
language plpgsql
as $$
declare
  r          record;
  expected   text := 'GENESIS';
  canonical  text;
  computed   text;
begin
  for r in select * from public.events order by id asc loop
    if r.prev_hash <> expected then
      return query select r.id, 'prev_hash mismatch'::text;
      return;
    end if;

    canonical := concat_ws('|',
      r.prev_hash, r.source, r.title,
      coalesce(r.body, ''), coalesce(r.url, ''), coalesce(r.icon, ''),
      to_char(r.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      coalesce(r.occurred_at::text, ''),
      coalesce(r.device_seq::text, ''),
      coalesce(r.device_ts::text, ''),
      coalesce(r.dedupe_key, '')
    );
    computed := encode(digest(canonical, 'sha256'), 'hex');

    if computed <> r.row_hash then
      return query select r.id, 'row_hash mismatch (row altered)'::text;
      return;
    end if;

    expected := r.row_hash;
  end loop;
end;
$$;
