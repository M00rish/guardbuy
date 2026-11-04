// Offline operator workflow; reads DIRECT_URL from the environment, never implicitly loads .env.
// See docs/privacy-operations.md. Never paste credentials or customer payloads into command arguments.
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { completeCustomerRequest, purgeShopRequest } from "./lib/privacy-operator";
const [command, ...args] = process.argv.slice(2);
const arg = (key: string) => args[args.indexOf(key) + 1];
if (!process.env.DIRECT_URL) throw new Error("Set DIRECT_URL to the reviewed database owner connection.");
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
try {
  if (command === "list") {
    const rows = await owner.privacyRequest.findMany({ where: { status: { in: ["pending", "legal_hold"] } }, select: { id: true, shop: true, topic: true, requestId: true, dueAt: true, status: true }, orderBy: { dueAt: "asc" } });
    console.log(JSON.stringify(rows, null, 2));
  } else if (command === "prune-receipts") {
    console.log(await owner.privacyRequest.deleteMany({ where: { status: "completed", completedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } }));
  } else {
    const id = arg("--id"), reference = arg("--reference");
    if (!args.includes("--id") || !id || !args.includes("--reference") || !reference?.trim() || reference.length > 200) throw new Error("Use --id and --reference (external review ticket, no personal data).");
    if (command === "purge-shop") {
      const shop = arg("--confirm-shop");
      if (!args.includes("--confirm-shop") || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error("Confirm the exact shop domain with --confirm-shop.");
      console.log(await purgeShopRequest(owner, id, shop, reference));
    } else if (command === "complete-customer") {
      await completeCustomerRequest(owner, id, reference);
      console.log("Customer request marked fulfilled after operator review.");
    } else if (command === "legal-hold" || command === "release-hold") {
      const result = await owner.privacyRequest.updateMany({ where: { id, status: command === "legal-hold" ? "pending" : "legal_hold" }, data: { status: command === "legal-hold" ? "legal_hold" : "pending", referenceHash: createHash("sha256").update(reference).digest("hex") } });
      if (result.count !== 1) throw new Error("Request status changed or is already complete; inspect it before changing a legal hold.");
      console.log("Reviewed legal-hold state recorded; request remains open for fulfillment.");
    } else throw new Error("Commands: list, purge-shop, complete-customer, legal-hold, release-hold, prune-receipts.");
  }
} finally { await owner.$disconnect(); }
