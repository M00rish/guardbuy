import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { sha256Hex } from "../lib/policy/hash";
import { requirePublicDemo } from "../lib/demo/dashboard.server";
import { judgeAttack, judgeState, judgeWhatIf, JudgeRefused } from "../lib/judge/console.server";

async function context(request: Request) {
  const { session, actor } = await adminWithStaff(request);
  requirePublicDemo(session.shop);
  // Staff identity comes from the signed session, never a browser-supplied sandbox ID.
  return { shop: session.shop, id: `merchant-${sha256Hex(actor).slice(0, 24)}` };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, id } = await context(request);
  const state = await judgeState(shop, id);
  return { scoreboard: state.scoreboard, feed: state.feed.slice(0, 20) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, id } = await context(request);
  const intent = (await request.formData()).get("intent");
  try {
    if (intent === "attack") return { message: await judgeAttack(shop, id) };
    if (intent === "whatif") return { message: await judgeWhatIf(shop, id) };
    return { message: "Unknown test" };
  } catch (error) {
    return { message: error instanceof JudgeRefused ? error.message : "The test could not run. Please retry." };
  }
};

export default function AttackTests() {
  const { scoreboard, feed } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const busy = fetcher.state !== "idle" || revalidator.state !== "idle";
  return (
    <s-page heading="Private attack tests">
      <s-section>
        <s-stack gap="base">
          <s-paragraph>These tests use a separate demo record set for your signed-in staff account. They do not change store inventory or pay suppliers. AI tests can consume API usage.</s-paragraph>
          <s-button disabled={busy} onClick={() => fetcher.submit({ intent: "attack" }, { method: "POST" })}>Run next attack</s-button>
          <s-button disabled={busy} onClick={() => fetcher.submit({ intent: "whatif" }, { method: "POST" })}>Simulate the AI being fooled</s-button>
          <s-button disabled={busy} onClick={() => revalidator.revalidate()}>Refresh results</s-button>
          {fetcher.data && <s-text>{fetcher.data.message}</s-text>}
          <s-text>AI runs finish in the background. Refresh results after a short wait.</s-text>
          <s-text>{`${scoreboard.tried} attacks tried; ${scoreboard.blocked} blocked; ${scoreboard.flagged} held for review; ${scoreboard.slipped} got through the rules.`}</s-text>
          <s-text>{`${scoreboard.simulated.tried} simulated AI failures (counted separately).`}</s-text>
          {scoreboard.knownGaps.map((gap) => <s-paragraph key={gap.title}>{`Known gap: ${gap.title}. ${gap.fix}`}</s-paragraph>)}
        </s-stack>
      </s-section>
      <s-section heading="Test activity">
        <s-stack gap="base">
          {feed.length === 0 && <s-text>No test activity yet.</s-text>}
          {feed.map((item) => <s-paragraph key={`${item.seq}-${item.kind}`}>{item.title}{item.detail ? ` — ${item.detail}` : ""}</s-paragraph>)}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
export { PageError as ErrorBoundary } from "../components/page-error";
