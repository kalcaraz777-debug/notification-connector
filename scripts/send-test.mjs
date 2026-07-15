// Quick helper to POST a test event to your running dashboard.
// Usage: INGEST_TOKEN=... [BASE_URL=http://localhost:3000] npm run send:test

const base = process.env.BASE_URL ?? "http://localhost:3000";
const token = process.env.INGEST_TOKEN;

if (!token) {
  console.error("Set INGEST_TOKEN in the environment first.");
  process.exit(1);
}

const res = await fetch(`${base}/api/events`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    source: "test",
    title: "Hello dashboard",
    body: `Sent at ${new Date().toLocaleTimeString()}`,
    icon: "🎉",
  }),
});

console.log(res.status, await res.text());
