// Entry bundled by check-payment-workers.ts with ONLY external provider/AI/Shopify reads replaced.
import db from "../../app/db.server";
import { executePurchase, createApprovalOrder, captureApprovalOrder, resumePayment } from "../../app/lib/agent/execute.server";
import { approvePurchase, rejectPurchase } from "../../app/lib/agent/approvals.server";
import { runRestock } from "../../app/lib/agent/restock.server";
import { processNextRestockJob, startRestockWorker } from "../../app/lib/jobs/restock-worker.server";
import { sweepPayPalOrders } from "../../app/lib/paypal/orders-sweep.server";

const input = JSON.parse(process.argv[2]) as { action: string; shop: string; decisionSeq: number; jobId?: string };
process.send?.({ ready: true });
await new Promise<void>((resolve) => process.once("message", () => resolve()));
try {
  let result: unknown;
  switch (input.action) {
    case "payout": result = await executePurchase(input.shop, input.decisionSeq); break;
    case "approve": result = await approvePurchase(input.shop, input.decisionSeq, "shopify-staff:worker-test"); break;
    case "decline": result = await rejectPurchase(input.shop, input.decisionSeq, "shopify-staff:worker-test"); break;
    case "order": result = await createApprovalOrder(input.shop, input.decisionSeq, "https://example.test/paypal/return"); break;
    case "capture": result = await captureApprovalOrder(input.shop, input.decisionSeq); break;
    case "sweep": result = await sweepPayPalOrders(input.shop); break;
    case "resume": result = await resumePayment(input.shop, input.decisionSeq); break;
    case "drain": result = await processNextRestockJob(); break;
    case "startup": {
      startRestockWorker();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const job = await db.restockJob.findFirst({ where: { shop: input.shop } });
        if (job && job.completedGeneration === job.generation) { result = { completedGeneration: job.completedGeneration }; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!result) throw new Error("Startup worker did not drain the saved job");
      break;
    }
    case "stale-cover": result = await runRestock(input.shop, { variantId: "123", sku: "coffee", available: 1, perDay: 2, daysOfCover: 0.5, incoming: 999, projectedDaysOfCover: 999, needsRestock: false }); break;
    case "restock": result = await runRestock(input.shop, { variantId: "123", sku: "coffee", available: 1, perDay: 2, daysOfCover: 0.5, needsRestock: true }, { jobId: input.jobId }); break;
    default: throw new Error("Unknown worker action");
  }
  process.send?.({ ok: true, result });
} catch (error) { process.send?.({ ok: false, error: { name: (error as Error).constructor.name, message: (error as Error).message } }); }
finally { await db.$disconnect(); process.disconnect?.(); }
