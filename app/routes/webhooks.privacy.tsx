import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { receivePrivacyRequest } from "../lib/privacy/requests.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Shopify's library validates the raw-body HMAC even after the session was removed on uninstall.
  const { shop, topic, payload, eventId, webhookId } = await authenticate.webhook(request);
  const data = payload as { shop_domain?: unknown; data_request?: { id?: unknown } };
  // Bind the signed body to the delivery header; never suppress a different shop on a replay.
  if (data?.shop_domain !== shop) throw new Response("Privacy delivery shop does not match", { status: 400 });
  const id = data?.data_request?.id;
  await receivePrivacyRequest({ shop, topic, eventId: eventId ?? webhookId,
    requestId: typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined });
  return new Response(null, { status: 200 });
};
