import styles from "./payout-refresh.module.css";
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
  const navigation = useNavigation(),
    navigate = useNavigate(),
    location = useLocation(),
    revalidator = useRevalidator();
  const [visible, setVisible] = useState(true),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const params = new URLSearchParams(location.search);
  params.set("payoutRefresh", "1");
  const target = `${location.pathname}?${params}`;
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const retryAt = state.retryAt ? Date.parse(state.retryAt) : 0,
    cooling = retryAt > now;
  const refresh = useCallback(() => {
    if (`${location.pathname}${location.search}` === target)
      revalidator.revalidate();
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
      !visible ||
      (!state.running && !state.retryAt) ||
      !(
        state.running ||
        watch ||
        state.awaitingConfirmation ||
        state.incomplete ||
        state.scheduled
      )
    )
      return;
    const timer = setTimeout(
      () => {
        if (document.visibilityState !== "hidden") refresh();
      },
      state.running ? 5000 : Math.max(1000, retryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [
    busy,
    visible,
    state.running,
    state.retryAt,
    state.awaitingConfirmation,
    state.incomplete,
    state.scheduled,
    watch,
    retryAt,
    refresh,
  ]);
  return (
    <section className={styles.panel} aria-label="Supplier payout status">
      <div className={styles.row}>
        <div>
          <strong>Supplier payout status</strong>
          <p className={styles.meta}>
            {state.running
              ? "Checking payouts…"
              : state.failed
                ? "Some checks failed. Showing recorded statuses."
                : state.awaitingConfirmation
                  ? "Waiting for PayPal confirmation"
                  : "Showing recorded statuses"}
            {state.checkedAt &&
              ` · Last check ${readableTime(state.checkedAt)}`}
          </p>
        </div>
        <s-button onClick={refresh} disabled={state.running || busy || cooling}>
          {COPY.refreshPayouts}
        </s-button>
      </div>
      <details>
        <summary>How status checks work</summary>
        <p>
          Pending payouts are checked less often when unchanged (5–60 minutes).
          Confirmed payouts are checked at most daily for returns or refunds
          while the app is in use. Hidden tabs pause automatic checks. These
          checks never submit a payment.
        </p>
        {state.retryAt && (
          <p>Next scheduled check: {readableTime(state.retryAt)}.</p>
        )}
        {state.incomplete && (
          <p>
            More payouts are due. The next bounded group will refresh
            automatically.
          </p>
        )}
      </details>
    </section>
  );
}
