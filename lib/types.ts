export interface NotificationEvent {
  id: number;
  source: string;
  title: string;
  body: string | null;
  url: string | null;
  icon: string | null;
  received_at: string;
  occurred_at: string | null;
  dedupe_key: string | null;
  raw: unknown | null;
}

// Shape a feeder is allowed to POST to /api/events.
export interface IncomingEvent {
  source: string;
  title: string;
  body?: string;
  url?: string;
  icon?: string;
  occurred_at?: string;
  dedupe_key?: string;
  raw?: unknown;
}
