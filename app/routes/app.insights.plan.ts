// No component export: plain fetch receives the action's JSON, never a rendered UI document.
// Reuse the same staff/license checks, bounded input, rate limit and read-only planner.
import type { ActionFunctionArgs } from "react-router";
import { planInsightsRequest as plan } from "../lib/insights/request.server";

export const action = async (args: ActionFunctionArgs) => {
  const response = await plan(args);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};
