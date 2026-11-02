import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { publicDashboard, requirePublicDemo } from "../lib/demo/dashboard.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) throw new Response("Not found", { status: 404 });
  requirePublicDemo(session.shop);
  try {
    return Response.json({ ok: true, ...await publicDashboard(admin, session.shop) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, message: "Live demo data is temporarily unavailable. Please retry." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};

// The retired judge action API must never remain usable via old tabs or direct POSTs.
export const action = () => new Response("Read-only dashboard", { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
