"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser client using the public anon key. Used for the initial feed read and
// the realtime subscription. Only ever has the permissions RLS grants to anon.
let client: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars",
    );
  }

  client = createClient(url, anonKey);
  return client;
}
