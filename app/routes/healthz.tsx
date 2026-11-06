// This loader does not query the database. The restock worker polls while the web process is
// awake, so keeping the service awake also keeps its configured queue polling active.
export const loader = () => new Response("ok", { headers: { "Cache-Control": "no-store" } });
