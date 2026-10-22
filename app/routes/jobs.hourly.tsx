import type { ActionFunctionArgs } from "react-router";

import { authorized, runHourlyJob } from "../lib/jobs/hourly.server";

// POST /jobs/hourly with "Authorization: Bearer <JOBS_SECRET>" (the scheduler). Anything else: 404,
// so the endpoint doesn't advertise itself.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorized(request)) return new Response("Not found", { status: 404 });
  return Response.json(await runHourlyJob(), { headers: { "Cache-Control": "no-store" } });
};

export const loader = () => new Response("Not found", { status: 404 });
