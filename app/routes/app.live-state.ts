import type { LoaderFunctionArgs } from "react-router";
import { privateAdmin } from "../lib/merchant/staff.server";
import { liveRevision } from "../lib/live/revision.server";

// Resource route: authenticated fetch receives JSON, never a rendered app document.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await privateAdmin(request);
  return Response.json(
    { revision: await liveRevision(session.shop) },
    {
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
