# Firmware — ANCS notification courier (ESP32)

A small ESP32 that pairs to an iPhone over Bluetooth, receives every notification
via **ANCS** (Apple Notification Center Service), buffers each one in onboard
flash, and forwards it to the server ledger over WiFi. Once the server ACKs
(HTTP 200), the item is wiped from flash. The device is a **courier** — the
durable, append-only copy lives on the server.

> Status: **scaffold.** The BLE/ANCS layer is built on Espressif's official
> `bluetooth/nimble/ble_ancs` example. The app logic in this folder — the flash
> queue, delete-after-ACK, and HTTPS forwarding — is the part that carries the
> "nothing missed / nothing deleted" guarantee. It has not been compiled in CI;
> build it with the ESP-IDF toolchain on your machine.

## Why ESP32

One chip does both radios: **BLE** to read ANCS, **WiFi** to upload. No second
gateway. See `../PLAN.md` for why ANCS is the only non-jailbreak way to receive
every notification, and its best-effort caveats.

## Hardware (v1 prototype)

| Part | Notes |
|---|---|
| Seeed **XIAO ESP32-C3** (or S3) | 21×17.5 mm, BLE 5 + WiFi, onboard LiPo charging |
| LiPo cell 3.7 V, ~150–400 mAh | soldered to BAT+/BAT− pads; nightly charge |
| Slide switch (optional) | hard power cut |
| DS3231 RTC (optional) | accurate offline timestamps; adds size |

No microSD: notifications are buffered in onboard flash (LittleFS) only until the
server ACKs, then erased — so a few KB of flash is plenty. To reach strap
thickness, move to a custom PCB (ESP32-C3-MINI + thin cell) once firmware is
proven — that's v2.

## How it works

```
ANCS notification ─▶ enqueue to flash (LittleFS) with device_seq + device_ts
                          │
        WiFi up? ─ yes ─▶ POST oldest item to /api/events (Bearer token)
                          │
              HTTP 200? ─ yes ─▶ erase item from flash, advance
                       ─ no  ─▶ keep item, retry with backoff
```

Key invariant: **an item is erased only after a 200 ACK.** WiFi outage, reboot,
or server hiccup can never lose a notification — it stays queued and retries.

## Timestamps

The ESP32 has no battery-backed clock. Each record carries:
- `device_seq` — a monotonic counter (gaps are detectable end-to-end), and
- `device_ts` — device time. With the optional DS3231 it's accurate offline;
  without it, boot-relative time reconciled to real time at the next NTP sync.

The server additionally stamps `received_at`, so ordering is always provable.

## Build & flash

1. Install ESP-IDF (v5.x) and clone Espressif's `ble_ancs` example as the BLE base.
2. Copy `config.example.h` → `config.h` and fill in WiFi + endpoint + token.
3. Drop the app files from `main/` into the example's `main/`, wire the ANCS
   notification callback to `courier_enqueue()` (see `main/courier.c`).
4. `idf.py set-target esp32c3 && idf.py build flash monitor`.
5. On the iPhone: Settings → Bluetooth → pair the device, accept the ANCS prompt.

## Security notes

- The token and WiFi creds live in `config.h` — **git-ignored**, never commit.
- Use HTTPS to the server (TLS). For production, provision a **per-device token**
  so one device can be revoked without rotating all of them.
- The device holds notification text only transiently; still, treat it as
  sensitive hardware — it sees your codes.
