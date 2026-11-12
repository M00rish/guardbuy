import { ExecutionRefused } from "../agent/execute.server";
import { PaymentPending } from "../payments/attempts";
import {
  JudgeRefused,
  judgeApprove,
  judgeAttack,
  judgeDecline,
  judgeRestock,
  judgeScene,
  judgeState,
  judgeWhatIf,
} from "./console.server";

// JSON API behind the judge console. The storefront proxy signs its requests; the /demo route is
// public. Either way a judge only ever acts on their own `#judge-<id>` sandbox.
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function judgeApiGet(shop: string, judgeId: string) {
  try {
    return json({ ok: true, ...(await judgeState(shop, judgeId)) });
  } catch (e) {
    if (e instanceof JudgeRefused) return json({ ok: false, message: e.message }, 400);
    console.error("[judge] state:", e);
    return json({ ok: false, message: "The demo is temporarily unavailable. Please retry." }, 503);
  }
}

export async function judgeApiPost(shop: string, form: FormData) {
  const judgeId = String(form.get("j") ?? "");
  const decisionSeq = Number(form.get("decisionSeq"));
  const preset = String(form.get("preset") ?? "");
  try {
    switch (form.get("intent")) {
      case "scene":
        return json({ ok: true, message: await judgeScene(shop, judgeId, preset) });
      case "restock":
        return json({ ok: true, message: await judgeRestock(shop, judgeId) });
      case "attack":
        return json({ ok: true, message: await judgeAttack(shop, judgeId) });
      case "whatif":
        return json({ ok: true, message: await judgeWhatIf(shop, judgeId) });
      case "approve":
        if (!Number.isInteger(decisionSeq)) return json({ ok: false, message: "Unknown purchase" }, 400);
        return json({ ok: true, message: await judgeApprove(shop, judgeId, decisionSeq) });
      case "decline":
        if (!Number.isInteger(decisionSeq)) return json({ ok: false, message: "Unknown purchase" }, 400);
        return json({ ok: true, message: await judgeDecline(shop, judgeId, decisionSeq) });
      default:
        return json({ ok: false, message: "Unknown action" }, 400);
    }
  } catch (e) {
    if (e instanceof JudgeRefused || e instanceof ExecutionRefused || e instanceof PaymentPending) {
      return json({ ok: false, message: e.message }, 400);
    }
    console.error("[judge] action:", e);
    return json({ ok: false, message: "Something went wrong. Nothing was paid twice; try again." }, 500);
  }
}
