import { useFetcher } from "react-router";
import type { RestockCooldown } from "../lib/agent/restock-cooldown";
import { readableTime } from "../lib/format";
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
        Purchase #{cooldown.decisionSeq} was declined. GuardBuy waits 24 hours
        before proposing another purchase for this product, until{" "}
        <time dateTime={cooldown.until}>{readableTime(cooldown.until)}</time>. A
        fresh check will run when the cooldown ends.
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
