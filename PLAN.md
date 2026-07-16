# Notification Connector — Full Plan

## 1. What you're trying to achieve

You want **one device to receive every verification code / notification, and a
permanent, tamper-proof record of them** — every message, with accurate times,
where **nothing can be deleted or altered after the fact.**

In plain terms, this is an **audit-grade capture and evidence system**:

- A single point that ingests the notifications/codes that matter to your
  operation.
- A durable log that records **what** arrived and **when**, to the second.
- A guarantee that once something is recorded, **no one — not even an
  administrator — can quietly remove or change it.**
- A live view so a human can watch events arrive in real time.

The original framing ("publish my iPhone notifications to my life's dashboard")
is the same machine; the security requirement just raises the bar on *integrity*
and *completeness*. This plan is written to that higher bar.

### Non-goals / honest scope

- This is **not** a way to secretly read someone else's phone. It captures
  notifications from a device you control and consent to monitor.
- It cannot magically get "every notification" off a stock iPhone — see §2.
- The capture device sees your codes, and the ledger can pass 2FA for everything
  it records. That makes it **high-value and sensitive** — §8 treats it as such.

## 2. The core constraint (why this is shaped the way it is)

**iOS never exposes one app's notifications or messages to another party.** No
Shortcut trigger, Developer Mode, parental control, or MDM policy changes this.
Everything below is a consequence of that single wall. There are exactly two ways
to get the full notification stream off an iPhone without jailbreaking (jailbreak
is disqualified — it *weakens* the very device a security system must trust):

1. **ANCS** — a Bluetooth device pairs with the iPhone and receives the same
   notification stream a smartwatch gets (title + body text, including codes).
2. **Source-level capture** — don't touch the phone; receive the codes where
   they originate (a programmable SMS number, or a mailbox API).

For SMS/email, **source-level is strictly stronger** (complete, provider-signed,
no device fragility). ANCS is the answer only when the codes are genuinely
on-device app notifications with no upstream source to tap. The system supports
both feeding into the same ledger.

## 3. System overview

```
   CAPTURE                    INGEST                LEDGER               VIEW
   ───────                    ──────                ──────               ────
  ESP32 (ANCS) ──┐
                 ├── POST /api/events ──▶  Postgres (append-only,  ──▶  Live
  SMS/email  ────┘   (token auth,          hash-chained)               dashboard
  (source-level)     validation)           │  UPDATE/DELETE blocked    (realtime)
                                            │  every row chained
                            ◀── ACK {id, row_hash} ── returned so a
                                courier can wipe its local copy safely
```

Four layers, each with a single job:

- **Capture** — get the notification and hand it to the ingest endpoint.
- **Ingest** — authenticate, validate, hand to the ledger, return an ACK.
- **Ledger** — store immutably, prove integrity.
- **View** — show it live.

## 4. Components in detail

### 4A. Capture — ESP32 ANCS courier

A small ESP32 (BLE + WiFi on one chip) pairs to the iPhone, receives every
notification via ANCS, and forwards it to the ledger.

- **Courier model, not storage.** The device holds each notification in onboard
  flash (LittleFS) only until the server confirms it, then erases it. No microSD.
- **Delete-after-ACK invariant.** An item is erased **only** after HTTP 200. A
  reboot, WiFi outage, or server error can never lose a notification — it stays
  queued and retries with backoff.
- **Idempotent re-sends.** Each item's `dedupe_key = source + device_seq`, so a
  retry after an interrupted flush can't create a duplicate in the ledger.
- **Gap detection.** A monotonic `device_seq` travels with every record, so a
  missing sequence number is visible end-to-end.

Status: forwarding + flash-queue logic is written (`firmware/main/courier.c`);
the BLE/ANCS layer builds on Espressif's official `ble_ancs` example and is
finished on your toolchain.

### 4B. Capture — source-level (the reliable primary for SMS/email)

Instead of scraping a device: receive codes on a **programmable number**
(Twilio et al.) or a **mailbox API**. Each inbound message hits a webhook that
POSTs to the same `/api/events`. Complete, timestamped, provider-signed, immune
to Bluetooth range / Focus modes / OS updates. Recommended whenever the codes
travel over SMS or email.

### 4C. Ingest API — `POST /api/events`

- Auth: `Authorization: Bearer <INGEST_TOKEN>`.
- Validates required fields (`source`, `title`); accepts `body`, `url`, `icon`,
  `occurred_at`, `device_seq`, `device_ts`, `dedupe_key`, `raw`.
- Inserts; the DB computes the hash chain.
- Returns `{ ok, id, row_hash }` — the ACK a courier waits for before wiping its
  local copy. Responds fast (feeders time out quickly).

### 4D. Ledger — append-only, hash-chained Postgres

The heart of the system (§6).

### 4E. View — live dashboard

Next.js page that loads the last 50 events and then streams new ones over
Supabase Realtime (~1s, no refresh), with source tags, relative timestamps, and
a highlight on arrival. Must sit behind **operator auth** before it holds real
codes (§8).

## 5. Data model

```sql
events (
  id          bigint identity primary key,   -- server sequence
  source      text not null,                  -- 'ios-ancs', 'sms', 'email', ...
  title       text not null,
  body        text,
  url         text,
  icon        text,
  received_at timestamptz not null default now(),  -- server receipt time
  occurred_at timestamptz,                    -- event time, if known
  device_seq  bigint,                          -- monotonic counter from device
  device_ts   timestamptz,                     -- device clock
  dedupe_key  text,                            -- idempotency
  raw         jsonb,
  prev_hash   text not null,                   -- row_hash of previous row
  row_hash    text not null                    -- sha256(prev_hash + this row)
)
```

## 6. Integrity design (the actual security requirement)

"Nothing can be deleted, keep times and messages" is enforced in **three
independent layers**, none of which live on the phone:

1. **Blocked mutation.** `BEFORE UPDATE` and `BEFORE DELETE` triggers raise an
   exception, so rows cannot be changed or removed — even by the service role.
2. **Hash chain.** A `BEFORE INSERT` trigger sets `row_hash =
   sha256(prev_hash + canonical(row))`, linking every row to its predecessor
   under an advisory lock (linear chain). Any deletion, edit, or reorder breaks
   the chain.
3. **Audit function.** `select * from events_verify_chain();` recomputes the
   whole chain and returns the first broken row, or nothing if intact. Run it on
   a schedule; alert if it ever returns a row.

**Timestamps** are dual: `device_ts` (when the device saw it) and `received_at`
(when the server recorded it), so ordering is always provable even if a device
clock drifts. For evidence-grade device time, add a DS3231 RTC; otherwise the
device reconciles boot-relative time to real time at each NTP sync.

**Completeness** is bounded by the capture link, not the ledger: the courier
queue guarantees nothing is lost *once captured*; ANCS capture itself is
best-effort, which is exactly why source-level capture is preferred for
compliance-critical channels.

> Hardening note: a database superuser could still drop the triggers. For true
> WORM guarantees, pair this with a restricted DB role, point-in-time backups,
> and/or periodic anchoring of `row_hash` to external immutable storage. Tracked
> as a later phase.

## 7. Hardware

**v1 — prototype (build firmware here):**

| Part | Notes |
|---|---|
| Seeed XIAO ESP32-C3 (or S3) | 21×17.5 mm, BLE 5 + WiFi, onboard LiPo charging |
| LiPo 3.7 V, ~150–400 mAh | soldered to BAT pads; nightly charge |
| DS3231 RTC (optional) | accurate offline timestamps |
| Slide switch (optional) | hard power cut |

**v2 — strap form factor:** custom PCB (ESP32-C3-MINI module + thin 402025 cell)
fabbed at JLCPCB, once firmware is proven. ANCS needs the BLE link held open, so
the device can't deep-sleep; plan a nightly charge, or run it on USB power with
the battery as backup for a fixed security appliance.

## 8. Security & compliance considerations

This system centralizes verification codes and makes them permanent. Treat the
ledger and capture device as **crown-jewel infrastructure**:

- **Access control.** The dashboard must be behind operator auth before it holds
  real codes. Scope the read policy to authenticated operators, not `anon`.
- **Secrets.** `INGEST_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY` are env-var only,
  never committed. Firmware `config.h` (token + WiFi) is git-ignored.
- **Per-device tokens.** Provision one token per courier so a lost device can be
  revoked without rotating everything.
- **Encryption.** TLS in transit (enforced); encrypt the ledger at rest; consider
  column encryption for message bodies.
- **The log is auditable but also a target.** Access to it should itself be
  logged. Whoever can read it can pass 2FA for everything it captures.
- **Consent & legality.** Only capture devices you own/administer with the
  knowledge of those involved. This is monitoring infrastructure, not covert
  surveillance.

## 9. Status — what's built

- [x] Ingest endpoint `POST /api/events` (token auth, validation, dedupe, ACK).
- [x] Append-only, hash-chained ledger + `events_verify_chain()` audit.
- [x] Live realtime dashboard (loads recent, streams new).
- [x] ESP32 courier scaffold: flash queue + delete-after-ACK flush + config.
- [x] Verified: typecheck + production build pass; ingest auth/validation paths
      exercised (401 / 400 / 200 behavior confirmed).

## 10. Roadmap — what's left

1. **Operator auth** on the dashboard (before it holds anything real).
2. **Source-level SMS/email capture** — the reliable primary; ANCS as backup.
3. **Firmware completion** — wire ANCS callback → `courier_enqueue()`, add the
   WiFi manager + periodic flush loop; flash to real hardware and prove one code
   from the phone lands in the ledger.
4. **Integrity ops** — schedule `events_verify_chain()`, alert on breakage.
5. **Hardening** — per-device tokens, at-rest encryption, restricted DB role,
   external hash anchoring for WORM.
6. **v2 hardware** — custom strap PCB.
7. **Dashboard polish** — filters, search, retention policy, "today" summary.

## 11. Open decisions

- **Primary capture channel:** are the codes SMS, email, or app-push? (Determines
  whether source-level or ANCS is the primary path.)
- **Hosting:** Vercel + Supabase (recommended) vs a persistent server.
- **Single operator or several?** (Affects auth + per-operator scoping.)
- **Retention:** keep forever (audit) vs rolling window.
