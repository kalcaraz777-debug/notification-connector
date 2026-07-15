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
    dedupe_key: payload.dedupe_key ?? null,
    raw: payload.raw ?? null,
  };

  try {
    const supabase = getAdminClient();

    // Idempotent on dedupe_key: a retried POST won't create a duplicate.
    const { error } = await supabase.from("events").upsert(row, {
      onConflict: "dedupe_key",
      ignoreDuplicates: true,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
