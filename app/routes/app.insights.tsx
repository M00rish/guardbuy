import { lazy, Suspense, useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { auditEntries, verifyChain } from "../lib/audit/log.server";
import { feedNames } from "../lib/merchant/dashboard.server";
import { insightsSnapshot } from "../lib/insights/projection.server";
import {
  insightsAiConfigured,
  planInsightView,
} from "../lib/insights/planner.server";
import { InsightPromptSchema } from "../lib/insights/plan";

const Insights = lazy(() => import("../components/insights-studio"));
// Session-scoped, bounded, in-memory cost limit; not an authorization boundary.
const requests = new Map<string, number>();
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await adminWithStaff(request);
  const chain = await verifyChain(session.shop);
  if (!chain.valid)
    throw new Response(
      "The audit log failed verification. Review Activity before using Insights.",
      { status: 409 },
    );
  const [log, names] = await Promise.all([
    auditEntries(session.shop),
    feedNames(session.shop),
  ]);
  return {
    snapshot: insightsSnapshot(log, names),
    licenseKey: process.env.AG_STUDIO_LICENSE_KEY ?? "",
    enabled:
      process.env.NODE_ENV !== "production" ||
      !!process.env.AG_STUDIO_LICENSE_KEY,
    aiConfigured: insightsAiConfigured(),
  };
};
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.AG_STUDIO_LICENSE_KEY
  )
    return Response.json(
      { error: "Insights is not enabled yet." },
      { status: 503 },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json(
      { error: "Send a dashboard request as JSON." },
      { status: 415 },
    );
  // Read a bounded body before JSON parsing; never accept client tools or merchant data.
  const reader = request.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return Response.json(
          { error: "Keep the request under 800 characters." },
          { status: 413 },
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return Response.json(
      { error: "Enter a valid dashboard request." },
      { status: 400 },
    );
  }
  const parsed = InsightPromptSchema.safeParse(input);
  if (!parsed.success)
    return Response.json(
      { error: "Enter a dashboard request of 1–800 characters." },
      { status: 400 },
    );
  const key = session.shop + ":" + actor,
    now = Date.now();
  for (const [k, at] of requests) if (now - at > 60_000) requests.delete(k);
  if (now - (requests.get(key) ?? 0) < 5_000)
    return Response.json(
      { error: "Wait a few seconds before asking again." },
      { status: 429 },
    );
  if (requests.size >= 1000 && !requests.has(key))
    return Response.json(
      { error: "The assistant is busy. Try again shortly." },
      { status: 429 },
    );
  requests.set(key, now);
  try {
    return Response.json(
      await planInsightView(parsed.data.prompt, request.signal),
    );
  } catch {
    return Response.json(
      {
        error:
          "Insights assistant is unavailable. Use the purchase filters or try again later.",
      },
      { status: 503 },
    );
  }
};
export default function InsightsPage() {
  const data = useLoaderData<typeof loader>();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <s-page heading="Insights" inlineSize="large">
      <s-stack gap="base">
        <s-section>
          <s-paragraph>
            Explore recorded purchases and payment outcomes. Insights cannot
            approve purchases, send payments or change rules.
          </s-paragraph>
        </s-section>
        {!data.enabled ? (
          <s-section>
            <s-banner tone="info" heading="Insights is being set up">
              Your dashboard will be available when setup is complete.
            </s-banner>
          </s-section>
        ) : mounted ? (
          <Suspense
            fallback={
              <s-section>
                <s-text>Loading insights…</s-text>
              </s-section>
            }
          >
            <Insights {...data} />
          </Suspense>
        ) : (
          <s-section>
            <s-text>Loading insights…</s-text>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}
export const headers: HeadersFunction = (args) => {
  const headers = new Headers(boundary.headers(args));
  headers.set("Cache-Control", "private, no-store");
  return headers;
};
export { PageError as ErrorBoundary } from "../components/page-error";
