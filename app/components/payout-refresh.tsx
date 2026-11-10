import { useCallback, useEffect, useState } from "react";
import {
  useNavigation,
  useNavigate,
  useLocation,
  useRevalidator,
} from "react-router";
import type { RefreshState } from "../lib/paypal/payout-refresh";
import { COPY } from "../lib/wording";
import { readableTime } from "../lib/format";

export function PayoutRefresh({
  state,
  watch = false,
}: {
  state: RefreshState;
  watch?: boolean;
}) {
  const navigation = useNavigation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const location = useLocation();
  const [now, setNow] = useState(Date.now);
  const params = new URLSearchParams(location.search);
  params.set("payoutRefresh", "1");
  const target = `${location.pathname}?${params}`;
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const retryAt = state.retryAt ? Date.parse(state.retryAt) : 0;
  const cooling = retryAt > now;
  const refresh = useCallback(() => {
    // Navigating to an unchanged status URL must still reload its server data.
    if (`${location.pathname}${location.search}` === target) revalidator.revalidate();
    else navigate(target, { replace: true });
  }, [location.pathname, location.search, target, revalidator, navigate]);
  useEffect(() => {
    if (!cooling) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, retryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [cooling, retryAt]);
  useEffect(() => {
    if (
      busy ||
      !(
        state.running ||
        watch ||
        state.awaitingConfirmation ||
        state.incomplete
      )
    )
      return;
    const timer = setTimeout(
      refresh,
      state.running ? 5_000 : Math.max(1_000, retryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [
    busy,
    state.running,
    state.awaitingConfirmation,
    state.incomplete,
    watch,
    retryAt,
    refresh,
  ]);
  return (
    <s-section heading="Supplier payout status">
      <s-stack gap="small-200">
        <s-text>
          {state.running
            ? "Checking existing payouts with PayPal…"
            : state.failed
              ? "Some payout checks failed. Showing the last recorded status; try refreshing again in a minute."
              : state.incomplete
                ? "Checked a group of payouts. The next group will refresh automatically."
                : "Existing payout statuses checked with PayPal."}
        </s-text>
        {state.awaitingConfirmation && (
          <s-text>
            Some final statuses are still awaiting confirmation in PayPal’s
            transaction records.
          </s-text>
        )}
        {state.checkedAt && (
          <s-text tone="neutral">
            Last successful check: {readableTime(state.checkedAt)}
          </s-text>
        )}
        {cooling && !state.running && (
          <s-text tone="neutral">
            Next status check available at {readableTime(state.retryAt!)}.
            {watch || state.awaitingConfirmation || state.incomplete
              ? " Pending results will refresh automatically."
              : ""}
          </s-text>
        )}
        <s-text tone="neutral">
          Checks read existing payments and never submit a payment. PayPal
          checks are limited to once a minute.
        </s-text>
        <s-button onClick={refresh} disabled={state.running || busy || cooling}>
          {COPY.refreshPayouts}
        </s-button>
      </s-stack>
    </s-section>
  );
}
