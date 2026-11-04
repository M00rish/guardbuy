# Privacy operations (ISM-42)

Public notice: `/privacy`. Configure `GUARDBUY_PRIVACY_CONTACT` to a public HTTPS support URL or `mailto:` address before real merchants. This notice does not establish a merchant agreement or DPA. Keep Partner Dashboard “privacy agreements” set to **No** until actual agreements exist.

## Deployment and receipt

1. Apply migrations with the owner connection (`prisma migrate deploy`) before starting this version. The new `PrivacyRequest`/`PrivacyBlock` tables grant the app SELECT/INSERT only; fulfillment and lifting blocks require the offline owner. Existing audit UPDATE/DELETE/TRUNCATE restrictions remain.
2. Release the updated `shopify.app.toml` so Shopify actually subscribes the three `compliance_topics` to `/webhooks/privacy`. A code PR or local config validation does not activate hosted subscriptions. No new scopes are needed.
3. Verify real signed deliveries on the isolated sandbox app, including after uninstall when no session exists. Invalid HMAC must return 401; a signed body whose shop domain disagrees with the delivery header must return 400. Database failure must return non-2xx so Shopify retries. Do not log the webhook body.
4. Run `npx tsx scripts/privacy-requests.ts list` **daily** with the reviewed owner `DIRECT_URL` exported by your normal secret setup. This command does not load `.env` implicitly. No automatic privacy queue scheduler or notification service is enabled. Every pending request needs an owner; `dueAt` is 30 days from receipt, and duplicate deliveries do not extend it.

The inbox stores only event ID, topic, authenticated shop, a hashed shop identifier, optional Shopify data-request ID, timestamps and status. Customer identities, requested order IDs and the webhook body are discarded. For any needed customer identity, retrieve it securely from the store owner/Shopify request record using the receipt reference. Never put personal data in CLI arguments, review ticket titles, comments or logs. A 200 acknowledges **receipt**, not fulfillment.

## Customer requests

GuardBuy's ordinary sales records contain only variant/day/unit aggregates, so they cannot be matched back to a particular customer. Do not attempt to reconstruct a customer's purchases from those totals.

- For `customers/data_request`, review data stores and free text for customer information inadvertently supplied by a merchant (supplier notes/names, saved AI reasoning, audit errors and operational logs). If none is held, send a clear no-customer-specific-data response **directly to the store owner**. Otherwise provide the applicable data securely and arrange correction/deletion as needed. The webhook does not send this response automatically.
- For `customers/redact`, perform the same scoped review. An aggregate-only result can require no customer-row deletion, but must still be reviewed and documented. If customer information is found in an audit chain, do not edit individual rows or silently rewrite its hashes. Work with the merchant on a reviewed whole-shop deletion or a separately reviewed redaction/migration that also handles external checkpoints. This PR provides whole-shop erasure, not selective audit rewriting.
- After actual fulfillment, record an external case reference (no personal data) using `npx tsx scripts/privacy-requests.ts complete-customer --id REQUEST_ID --reference CASE_REFERENCE`. The tool stores only a hash of the reference, clears direct shop/request references, and marks the receipt complete. The operator must maintain the secure case record separately.
- If retention is **legally required**, document the precise legal reason, retained scope, access restrictions and review/end date externally, then use `... legal-hold --id REQUEST_ID --reference CASE_REFERENCE`. This leaves the request open. Audit integrity, an inconvenient migration or an uncertain payment is not by itself a legal basis for indefinite retention. Resolve payment uncertainty promptly; obtain legal review if a deadline cannot be met. After reviewing and resolving the legal basis, use `... release-hold --id REQUEST_ID --reference CASE_REFERENCE` to return it to pending fulfillment. The tool refuses deletion while the hold remains.

## Shop erasure

On `shop/redact`, the handler atomically records the request, creates a suppression marker, removes sessions, disables verification-detail settings and drops queued restock jobs. Authenticated app pages, public proofs and cached dashboard requests check suppression. Database triggers prevent late sales/configuration/session/job writes; payment safety checks refuse new submissions once suppression is observed. A request already in flight can still have reached PayPal: reconciliation is mandatory. Read-only settlement evidence may still append until erasure.

Before running the owner erasure command:

1. Confirm the exact request/shop and any lawful retention exception. Revoke any remaining Shopify credentials, remove the shop from `GUARDBUY_PAYPAL_STORES` and the public demo config, and stop app/worker processing for the maintenance window. Do not send replacement payments.
2. Reconcile pending/unknown PayPal attempts and delivery commitments. Preserve only any legally required records in a separately controlled system with a documented retention basis. The tool refuses installed sessions, live payment/product/approval leases and unresolved commitments. It never deletes an unresolved attempt to release its reservation. Suppression may require offline owner-assisted reconciliation; normal UI is intentionally blocked.
3. Review Render logs, Neon backups/recovery history, secure exports, test artifacts, Shopify/PayPal records, Gemini/OpenRouter/model-provider copies and any other external storage. Follow each service's deletion/retention process. Do not claim those copies disappear when the primary DB is erased.
4. Review `anchors/checkpoint-streams.json` and external fingerprint/checkpoint histories. Unenroll the erased stream from publishing through a reviewed change so missing history is not misreported as tampering. External checkpoints contain hashed identifiers/fingerprints, not purchase bodies, and may remain until retention locks expire. Hashes are pseudonymous, not guaranteed anonymous; document retained scope and expiration. Do not bypass a lock or manufacture a replacement chain matching old fingerprints.
5. Record the actual external review/actions and any lawful residual retention in a secure case. Then run:

   ```sh
   npx tsx scripts/privacy-requests.ts purge-shop --id REQUEST_ID --confirm-shop exact-shop.myshopify.com --reference CASE_REFERENCE
   ```

The offline tool uses `DIRECT_URL`. It locks the shop, checks unresolved commitments, opts into the append-only exception for that transaction, and deletes the **entire shop chain**, not a middle entry. It also deletes mutable shop data, clears direct references in the completed receipt and marks the suppression hash as erased. Normal app credentials cannot perform this operation. The tool does not delete external data or establish that your legal review was correct.

Verify primary DB counts and public 404s afterwards; record the response to the merchant. Pending customer requests for the same shop still need their own reviewed response; do not silently mark all requests fulfilled. Run `npx tsx scripts/privacy-requests.ts prune-receipts` daily to remove completed receipt metadata older than 90 days. Pending/legal-hold receipts do not expire automatically. The minimal hashed suppression marker stays until a separately reviewed reconnect, to prevent delayed events or stale workers recreating data. Reconnect requires confirming the old request is fulfilled, credentials/merchant consent are fresh, old workers are stopped and external stream enrollment is correct; there is no automatic unblock on reinstall.

## Retention and AI limitations

`DailySales` uses a 90-day cutoff and webhook deduplication IDs seven days, but pruning currently runs with backfill/maintenance, not a guaranteed daily scheduled job. An inactive shop can retain older rows. Audit history and supplier/session configuration do not have a universal 90-day TTL. Do not advertise blanket automatic 90-day deletion. Verify hosted log, backup and checkpoint retention separately; the repository cannot establish those settings.

AI input contains SKU/stock/sales/coverage, target cover, suggested quantity and supplier IDs/names/prices/lead times/preferences/notes. It excludes intentionally supplied shopper fields, payment addresses, account balances and credentials. Free text can still contain personal data pasted by a merchant. Default routing tries Google Gemini and OpenRouter model providers (currently including Dots Studio/NVIDIA); failed attempts/fallbacks can each receive the same context. No verified no-training/free-tier retention claim is made. Before real merchant data, select a paid or no-training provider/account, verify its current processing/training/retention/region terms and verify **every fallback**, or disable the unwanted routes. Do not buy a paid tier or change credentials without the owner's separate authorization.

Shopify reference: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
