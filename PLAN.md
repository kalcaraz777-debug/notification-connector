# Notification Connector — Build Plan

Publish notifications from your iPhone (and other sources) to your personal
life's-dashboard website.

## Goal

One unified feed on your website showing events from the things you care about —
messages, email, calendar, packages, GitHub, bank alerts, etc. — fed largely
from your iPhone.

## The key constraint (read this first)

iOS **does not** let any app read other apps' notifications. There is no public
API for "give me every banner on my lock screen." So a single switch that mirrors
*literally everything* is not possible on a stock iPhone.

The only ways to tap the raw OS notification stream are brittle:

- **ANCS (Apple Notification Center Service)** — the Bluetooth channel a paired
  smartwatch uses to receive your notifications. Requires acting as a BLE
  accessory. Powerful but heavy.
- **macOS notification database** — notifications mirror to a Mac and land in a
  local SQLite DB you can read and forward. Mac-dependent, breaks across OS
  updates.

**Decision: we do NOT scrape the OS stream.** We ingest *per source*. You wire up
the ~10–15 sources you actually care about; they all land in one feed. This is
more reliable and is what a "life's dashboard" actually wants.

## Design priority: immediate (real-time)

The goal is that a notification shows up on the dashboard **within a second or two**
of hitting your phone — no refresh, no polling delay. That single requirement
drives three decisions:

- **Push, not poll.** The browser holds an open connection and the server *pushes*
  each new event. We use **Server-Sent Events (SSE)** — one-way server→browser,
  auto-reconnects, trivial compared to WebSockets, and perfect for a feed.
- **The server must stay alive to hold that connection.** Plain serverless
  functions (Vercel/Lambda) time out and can't hold SSE open. So either run a
  **persistent server** (Render / Fly / Railway) *or* offload realtime to a
  managed service (see below).
- **Fan-out the instant a row is written.** On insert we notify all connected
  browsers immediately, using Postgres **`LISTEN`/`NOTIFY`** (or Supabase Realtime).

### The fastest path: Supabase

Supabase gives us Postgres **and** Realtime in one box: insert a row, and the
insert streams to every subscribed browser over a WebSocket Supabase manages for
us — no persistent server of our own required, works even from serverless ingest.
Given "immediate" + "hosted Postgres" (both already chosen), **this is the
recommended stack.** The SSE-on-a-persistent-server option below is the fallback if
you'd rather not depend on Supabase Realtime.

## Architecture

```
  Feeders                 Connector (this repo)            Dashboard (live)
  ─────────               ─────────────────────            ────────────────
  iOS Shortcuts   ─┐                                    ┌─ open SSE / Realtime
  Zapier / IFTTT  ─┼─POST─▶ POST /events ─▶ Postgres ─┤  connection, held open
  Native webhooks ─┘        (auth+validate)   │ insert  └─ new event pushed in
                                              │            ~1s, prepended to feed
                                              ▼
                                    NOTIFY / Realtime fan-out
                                    ─▶ every connected browser
```

Pieces:

1. **Ingest endpoint** — `POST /events`, token-authenticated, validates, writes one
   row. Must respond fast (Shortcuts time out quickly) — write, fire the notify,
   return.
2. **Store** — hosted Postgres (Supabase recommended, for its Realtime).
3. **Realtime fan-out** — Supabase Realtime, or Postgres `LISTEN`/`NOTIFY` bridged
   to SSE on a persistent server.
4. **Dashboard** — opens a live connection on load, renders the last ~50 events,
   then prepends each pushed event as it arrives.

## Data model (Postgres)

```sql
create table events (
  id          bigint generated always as identity primary key,
  source      text        not null,          -- 'ios-shortcut', 'gmail', 'github'...
  title       text        not null,
  body        text,
  url         text,                           -- optional deep link
  icon        text,                           -- optional emoji or icon key
  received_at timestamptz not null default now(),
  occurred_at timestamptz,                    -- when the event happened, if known
  dedupe_key  text,                           -- optional, for idempotent retries
  raw         jsonb                           -- original payload, for debugging
);

create index events_received_at_idx on events (received_at desc);
create unique index events_dedupe_idx on events (dedupe_key) where dedupe_key is not null;
```

`dedupe_key` + the partial unique index makes retries safe: a feeder that POSTs
twice with the same key won't create duplicate feed items.

## Ingest contract

`POST /events`

Headers:
```
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
```

Body (only `source` + `title` required):
```json
{
  "source": "ios-shortcut",
  "title": "New text from Mom",
  "body": "Are you coming for dinner?",
  "url": "https://...",
  "icon": "💬",
  "occurred_at": "2026-07-15T18:04:00Z",
  "dedupe_key": "sms-9912"
}
```

Behavior:
- Reject if token missing/wrong → `401`.
- Validate required fields → `400` on failure.
- Insert; on `dedupe_key` conflict, no-op → return `200` either way.
- Respond fast (feeders like Shortcuts time out quickly).

## Feeders — how the iPhone actually connects

You can't trigger on *every* notification, but these cover most of what matters:

### A. iOS Shortcut (the main iPhone path)

Build one reusable Shortcut called **"Send to Dashboard"**:

1. Open the **Shortcuts** app → **+** → new shortcut.
2. Add action **Text** → type your event text (or leave it to accept Shortcut
   input / Share Sheet input).
3. Add action **Get Contents of URL**:
   - URL: `https://<your-app>/events`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <INGEST_TOKEN>`,
     `Content-Type` = `application/json`
   - Request Body: **JSON**, with fields `source` = `ios-shortcut`,
     `title` = (the text / Shortcut Input), etc.
4. In the shortcut settings, enable **Show in Share Sheet**.

Now you can fire it two ways:
- **Share Sheet** — from almost any app or a long-pressed notification, tap
  Share → "Send to Dashboard". Instant.
- **Personal Automations** (Shortcuts → Automation → +). iOS gives you specific
  triggers, not a generic "any notification," but useful ones exist: a message
  from a specific person, an email, arriving/leaving a place, a Focus turning
  on/off, an app being opened, an NFC tag tap, a time of day. Each automation can
  run the "Send to Dashboard" shortcut.

**For immediacy, turn OFF "Ask Before Running" on every automation** (toggle
"Run Immediately"). Otherwise iOS posts a *tap-to-confirm* banner and nothing sends
until you tap it — which kills the "immediate" goal. With it off, the POST fires
the moment the trigger hits. The end-to-end delay is then just: trigger → HTTPS
POST → insert → realtime push → browser. Typically ~1s.

One honest limit on the phone side: iOS automations run reliably but not always to
the millisecond, and background execution can add a small, occasional delay. It's
"feels instant," not "hard real-time."

### B. Zapier / IFTTT / Make

For services with no native webhook (Gmail, Google Calendar, package tracking,
some bank alerts): trigger in Zapier/IFTTT → action "Webhook / POST" → your
`/events` endpoint with the same JSON + token.

### C. Native webhooks (most reliable)

GitHub, Stripe, Slack, Linear, etc. can POST directly. Add a thin per-source
adapter route (e.g. `POST /events/github`) that maps their payload into our event
shape, so you don't have to reshape on their side.

## Security

- **`INGEST_TOKEN`** — long random secret, stored as an env var, checked on every
  ingest. Rotate by changing the env var.
- **HTTPS only** — the endpoint must be TLS (hosting gives this free).
- **Dashboard auth** — the feed is personal; put it behind a login or a
  hard-to-guess path + basic auth. Don't leave the feed world-readable.
- Never commit the token or DB URL — use env vars / a secrets manager.

## Deployment

Two viable shapes, both keeping it immediate:

- **Recommended — Supabase Realtime:** Postgres + realtime managed for you. Ingest
  can run anywhere (even a Vercel serverless route, since it only writes a row); the
  browser subscribes to inserts over Supabase's WebSocket. Set `DATABASE_URL` /
  Supabase keys and `INGEST_TOKEN`. Fewest moving parts for real-time.
- **Fallback — persistent server + SSE:** run the app on **Render / Fly / Railway**
  (a always-on process, *not* serverless, so it can hold SSE connections). It
  `LISTEN`s on a Postgres channel and streams to browsers over `GET /stream` (SSE).
  Postgres can still be Supabase or Neon.

Avoid plain Vercel/Lambda as the *only* host if you go the SSE route — their
function timeouts drop the live connection.

## Build phases

1. **Realtime walking skeleton** — `POST /events` writes a row; `GET /` loads the
   last 50 and then **live-updates** via SSE/Realtime. Deploy it. Success = a real
   notification from your phone appears on an already-open browser tab in ~1s, no
   refresh.
2. **Harden ingest** — token auth, validation, dedupe, fast response, structured
   errors.
3. **Dashboard polish** — source icons/filters, relative "just now" timestamps,
   subtle highlight/sound on new arrival, reconnect handling.
4. **Per-source adapters** — GitHub/Stripe/etc. routes; richer Shortcut recipes;
   "Run Immediately" automations documented.
5. **Nice-to-haves** — search, retention/cleanup, mute rules, a "today" summary.

## Open questions to settle before phase 1

- **Realtime approach:** Supabase Realtime (recommended, simplest) vs
  persistent-server + SSE?
- **Stack for the app:** Node/TS, Python/FastAPI, or Next.js?
- Single-user only, or room for more later? (Affects whether we add a `user_id`.)
- How long to retain events (all-time vs rolling window)?
