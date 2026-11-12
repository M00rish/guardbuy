import type { LoaderFunctionArgs } from "react-router";

import { assertPrivacyActive } from "../lib/privacy/state.server";
import { authenticate } from "../shopify.server";
import { requirePublicDemo } from "../lib/demo/dashboard.server";
import { CONSOLE_SHELL } from "../lib/judge/console-shell";

// Judge console on the storefront: https://<shop>/apps/guardbuy (no Shopify login needed).
// The public copy lives at /demo because a development store keeps its password page. Both serve
// the same shell; a judge only ever acts on their own isolated `#judge-<id>` sandbox.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  await assertPrivacyActive(session.shop);
  requirePublicDemo(session.shop);
  return liquid(CONSOLE_SHELL, { headers: { "Cache-Control": "no-store" } });
};
