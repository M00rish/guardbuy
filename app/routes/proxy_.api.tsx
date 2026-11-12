import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { requirePublicDemo } from "../lib/demo/dashboard.server";
import { judgeApiGet, judgeApiPost } from "../lib/judge/console-api.server";

// JSON for the storefront judge console at https://<shop>/apps/guardbuy/api. Shopify signs every
// proxied request. Actions stay inside the caller's own `#judge-<id>` sandbox.
async function shopFor(request: Request) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  requirePublicDemo(session.shop);
  return session.shop;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await shopFor(request);
  return judgeApiGet(shop, new URL(request.url).searchParams.get("j") ?? "");
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = await shopFor(request);
  return judgeApiPost(shop, await request.formData());
};
