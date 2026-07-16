import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabaseServer";
import type { IncomingEvent } from "@/lib/types";

// Ingest endpoint. Feeders (iOS Shortcut, Zapier, webhooks) POST here.
// Auth: Authorization: Bearer <INGEST_TOKEN>
export async function POST(request: Request) {
  const token = process.env.INGEST_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "server misconfigured: INGEST_TOKEN not set" },
      { status: 500 },
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: IncomingEvent;
  try {
    payload = (await request.json()) as IncomingEvent;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!payload || typeof payload.source !== "string" || !payload.source.trim()) {
    return NextResponse.json({ error: "`source` is required" }, { status: 400 });
  }
  if (typeof payload.title !== "string" || !payload.title.trim()) {
    return NextResponse.json({ error: "`title` is required" }, { status: 400 });
  }

  const row = {
    source: payload.source.trim(),
    title: payload.title.trim(),
    body: payload.body ?? null,
    url: payload.url ?? null,
    icon: payload.icon ?? null,
    occurred_at: payload.occurred_at ?? null,
    device_seq: payload.device_seq ?? null,
    device_ts: payload.device_ts ?? null,
    dedupe_key: payload.dedupe_key ?? null,
    raw: payload.raw ?? null,
  };

  try {
    const supabase = getAdminClient();

    // Idempotent on dedupe_key: a retried POST won't create a duplicate.
    // The DB trigger computes the hash chain; we return the assigned id + hash
    // as an ACK so the device can safely wipe the item from its flash queue.
    const { data, error } = await supabase
      .from("events")
      .upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
      .select("id, received_at, row_hash")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // data is null when the row was a dedupe no-op; still a successful ACK.
    return NextResponse.json(
      { ok: true, id: data?.id ?? null, row_hash: data?.row_hash ?? null },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
