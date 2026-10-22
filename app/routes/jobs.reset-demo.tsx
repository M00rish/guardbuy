import type { ActionFunctionArgs } from "react-router";

import { authorized } from "../lib/jobs/hourly.server";
import { resetDemoStock } from "../lib/jobs/reset-demo.server";

// POST /jobs/reset-demo with "Authorization: Bearer <JOBS_SECRET>": puts the demo store's stock
// back to the demo starting point (coffee low, so the agent has something to do). Demo store only.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorized(request)) return new Response("Not found", { status: 404 });
  return Response.json(await resetDemoStock(), { headers: { "Cache-Control": "no-store" } });
};

export const loader = () => new Response("Not found", { status: 404 });
