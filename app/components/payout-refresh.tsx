import { useEffect } from "react";
import { useNavigation, useNavigate, useLocation } from "react-router";
import type { RefreshState } from "../lib/paypal/payout-refresh";

export function PayoutRefresh({ state }: { state: RefreshState }) {
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set("payoutRefresh", "1");
  const target = `${location.pathname}?${params}`;
  const busy = navigation.state !== "idle";
  useEffect(() => {
    if (!state.running || busy) return;
    const timer = setTimeout(() => { navigate(target, { replace: true }); }, 5_000);
    return () => clearTimeout(timer);
  }, [state.running, busy, navigate, target, state]);
  return (
    <s-section heading="Supplier payout status">
      <s-stack gap="small-200">
        <s-text>
          {state.running ? "Checking existing payouts with PayPal…" : state.failed
            ? "Some payout checks failed. Showing the last recorded status; try refreshing again in a minute."
            : state.incomplete ? "Checked a group of payouts. Refresh again in a minute to check the next group."
            : "Existing payout statuses checked with PayPal."}
        </s-text>
        {state.awaitingConfirmation && <s-text>Some final statuses are still awaiting confirmation in PayPal’s transaction records.</s-text>}
        {state.checkedAt && <s-text tone="neutral">Last successful check: {state.checkedAt}</s-text>}
        <s-text tone="neutral">Statuses refresh when you visit Activity or Approvals, at most once a minute. This check does not send payments.</s-text>
        <s-button onClick={() => navigate(target, { replace: true })} disabled={state.running || busy}>Refresh payout statuses</s-button>
      </s-stack>
    </s-section>
  );
}
