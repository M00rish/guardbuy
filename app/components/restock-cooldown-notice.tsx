import { useFetcher } from "react-router";
import type { RestockCooldown } from "../lib/agent/restock-cooldown";
import styles from "./restock-cooldown-notice.module.css";

export function RestockCooldownNotice({
  variantId,
  cooldown,
  disabled = false,
}: {
  variantId: string;
  cooldown: RestockCooldown;
  disabled?: boolean;
}) {
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const busy = fetcher.state !== "idle";
  return (
    <aside className={styles.notice} aria-label="Automatic restock cooldown">
      <strong>Automatic restocking paused after a decline</strong>
      <p>
        Purchase #{cooldown.decisionSeq} was declined. GuardBuy keeps automatic
        restocking paused for this product until you reset the cooldown; there
        is no time limit.
      </p>
      <p>
        Resetting requests a new stock check now. It may pay automatically if
        your current rules allow it; spending limits, existing payments and
        incoming stock are still checked.
      </p>
    <fetcher.Form method="post" action="/app?index">
        <input type="hidden" name="intent" value="reset-restock-cooldown" />
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="rejectedSeq" value={cooldown.rejectedSeq} />
        <button type="submit" disabled={disabled || busy}>
          {busy ? "Queuing check…" : "Reset cooldown and recheck"}
        </button>
      </fetcher.Form>
      {fetcher.data && <p role="status">{fetcher.data.message}</p>}
    </aside>
  );
}
