import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ExecutionRefused } from "../lib/agent/execute.server";
import { judgeApprove, judgeAttack, judgeDecline, JudgeRefused, judgeRestock, judgeState } from "../lib/judge/console.server";

// JSON API for the judge console, reached through the app proxy at https://<shop>/apps/guardbuy/api.
// Shopify signs every proxied request (appProxy() rejects anything unsigned). Judges act only on
// their own sandbox, identified by the session id their browser keeps (the proxy strips cookies).

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function shopFor(request: Request) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw json({ ok: false, message: "GuardBuy isn't set up on this store" }, 404);
  return session.shop;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await shopFor(request);
  const judgeId = new URL(request.url).searchParams.get("j") ?? "";
  try {
    return json({ ok: true, ...(await judgeState(shop, judgeId)) });
  } catch (e) {
    if (e instanceof JudgeRefused) return json({ ok: false, message: e.message }, 400);
    throw e;
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = await shopFor(request);
  const form = await request.formData();
  const judgeId = String(form.get("j") ?? "");
  const decisionSeq = Number(form.get("decisionSeq"));

  try {
    switch (form.get("intent")) {
      case "restock":
        return json({ ok: true, message: await judgeRestock(shop, judgeId) });
      case "attack":
        return json({ ok: true, message: await judgeAttack(shop, judgeId) });
      case "approve":
        return json({ ok: true, message: await judgeApprove(shop, judgeId, decisionSeq) });
      case "decline":
        return json({ ok: true, message: await judgeDecline(shop, judgeId, decisionSeq) });
      default:
        return json({ ok: false, message: "Unknown action" }, 400);
    }
  } catch (e) {
    if (e instanceof JudgeRefused || e instanceof ExecutionRefused) return json({ ok: false, message: e.message }, 400);
    console.error(`[judge] ${shop}:`, e);
    return json({ ok: false, message: "Something went wrong. Nothing was paid twice; try again." }, 500);
  }
};
