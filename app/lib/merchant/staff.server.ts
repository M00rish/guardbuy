import { redirect } from "react-router";
import { needsShopifyEntry } from "./app-entry";
import { assertPrivacyActive } from "../privacy/state.server";
import { authenticate } from "../../shopify.server";

export async function privateAdmin(request: Request) {
  if (needsShopifyEntry(request)) throw redirect("/auth/login");
  const ctx = await authenticate.admin(request);
  await assertPrivacyActive(ctx.session.shop);
  return ctx;
}

/**
 * authenticate.admin plus the acting staff member, for anything written to the audit log.
 * Rejects requests without a verified session token (the token's `sub` is the staff user id).
 */
export async function adminWithStaff(request: Request) {
  const ctx = await privateAdmin(request);
  const sub = ctx.sessionToken?.sub;
  if (!sub) throw new Response("A signed-in staff member is required", { status: 403 });
  return { ...ctx, actor: `shopify-staff:${sub}` };
}
