import { getAdminClient } from "@/lib/supabaseServer";
import type { NotificationEvent } from "@/lib/types";
import Feed from "./Feed";

export const dynamic = "force-dynamic";

async function getInitialEvents(): Promise<NotificationEvent[]> {
  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Failed to load events:", error.message);
      return [];
    }
    return (data as NotificationEvent[]) ?? [];
  } catch (err) {
    // Env not configured yet — render an empty feed rather than crashing.
    console.error(err);
    return [];
  }
}

export default async function Page() {
  const initialEvents = await getInitialEvents();

  return (
    <main className="wrap">
      <Feed initialEvents={initialEvents} />
    </main>
  );
}
