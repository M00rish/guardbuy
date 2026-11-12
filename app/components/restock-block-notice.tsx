import { useFetcher } from "react-router";
import type { RestockBlock } from "../lib/agent/restock-cooldown";
import styles from "./restock-cooldown-notice.module.css";

export function RestockBlockNotice({
  variantId,
  block,
  disabled = false,
}: {
  variantId: string;
  block: RestockBlock;
  disabled?: boolean;
}) {
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const busy = fetcher.state !== "idle";
  return (
    <aside className={styles.notice} aria-label="Automatic restock blocked">
      <strong>Automatic restocking paused after a block</strong>
      <p>
        Purchase #{block.decisionSeq} was blocked by your rules. GuardBuy keeps
        automatic restocking paused for this product until you lift the block;
        there is no time limit.
      </p>
      <p>
        Lifting the block requests a new stock check now. Your signed rules and
        every payment safeguard are still checked; if a rule still blocks the
        purchase, it stays blocked and the reason is recorded.
      </p>
      <fetcher.Form method="post" action="/app?index">
        <input type="hidden" name="intent" value="reset-restock-block" />
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="decisionSeq" value={block.decisionSeq} />
        <button type="submit" disabled={disabled || busy}>
          {busy ? "Queuing check…" : "Lift block and recheck"}
        </button>
      </fetcher.Form>
      {fetcher.data && <p role="status">{fetcher.data.message}</p>}
    </aside>
  );
}
