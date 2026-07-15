"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabaseBrowser";
import type { NotificationEvent } from "@/lib/types";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function Feed({
  initialEvents,
}: {
  initialEvents: NotificationEvent[];
}) {
  const [events, setEvents] = useState<NotificationEvent[]>(initialEvents);
  const [live, setLive] = useState(false);
  const [, forceTick] = useState(0);
  const freshIds = useRef<Set<number>>(new Set());

  // Re-render every 30s so relative timestamps stay current.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const supabase = getBrowserClient();

    const channel = supabase
      .channel("events-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "events" },
        (payload) => {
          const row = payload.new as NotificationEvent;
          freshIds.current.add(row.id);
          setEvents((prev) => {
            if (prev.some((e) => e.id === row.id)) return prev;
            return [row, ...prev].slice(0, 200);
          });
        },
      )
      .subscribe((status) => {
        setLive(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const sorted = useMemo(
    () =>
      [...events].sort(
        (a, b) =>
          new Date(b.received_at).getTime() - new Date(a.received_at).getTime(),
      ),
    [events],
  );

  return (
    <>
      <div className="header">
        <h1>Life Dashboard</h1>
        <div className="status">
          <span className={`dot ${live ? "live" : ""}`} />
          {live ? "live" : "connecting…"}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">
          No events yet. Fire your iOS Shortcut and it&apos;ll appear here.
        </div>
      ) : (
        <div className="feed">
          {sorted.map((e) => {
            const card = (
              <div
                className={`event ${freshIds.current.has(e.id) ? "fresh" : ""}`}
              >
                <div className="icon">{e.icon || "🔔"}</div>
                <div className="body">
                  <div className="title">{e.title}</div>
                  {e.body ? <div className="text">{e.body}</div> : null}
                  <div className="meta">
                    <span className="source">{e.source}</span>
                    <span>{timeAgo(e.received_at)}</span>
                  </div>
                </div>
              </div>
            );
            return e.url ? (
              <a
                key={e.id}
                className="event-link"
                href={e.url}
                target="_blank"
                rel="noreferrer"
              >
                {card}
              </a>
            ) : (
              <div key={e.id}>{card}</div>
            );
          })}
        </div>
      )}
    </>
  );
}
