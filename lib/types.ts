export interface NotificationEvent {
  id: number;
  source: string;
  title: string;
  body: string | null;
  url: string | null;
  icon: string | null;
  received_at: string;
  occurred_at: string | null;
  device_seq: number | null;
  device_ts: string | null;
  dedupe_key: string | null;
  raw: unknown | null;
  prev_hash: string;
  row_hash: string;
}

// Shape a feeder is allowed to POST to /api/events.
export interface IncomingEvent {
  source: string;
  title: string;
  body?: string;
  url?: string;
  icon?: string;
  occurred_at?: string;
  device_seq?: number; // monotonic counter from the capture device
  device_ts?: string; // device clock (RTC or NTP-reconciled), ISO 8601
  dedupe_key?: string;
  raw?: unknown;
}
