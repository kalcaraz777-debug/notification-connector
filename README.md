# Notification Connector

Publish notifications from your iPhone (and other sources) to a **live** personal
dashboard. New events appear in the browser in ~1 second with no refresh.

Stack: **Next.js + Supabase Realtime**. See [`PLAN.md`](./PLAN.md) for the full
design, the iOS constraints, and later phases.

## What's in phase 1

- `POST /api/events` — token-authenticated ingest endpoint. Feeders POST here.
- A live dashboard at `/` — loads the last 50 events, then streams new ones over
  Supabase Realtime and prepends them.
- Postgres schema in [`supabase/schema.sql`](./supabase/schema.sql).

## Setup

### 1. Create a Supabase project

At [supabase.com](https://supabase.com) → New project. Then:

- Open **SQL Editor**, paste the contents of `supabase/schema.sql`, run it.
- Open **Settings → API** and copy: the **Project URL**, the **anon** key, and the
  **service_role** key.

### 2. Configure env vars

```bash
cp .env.example .env.local
# then fill in the four values. Generate the ingest token with:
openssl rand -hex 32
```

### 3. Run it

```bash
npm install
npm run dev
# open http://localhost:3000
```

### 4. Send a test event

```bash
curl -X POST http://localhost:3000/api/events \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"test","title":"Hello dashboard","body":"It works 🎉","icon":"🎉"}'
```

It should pop into the open browser tab within a second. (There's also a helper:
`INGEST_TOKEN=... npm run send:test`.)

## Connect your iPhone

Build one reusable Shortcut, **"Send to Dashboard"**:

1. Shortcuts app → **+** → add action **Get Contents of URL**.
2. URL: `https://<your-deployed-app>/api/events` · Method: **POST**.
3. Headers: `Authorization` = `Bearer <INGEST_TOKEN>`,
   `Content-Type` = `application/json`.
4. Request Body: **JSON** → `source` = `ios-shortcut`, `title` = (Shortcut Input),
   plus any of `body` / `url` / `icon`.
5. Settings → enable **Show in Share Sheet**.

Fire it from the **Share Sheet**, or from **Automations** (Shortcuts → Automation).
For it to be *immediate*, turn OFF **"Ask Before Running"** on each automation
(a.k.a. **Run Immediately**) — otherwise iOS waits for a tap-to-confirm banner.

> iOS can't hand any app "every notification" — see the constraint section in
> `PLAN.md`. You wire up the specific triggers/sources you care about.

## Deploy

- **Vercel** (recommended for this stack): import the repo, set the four env vars
  from `.env.example`, deploy. Ingest is a serverless route (just writes a row);
  realtime is handled by Supabase, so serverless is fine here.
- Point the iOS Shortcut and any Zapier/IFTTT webhooks at the deployed
  `/api/events` URL.

## Security notes

- `INGEST_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY` are secrets — env vars only,
  never commit them.
- Phase 1 leaves the feed readable by anyone with the URL + anon key. Add
  dashboard auth before storing anything sensitive (tracked in `PLAN.md`).
