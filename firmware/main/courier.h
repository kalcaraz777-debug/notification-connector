// Courier: buffers ANCS notifications in flash and forwards them to the server
// ledger, deleting each only after a confirmed 200 ACK.
#pragma once

#include <stdint.h>
#include <time.h>

// One captured notification, as parsed from ANCS.
typedef struct {
  char     app_id[64];   // e.g. "com.apple.MobileSMS"
  char     title[128];   // notification title
  char     message[512]; // notification body (the visible text / code)
  time_t   device_ts;    // device clock at capture (0 if unknown)
} ancs_notification_t;

// Call once at boot: mounts LittleFS, loads the persisted device_seq.
void courier_init(void);

// Enqueue a captured notification durably to flash. Assigns the next
// device_seq. Returns 0 on success. Wire this to the ANCS notification callback.
int courier_enqueue(const ancs_notification_t *n);

// Attempt to flush queued items to the server. Call when WiFi is up (and
// periodically). Posts oldest-first; erases an item only after HTTP 200.
// Returns the number of items successfully ACKed and erased this pass.
int courier_flush(void);

// Number of items currently waiting in the flash queue.
int courier_pending(void);
