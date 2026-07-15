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

## Architecture

```
  Feeders                    Connector (this repo)              Dashboard
  ─────────                  ─────────────────────              ─────────
  iOS Shortcuts   ─┐
  Zapier / IFTTT  ─┼──POST──▶  POST /events  ──▶  Postgres  ──▶  GET / (feed)
  Native webhooks ─┘           (auth + validate + store)         GET /events (JSON API)
```

Three pieces:

1. **Ingest endpoint** — `POST /events`, token-authenticated, validates a small
   JSON shape, writes one row.
2. **Store** — hosted Postgres (Supabase or Neon free tier).
3. **Dashboard** — a web page that reads recent events and renders a feed, plus a
   small JSON API behind the same page.

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
  Share → "Send to Dashboard".
- **Personal Automations** (Shortcuts → Automation → +). iOS gives you specific
  triggers, not a generic "any notification," but useful ones exist: a message
  from a specific person, an email, arriving/leaving a place, a Focus turning
  on/off, an app being opened, an NFC tag tap, a time of day. Each automation can
  run the "Send to Dashboard" shortcut.

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

- **Postgres**: Supabase or Neon (free tier). Grab the connection string.
- **App**: Vercel, Render, or Fly.io. Set env vars `DATABASE_URL` and
  `INGEST_TOKEN`.
- Point the iOS Shortcut and any Zaps at the deployed `/events` URL.

## Build phases

1. **Walking skeleton** — `POST /events` writing to Postgres, and `GET /` showing
   the last 50 rows. Deploy it. Prove one real notification from your phone lands
   on the page.
2. **Harden ingest** — token auth, validation, dedupe, structured errors.
3. **Dashboard polish** — group by day, source icons/filters, auto-refresh,
   relative timestamps.
4. **Per-source adapters** — GitHub/Stripe/etc. routes; richer Shortcut recipes.
5. **Nice-to-haves** — search, retention/cleanup job, mute rules, a "today"
   summary.

## Open questions to settle before phase 1

- Hosting target (Vercel vs Render vs Fly)?
- Single-user only, or room for more later? (Affects whether we add a `user_id`.)
- How long to retain events (all-time vs rolling window)?
