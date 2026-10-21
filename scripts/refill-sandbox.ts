// Sandbox only: keeps the demo running by sending money back from the supplier's sandbox account
// (which receives every demo payout) to the merchant's, up to a target balance.
// Uses the supplier's own PayPal app keys; the merchant's account id comes from its own records.
//   npx tsx scripts/refill-sandbox.ts            (tops the merchant up to $4,000)
//   REFILL_TARGET=5000 npx tsx scripts/refill-sandbox.ts
export {};
process.loadEnvFile(".env");

const { paypal } = await import("../app/lib/paypal/client.server");

const base = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
if (!base.includes("sandbox")) throw new Error("refill-sandbox only runs against the PayPal sandbox");

const supplier = { clientId: process.env.SUPPLIER_PAYPAL_CLIENT_ID!, clientSecret: process.env.SUPPLIER_PAYPAL_CLIENT_SECRET! };
const target = Math.round(Number(process.env.REFILL_TARGET ?? 4000) * 100);
type Bal = { balances?: { currency: string; available_balance?: { value: string } }[] };
const cents = (b: Bal) => Math.round(Number(b.balances?.find((x) => x.currency === "USD")?.available_balance?.value ?? 0) * 100);
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const merchant = cents(await paypal<Bal>("/v1/reporting/balances?currency_code=USD"));
const supplierBal = cents(await paypal<Bal>("/v1/reporting/balances?currency_code=USD", { creds: supplier }));
console.log(`merchant ${usd(merchant)} · supplier ${usd(supplierBal)} · target ${usd(target)}`);
const need = target - merchant;
if (need <= 0) { console.log("Merchant is at or above the target; nothing to do."); process.exit(0); }
if (need > supplierBal - 10_000) throw new Error(`Supplier can't cover ${usd(need)} and keep $100`);

// The merchant's PayPal account id, from the merchant's own transaction search.
const end = new Date().toISOString().slice(0, 19) + "Z";
const start = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19) + "Z";
const { account_number } = await paypal<{ account_number?: string }>(`/v1/reporting/transactions?start_date=${start}&end_date=${end}&fields=transaction_info&page_size=1`);
if (!account_number) throw new Error("Couldn't read the merchant's PayPal account id");

const batchId = `gb-refill-${new Date().toISOString().slice(0, 13)}`; // at most one refill per hour
const res = await paypal<{ batch_header: { payout_batch_id: string; batch_status: string } }>("/v1/payments/payouts", {
  method: "POST",
  creds: supplier,
  requestId: batchId,
  body: {
    sender_batch_header: { sender_batch_id: batchId, email_subject: "GuardBuy sandbox refill" },
    items: [{ recipient_type: "PAYPAL_ID", receiver: account_number, amount: { value: (need / 100).toFixed(2), currency: "USD" }, note: "Sandbox only: returning demo payouts so the demo keeps running", sender_item_id: batchId }],
  },
});
console.log(`Sent ${usd(need)} supplier -> merchant: batch ${res.batch_header.payout_batch_id} (${res.batch_header.batch_status})`);

await new Promise((r) => setTimeout(r, 8000));
console.log(`merchant now ${usd(cents(await paypal<Bal>("/v1/reporting/balances?currency_code=USD")))}`);
