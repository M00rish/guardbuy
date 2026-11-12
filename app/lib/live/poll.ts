export const LIVE_INTERVAL = 5_000;
const FALLBACK_INTERVAL = 60_000;

export function livePage(pathname: string, search: string) {
  if (pathname === "/app/rules")
    return new URLSearchParams(search).get("tab") !== "rules";
  if (pathname === "/app/products")
    return new URLSearchParams(search).get("tab") !== "suppliers";
  return ["/app", "/app/activity", "/app/deliveries"].includes(pathname);
}

/** Sequential, bounded polling; failures retain the visible data and retry with backoff. */
export function startLivePolling(ports: {
  ready: () => boolean;
  revision: (signal: AbortSignal) => Promise<string>;
  refresh: () => Promise<void>;
  now: () => number;
  schedule: (fn: () => void, delay: number) => () => void;
}) {
  let stopped = false,
    revision: string | undefined,
    refreshedAt = 0,
    failures = 0;
  const controller = new AbortController();
  let cancel = () => {};
  async function tick() {
    if (stopped) return;
    try {
      if (ports.ready()) {
        const next = await ports.revision(controller.signal);
        if (stopped) return;
        if (ports.ready()) {
          // Initial refresh covers changes between loading the page and the first poll.
          // The fallback also covers time-based expiry or a delayed/missed Shopify webhook.
          if (
            revision !== next ||
            ports.now() - refreshedAt >= FALLBACK_INTERVAL
          ) {
            await ports.refresh();
            refreshedAt = ports.now();
          }
          revision = next;
          failures = 0;
        }
      }
    } catch {
      failures = Math.min(failures + 1, 4);
    } finally {
      if (!stopped)
        cancel = ports.schedule(
          () => {
            void tick();
          },
          LIVE_INTERVAL * 2 ** failures,
        );
    }
  }
  cancel = ports.schedule(() => {
    void tick();
  }, 0);
  return () => {
    stopped = true;
    cancel();
    controller.abort();
  };
}
