import { appendAuditWhen, auditEntries } from "../audit/log.server";
import { withPaymentLock } from "../agent/payment-lock.server";
import { assertPrivacyActive } from "../privacy/state.server";
import { canManageDelivery, createManageDelivery } from "./delivery-management";

export const manageDelivery = createManageDelivery({
  read: auditEntries,
  lock: (shop, fn) => withPaymentLock(shop, async () => { await assertPrivacyActive(shop); return fn(); }),
  append: async (shop, event) => !!await appendAuditWhen(shop, event, (log) => canManageDelivery(log, event)),
});
