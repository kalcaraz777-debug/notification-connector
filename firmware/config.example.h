// Copy this file to config.h and fill in your values. config.h is git-ignored.
#pragma once

// --- WiFi -------------------------------------------------------------------
#define WIFI_SSID       "your-wifi-ssid"
#define WIFI_PASSWORD   "your-wifi-password"

// --- Server ledger ----------------------------------------------------------
// Must be HTTPS in production.
#define INGEST_URL      "https://your-app.example.com/api/events"
#define INGEST_TOKEN    "the-same-long-random-secret-as-the-server"

// --- Behavior ---------------------------------------------------------------
#define SOURCE_NAME     "ios-ancs"   // shows up as the event `source`
#define QUEUE_DIR       "/store"      // LittleFS dir for the flash queue
#define RETRY_BASE_MS   2000          // backoff base when the server is unreachable
#define RETRY_MAX_MS    60000         // backoff ceiling
