import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";

import { verifyPayment } from "../../lib/audit/verify.server";
import styles from "./styles.module.css";

// Public page: anyone can check a GuardBuy payment against the hash-chained audit log.
// No login; the PayPal id is the only input. Hashes and outcomes by default; details only when the
// merchant chose to share them.

export const meta = () => [
  { title: "Verify a GuardBuy payment" },
  { name: "description", content: "Check that a PayPal payment made by GuardBuy is on its tamper-evident log, and which signed rules allowed it." },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const id = (new URL(request.url).searchParams.get("id") ?? "").trim().slice(0, 64);
  return { id, proof: id ? await verifyPayment(id) : null };
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
const short = (h: string) => `${h.slice(0, 16)}…`;

export default function Verify() {
  const { id, proof } = useLoaderData<typeof loader>();
  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <a className={styles.back} href="/">← GuardBuy</a>
        <p className={styles.eyebrow} style={{ marginTop: 18 }}>Verify a payment</p>
        <h1 className={styles.heading}>Was this payment allowed by the merchant's rules?</h1>
        <p className={styles.lede}>
          Paste a PayPal payout batch ID, order ID or capture ID. GuardBuy recomputes its audit log from the first entry and
          shows the chain of steps that led to the payment.
        </p>

        <Form className={styles.search} method="get">
          <input className={styles.input} name="id" defaultValue={id} placeholder="e.g. N6N53JKC8QNVN" aria-label="PayPal payout batch, order or capture ID" autoComplete="off" />
          <button className={styles.button} type="submit">Verify</button>
        </Form>

        {proof && !proof.found && (
          <section className={styles.result}>
            <span className={styles.none}>Not found</span>
            <p className={styles.note}>No GuardBuy payment has this ID. Check that you copied the whole PayPal ID.</p>
          </section>
        )}

        {proof?.found && (
          <section className={styles.result}>
            <span className={proof.chain.valid ? styles.ok : styles.bad}>
              {proof.chain.valid ? "Verified: on the log, chain intact" : "Warning: the audit log failed verification"}
            </span>
            {proof.demo && <span className={styles.none} style={{ marginLeft: 8 }}>Demo session</span>}

            <dl className={styles.facts}>
              <dt>Paid</dt>
              <dd>{when(proof.paidAt)} via {proof.paidBy}</dd>
              <dt>How</dt>
              <dd>{proof.how === "automatic" ? "Automatically, within the merchant's signed rules" : `Approved by ${proof.approvedByKind ?? "a person"}`}</dd>
              <dt>Rules in force</dt>
              <dd>{proof.rulesFingerprint ? <><span className={styles.mono}>{short(proof.rulesFingerprint)}</span>{proof.rulesSignedAt ? `, signed ${when(proof.rulesSignedAt)}` : ""}</> : "Unknown"}</dd>
              <dt>Audit log</dt>
              <dd>{proof.chain.valid ? `${proof.chain.length} entries, every fingerprint recomputed and matching` : `Broken at entry #${proof.chain.brokenAtSeq}: ${proof.chain.reason}`}</dd>
              {proof.details && (
                <>
                  <dt>Purchase</dt>
                  <dd>{proof.details.quantity} × {proof.details.product} from {proof.details.supplier}</dd>
                  <dt>Amount</dt>
                  <dd>{proof.details.amount} ({proof.details.unitPrice} each)</dd>
                  {proof.details.aiModel && (<><dt>Proposed by</dt><dd>{proof.details.aiModel}</dd></>)}
                </>
              )}
            </dl>

            <ol className={styles.steps}>
              {proof.steps.map((s) => (
                <li key={s.seq} className={s.step.startsWith("Paid") ? styles.pay : undefined}>
                  <div className={styles.title}>#{s.seq} · {s.step}</div>
                  <div className={styles.meta}>{when(s.at)}{s.note ? ` · ${s.note}` : ""}</div>
                  <div className={`${styles.meta} ${styles.mono}`}>fingerprint {short(s.hash)} · follows {short(s.prevHash)}</div>
                  {s.step === "Rules checked it" && proof.details && (
                    <ul className={styles.checks}>
                      {proof.details.checks.map((c) => <li key={c.rule}>{c.outcome === "auto" ? "✓" : c.outcome === "approval" ? "!" : "✕"} {c.rule}: {c.detail}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ol>

            <p className={styles.note}>
              Each fingerprint covers the entry and the fingerprint before it, so changing, deleting or reordering any past entry
              breaks every fingerprint after it.
              {!proof.details && " The merchant hasn't chosen to share purchase details, so only fingerprints and outcomes are shown."}
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
