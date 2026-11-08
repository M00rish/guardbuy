import { useLoaderData } from "react-router";
import { privacyContact } from "../../lib/privacy/contact.server";
import styles from "./styles.module.css";

export const meta = () => [
  { title: "GuardBuy privacy policy" },
  { name: "description", content: "What GuardBuy reads, why it uses data, which AI services receive it, and how retention and privacy requests work." },
];
export const loader = () => Response.json({ contact: privacyContact() }, { headers: { "Cache-Control": "no-store" } });

export default function Privacy() {
  const { contact } = useLoaderData<typeof loader>();
  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <a className={styles.back} href="/">← GuardBuy</a>
        <header>
          <p className={styles.eyebrow}>Data & privacy</p>
          <h1>GuardBuy privacy policy</h1>
          <p className={styles.lede}>GuardBuy uses stock, sales totals and supplier offers to propose restocks, checks them against your rules, and records supplier payments.</p>
          <p className={styles.date}>Updated 5 November 2026 · Sandbox demo</p>
        </header>
        <aside className={styles.notice}>
          <strong>Use demo data only.</strong> This demo can send commercial information to free-tier AI services. A verified paid or no-training provider setup, including every fallback, is required before real merchant data is used. This page is a privacy notice; it is not a merchant agreement or data processing agreement.
        </aside>
        <nav className={styles.contents} aria-label="On this page">
          <a href="#data">Data we use</a><a href="#providers">AI & other services</a><a href="#retention">Retention</a><a href="#sharing">Public sharing</a><a href="#requests">Your requests</a>
        </nav>
        <section id="data">
          <h2>What we read and why</h2>
          <dl className={styles.data}>
            <div><dt>Products, stock and locations</dt><dd>Product and variant IDs, names, SKUs, inventory quantities and location IDs/names help detect low stock and record goods received. GuardBuy can write inventory adjustments when a delivery is received or demo stock is reset.</dd></div>
            <div><dt>Sales and refunds</dt><dd>Order dates, variant IDs and quantities become net daily sales totals. The restock calculation uses recent sales; the public demo also reads a count of test orders.</dd></div>
            <div><dt>Suppliers and purchasing rules</dt><dd>Supplier names, payment email addresses, prices, lead times, preferences and notes are stored with the products you link. Signed rules and staff action identifiers show who authorized purchasing.</dd></div>
            <div><dt>Shopify connection</dt><dd>Shop domains, access and refresh tokens, scopes, expiry and session information keep the app connected. Session records can include merchant staff names, email addresses and user IDs supplied by Shopify. These are not shopper profiles.</dd></div>
            <div><dt>PayPal and audit history</dt><dd>Supplier payment addresses, amounts, balances used for safety checks, provider request/payment IDs, approval links, payer IDs, payment outcomes and purchase decisions support payment execution, duplicate prevention and reconciliation. Payment account credentials stay on the server.</dd></div>
          </dl>
          <p><strong>Shopper data:</strong> GuardBuy does not request shopper names, emails, addresses, phone numbers or payment-card details for restocking, and does not store customer profiles or raw order bodies. Shopify order/refund and privacy webhooks may still deliver customer fields; the handlers use selected fields and do not persist those bodies.</p>
          <p>Supplier notes, names and AI explanations are free text. Do not put customer details, secrets or unnecessary personal information in them: text you enter can be stored in audit history or sent to AI services.</p>
        </section>
        <section id="providers">
          <h2>Which services receive data</h2>
          <p><strong>AI:</strong> Google Gemini is tried first by default. Fallbacks can go through OpenRouter to the selected model providers, including Dots Studio and NVIDIA models in the default demo chain. The operator can change the model list; attempted providers may each receive the same context.</p>
          <p>The AI context contains the SKU, stock level, sales rate, days of cover, target cover, suggested quantity, supplier IDs/names, prices, lead times, preferences and supplier notes. GuardBuy does not add Shopify tokens, PayPal credentials, payment emails, account balances or shopper records to that context. Personal information pasted into notes or names is not automatically removed.</p>
          <p>Provider retention and model-training terms depend on the account, selected model and service settings. GuardBuy has not verified a no-training configuration for the free demo chain. Review <a href="https://ai.google.dev/gemini-api/terms">Gemini API terms</a>, <a href="https://openrouter.ai/privacy">OpenRouter privacy information</a> and each selected model provider before sending real data.</p>
          <p><strong>Optional Telegram alerts:</strong> when a merchant connects and confirms a private chat, GuardBuy stores its chat ID and sends brief purchase-status messages with authenticated app links through Telegram. Messages omit supplier emails, payment IDs and purchase details. Telegram receives the chat ID, status, purchase reference and store/app link and keeps its own copies. Disconnect in Alerts to remove routing and queued messages; already sent or in-flight messages cannot be recalled.</p>
          <p><strong>Other services:</strong> Shopify provides store data; PayPal processes supplier payments and receives payment instructions. The hosted app uses Render and Neon Postgres. Cloudflare R2 stores external audit checkpoints containing hashed stream identifiers and fingerprints, not purchase contents. Hosting, database and provider logs/backups follow their own configured retention and may be processed in other countries.</p>
        </section>
        <section id="retention">
          <h2>How long information stays</h2>
          <ul>
            <li><strong>Sales aggregates:</strong> the app has a 90-day cutoff, applied during sales backfill/maintenance. Webhook deduplication IDs have a seven-day cutoff. Cleanup is not a guaranteed daily timer; rows can remain longer when maintenance does not run.</li>
            <li><strong>Connection and configuration:</strong> sessions are removed on uninstall. Product/supplier settings, sales totals and audit history are not all automatically erased by uninstall alone.</li>
            <li><strong>Telegram:</strong> pairing codes expire after ten minutes. Routing stays until disconnect, uninstall or shop-redaction. Notification history has a 30-day cutoff, applied by the running alert worker; cleanup can be delayed while it is stopped. Telegram copies require separate deletion through Telegram.</li>
            <li><strong>Audit and payment history:</strong> there is no automatic 90-day deletion. The app keeps it to reconcile payments and preserve verifiable history until a reviewed deletion or a documented legal retention requirement is resolved.</li>
            <li><strong>Privacy receipts:</strong> pending requests are kept for fulfillment. After completion, direct shop/request references are cleared; the operator removes completed receipt metadata after 90 days. A hashed shop suppression marker remains to prevent delayed events from recreating erased data, until a reviewed reconnect.</li>
            <li><strong>Logs, backups and AI/provider copies:</strong> there is no verified universal 90-day limit. These must be included in the operator’s deletion review; external checkpoints can remain subject to their retention locks.</li>
          </ul>
        </section>
        <section id="sharing">
          <h2>What can be public</h2>
          <p>The public payment verification page shows fingerprints, timestamps and outcomes when someone supplies a payment ID. Product, supplier, amount and rule details appear only if the merchant enables sharing; legacy judge test sandboxes share their test details. Payee emails, payer IDs, credentials and approval links are excluded from the public proof.</p>
          <p>The sandbox dashboard is a separate, explicit operator opt-in for the named demo store. It exposes aggregate stock, test-order counts and restock/payment outcomes. It does not expose customer records, supplier emails or payment identifiers. Shop deletion requests suppress the dashboard and payment proofs while the request is reviewed.</p>
        </section>
        <section id="requests">
          <h2>Access, correction and deletion</h2>
          {contact ? <p><a className={styles.contact} href={contact}>Contact GuardBuy about your data</a>. Include the store domain and the type of request. Do not send credentials, card details or unrelated customer records.</p>
            : <p>A direct GuardBuy privacy contact has not yet been configured. Ask your store owner to submit a data access or deletion request through Shopify’s customer privacy tools. A working direct support contact must be configured before this demo is offered to real merchants.</p>}
          <p>Shopify’s customer data-request, customer-redaction and shop-redaction webhooks are received after signature verification and saved for operator review. A receipt acknowledges the request, not completion. Requests require review and fulfillment within 30 days; a legal retention exception must be documented and reviewed.</p>
          <p>Because ordinary sales data is aggregated, it cannot be exported or removed by matching a customer ID. The operator checks any other records and free text, obtains any needed identifying details securely through the merchant, and provides the response directly to the store owner. Customer information is not posted publicly.</p>
          <p>A shop-redaction request revokes app sessions, stops new processing and suppresses public sharing. Payments already in flight may still need reconciliation. Deleting an audit entry in the middle would invalidate later records, so a reviewed shop erasure deletes the complete shop chain with separate owner privileges. Append-only storage does not override a valid deletion request or create a legal right to keep data indefinitely.</p>
          <p>PayPal transaction records, Shopify records, provider logs, backups and external checkpoints require separate review. GuardBuy cannot promise that a database deletion erases every provider copy. If data must legally be retained, the operator records the reason and restricts its use rather than claiming the request is complete.</p>
        </section>
        <footer>This notice covers GuardBuy’s sandbox demo. Changes to its data handling will be reflected here.</footer>
      </div>
    </main>
  );
}
