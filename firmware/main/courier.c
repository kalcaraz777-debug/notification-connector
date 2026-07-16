// Courier implementation: durable flash queue + delete-after-ACK forwarding.
//
// Design invariant: a queued item is erased ONLY after the server returns 200.
// A reboot, WiFi outage, or server error can never drop a notification.
//
// Queue layout: each notification is one JSON file in QUEUE_DIR named by its
// zero-padded device_seq (e.g. /store/0000000042.json). Flushing walks the
// files in ascending order, POSTs each, and unlinks on 200. This gives crash
// safety for free — an interrupted flush just re-sends the file next time
// (the server dedupes on `dedupe_key`, which we set to source+device_seq).

#include "courier.h"
#include "config.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>

#include "esp_http_client.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "courier";
static uint64_t s_device_seq = 0;   // monotonic, persisted across reboots

// ---- persistence of the sequence counter ----------------------------------
static void load_seq(void) {
  nvs_handle_t h;
  if (nvs_open("courier", NVS_READWRITE, &h) == ESP_OK) {
    nvs_get_u64(h, "seq", &s_device_seq);
    nvs_close(h);
  }
}

static void save_seq(void) {
  nvs_handle_t h;
  if (nvs_open("courier", NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u64(h, "seq", s_device_seq);
    nvs_commit(h);
    nvs_close(h);
  }
}

void courier_init(void) {
  esp_vfs_littlefs_conf_t conf = {
      .base_path = QUEUE_DIR,
      .partition_label = "storage",
      .format_if_mount_failed = true,
  };
  ESP_ERROR_CHECK(esp_vfs_littlefs_register(&conf));
  load_seq();
  ESP_LOGI(TAG, "courier ready, next seq=%llu, pending=%d",
           (unsigned long long)s_device_seq, courier_pending());
}

// Minimal JSON string escaper for the fields we emit.
static void json_escape(const char *in, char *out, size_t out_len) {
  size_t o = 0;
  for (size_t i = 0; in[i] && o + 2 < out_len; i++) {
    char c = in[i];
    if (c == '"' || c == '\\') {
      out[o++] = '\\';
      out[o++] = c;
    } else if (c == '\n') {
      out[o++] = '\\';
      out[o++] = 'n';
    } else if ((unsigned char)c >= 0x20) {
      out[o++] = c;
    }
  }
  out[o] = '\0';
}

int courier_enqueue(const ancs_notification_t *n) {
  uint64_t seq = ++s_device_seq;
  save_seq();  // persist BEFORE writing the file so seq never repeats

  char path[128];
  snprintf(path, sizeof(path), "%s/%010llu.json", QUEUE_DIR,
           (unsigned long long)seq);

  FILE *f = fopen(path, "w");
  if (!f) {
    ESP_LOGE(TAG, "enqueue: cannot open %s", path);
    return -1;
  }

  char etitle[260], emsg[1040];
  json_escape(n->title, etitle, sizeof(etitle));
  json_escape(n->message, emsg, sizeof(emsg));

  // dedupe_key = source + device_seq makes re-sends idempotent server-side.
  fprintf(f,
          "{\"source\":\"%s\",\"title\":\"%s\",\"body\":\"%s\","
          "\"device_seq\":%llu,\"device_ts\":%lld,"
          "\"dedupe_key\":\"%s-%llu\"}",
          SOURCE_NAME, etitle, emsg, (unsigned long long)seq,
          (long long)n->device_ts, SOURCE_NAME, (unsigned long long)seq);
  fclose(f);

  ESP_LOGI(TAG, "enqueued seq=%llu (%s)", (unsigned long long)seq, n->app_id);
  return 0;
}

int courier_pending(void) {
  DIR *d = opendir(QUEUE_DIR);
  if (!d) return 0;
  int count = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strstr(e->d_name, ".json")) count++;
  }
  closedir(d);
  return count;
}

// Find the lexicographically-smallest .json file (== oldest device_seq, thanks
// to zero-padding). Returns 1 and fills `name` if one exists, else 0.
static int oldest_file(char *name, size_t name_len) {
  DIR *d = opendir(QUEUE_DIR);
  if (!d) return 0;
  int found = 0;
  char best[64] = {0};
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (!strstr(e->d_name, ".json")) continue;
    if (!found || strcmp(e->d_name, best) < 0) {
      strncpy(best, e->d_name, sizeof(best) - 1);
      found = 1;
    }
  }
  closedir(d);
  if (found) strncpy(name, best, name_len - 1);
  return found;
}

// POST one file's body. Returns the HTTP status code, or -1 on transport error.
static int post_file(const char *path) {
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (len <= 0 || len > 4096) {
    fclose(f);
    return -1;
  }
  char *body = malloc(len + 1);
  if (!body) {
    fclose(f);
    return -1;
  }
  fread(body, 1, len, f);
  body[len] = '\0';
  fclose(f);

  esp_http_client_config_t cfg = {
      .url = INGEST_URL,
      .method = HTTP_METHOD_POST,
      .timeout_ms = 10000,
      .crt_bundle_attach = esp_crt_bundle_attach,  // verify TLS
  };
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  esp_http_client_set_header(c, "Content-Type", "application/json");
  esp_http_client_set_header(c, "Authorization", "Bearer " INGEST_TOKEN);
  esp_http_client_set_post_field(c, body, len);

  int status = -1;
  if (esp_http_client_perform(c) == ESP_OK) {
    status = esp_http_client_get_status_code(c);
  }
  esp_http_client_cleanup(c);
  free(body);
  return status;
}

int courier_flush(void) {
  int acked = 0;
  char name[64];
  char path[128];

  // Drain oldest-first. Stop on the first item we can't confirm, so ordering
  // and the "delete only after ACK" invariant both hold.
  while (oldest_file(name, sizeof(name))) {
    snprintf(path, sizeof(path), "%s/%s", QUEUE_DIR, name);
    int status = post_file(path);
    if (status == 200) {
      unlink(path);  // erase ONLY after a confirmed ACK
      acked++;
    } else {
      ESP_LOGW(TAG, "flush stop: %s status=%d (will retry)", name, status);
      break;
    }
  }
  return acked;
}
