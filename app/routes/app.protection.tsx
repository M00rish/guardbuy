import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { scoreboard } from "../lib/agent/scoreboard.server";

// What GuardBuy's rules stopped: real purchases blocked or sent for approval, which rules did it,
// and the results of any attack tests. Computed from the hash-chained log.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return scoreboard(session.shop);
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function Protection() {
  const { real, attacks, stoppedBy } = useLoaderData<typeof loader>();
  const fooled = attacks.blocked + attacks.flagged + attacks.slipped;

  return (
    <s-page heading="Protection">
      <s-section heading="Your purchases">
        <s-stack gap="small-200">
          <s-text>
            {real.decisions} purchases checked. {real.blocked} blocked ({usd(real.blockedCents)}), {real.approval} sent to you for
            approval ({usd(real.approvalCents)}).
          </s-text>
          {stoppedBy.length > 0 ? (
            <s-text tone="neutral">Rules that blocked something: {stoppedBy.map((r) => `${r.rule} (${r.count})`).join(", ")}</s-text>
          ) : (
            <s-text tone="neutral">No rule has had to block anything yet.</s-text>
          )}
        </s-stack>
      </s-section>

      {attacks.tried + attacks.simulated.tried > 0 && (
        <s-section heading="Attack tests">
          <s-stack gap="small-200">
            <s-text>
              {attacks.tried} attacks tried. The AI was fooled {fooled} times; the rules blocked {usd(attacks.blockedCents)} and held{" "}
              {usd(attacks.flaggedCents)} for a person.
            </s-text>
            {attacks.knownGaps.map((g) => (
              <s-banner key={g.title} tone="warning" heading={`Known gap: ${g.title}`}>
                Would have moved money ({usd(attacks.slippedCents)} across known gaps). Fix planned: {g.fix}
              </s-banner>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
