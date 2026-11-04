import { claimRestockJob, finishRestockJob, renewRestockJob, retryRestockJob, type ClaimedRestockJob } from "./restock-queue.server";

type JobResult = { retryAfterMs?: number };
type Handler = (job: ClaimedRestockJob) => Promise<JobResult>;
const defaultHandler: Handler = async (job) => (await import("./restock-handler.server")).handleRestockJob(job);

/** One claim per process; database claims and product/payment leases coordinate other processes. */
export async function processNextRestockJob(handle: Handler = defaultHandler) {
  const job = await claimRestockJob();
  if (!job) return null;
  const timer = setInterval(() => { void renewRestockJob(job).catch(() => {}); }, 20_000);
  timer.unref();
  try {
    const result = await handle(job);
    const acknowledged = result.retryAfterMs ? await retryRestockJob(job, result.retryAfterMs) : await finishRestockJob(job);
    return { jobId: job.id, generation: job.claimedGeneration, acknowledged, retry: !!result.retryAfterMs };
  } catch {
    const acknowledged = await retryRestockJob(job);
    return { jobId: job.id, generation: job.claimedGeneration, acknowledged, retry: true };
  } finally { clearInterval(timer); }
}

declare global {
  // eslint-disable-next-line no-var
  var guardbuyRestockWorkerStarted: boolean | undefined;
}

/** Starts with the web process, so a restart recovers queued/expired claims without another webhook. */
export function startRestockWorker() {
  if (globalThis.guardbuyRestockWorkerStarted || !process.env.DATABASE_URL || process.env.GUARDBUY_RESTOCK_WORKER === "off") return;
  if (process.env.NODE_ENV !== "production" && process.env.GUARDBUY_RESTOCK_WORKER !== "on") return;
  globalThis.guardbuyRestockWorkerStarted = true;
  const tick = async () => {
    let delay = 5000;
    try { if (await processNextRestockJob()) delay = 250; }
    catch { console.warn("[restock-worker] Queue unavailable; retrying after backoff"); }
    const timer = setTimeout(() => { void tick(); }, delay);
    timer.unref();
  };
  const timer = setTimeout(() => { void tick(); }, 1000);
  timer.unref();
}
