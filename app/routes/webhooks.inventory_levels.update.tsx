import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { enqueueRestock } from "../lib/jobs/restock-queue.server";

// Fires whenever stock changes (sales, restocks, manual edits). This is the agent's trigger.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  if (!admin) return new Response(); // app uninstalled; nothing to do

  const { inventory_item_id } = payload as { inventory_item_id: number };

  // Commit the trigger before acknowledging it. The worker reads current stock and sales,
  // then resumes the same recorded proposal/decision if this process restarts mid-restock.
  await enqueueRestock(shop, inventory_item_id);

  return new Response();
};
