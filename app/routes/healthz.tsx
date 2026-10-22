// Health check for Render and uptime pings. Deliberately doesn't touch the database, so pinging
// it to keep the free server awake doesn't keep Neon's free database awake too.
export const loader = () => new Response("ok", { headers: { "Cache-Control": "no-store" } });
