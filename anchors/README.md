# Independent audit checkpoints

Status: implementation prepared; scheduled execution requires explicit activation after provisioning and live verification. The app's internal chain check is distinct from this external verification. Historical GitHub fingerprints remain in `fingerprints.jsonl`.

The workflow runs at minute 17 every six hours (GitHub schedules may be delayed), or manually. It reads Neon directly, recomputes each enrolled store's hash chain, verifies pinned baselines and all retained R2 checkpoints, and publishes only when verified history advances. It does not wake Render, use Shopify/PayPal/AI credentials, reconcile payments, sweep inventory, or commit to the repository. Runner installation and full-history verification consume Actions minutes; measure actual usage as history grows.

## Provision before enabling

1. Activate R2 and create a private **Standard** bucket dedicated to this deployment. Choose retention (90 days is a starting proposal, not a configured value), then configure bucket-lock rules covering `checkpoints/`. Keep lifecycle deletion disabled initially. Test retention with a disposable object: overwrite and deletion must fail while protected. R2 administrators can remove lock rules: this is not administrator-proof compliance retention.
2. Create a bucket-scoped object read/write credential with no bucket-configuration privileges. Keep Cloudflare admin credentials outside the app and Actions. Confirm with separate administrative access that lock rules cover the prefix; the limited publisher deliberately cannot configure them.
3. Run `scripts/audit-reader.sql` once as the database owner. Set a random password and enable LOGIN for `guardbuy_auditor` through a secure administrative connection. Do not reuse app/owner credentials. The role can SELECT only `AuditEntry`; it cannot read Shopify sessions or alter audit data. Test the grants. Do not add inherited write privileges.
4. GitHub secrets: `AUDIT_DATABASE_URL` (dedicated role), `AUDIT_R2_ACCESS_KEY_ID`, `AUDIT_R2_SECRET_ACCESS_KEY`. Set `AUDIT_R2_ACCOUNT_ID` and `AUDIT_R2_BUCKET` as variables or secrets (variables take precedence). Do not place credentials in the repository. The publisher does not load `.env` or fall back to `DATABASE_URL`/`DIRECT_URL`.
5. Review `checkpoint-streams.json`. Each store is explicitly enrolled and pinned to an existing trusted sequence/hash from the historical repository checkpoints. New enrollment requires a separately reviewed baseline; there is no automatic discovery from a potentially compromised database. Store identifiers are hashed in R2 object paths and payloads, but this is pseudonymization, not secrecy against guessing.
6. Leave repository variable `AUDIT_CHECKPOINTS_ENABLED` unset/false during setup. Manual dispatch works while the schedule is disabled. Manually run **External audit checkpoints** with `bootstrap=true` once, after reviewing baselines. Bootstrap still verifies all hashes and the pinned baseline. Existing checkpoints are always verified, including on bootstrap. Confirm the workflow summary, then manually run again with bootstrap false: it must report unchanged and create no new checkpoint. Only then set `AUDIT_CHECKPOINTS_ENABLED=true`. Scheduled runs never bootstrap missing state.

### Credential setup without sharing passwords

The production `guardbuy_auditor` role was created through SQL on 31 October 2026, with login enabled and no password assigned. Its effective permissions were checked: it reads only `AuditEntry` among app tables, cannot modify any app table or create database/schema objects, and has no inherited roles or administrative flags. Read-only transactions and a 60-second statement timeout are its defaults. The historical sequence-13 pin matches the stored audit entry; full hash recomputation still requires the workflow to pass.

To finish credential setup, the account owner resets **only this role's password** in Neon: GuardBuy → production → Postgres database → Roles → `guardbuy_auditor` → Reset password. In Connect, choose `neondb`, `guardbuy_auditor`, and pooling off. Copy the connection string directly into the repository's GitHub Actions secret `AUDIT_DATABASE_URL`. Do not paste it into chat or replace Render's app connection with it. If creating a fresh role using the SQL file, also enable LOGIN when setting its password; that file deliberately starts with NOLOGIN.

Create limited roles with SQL. [Neon's role documentation](https://neon.com/docs/manage/roles) explains that roles created with its Console/API/CLI inherit `neon_superuser`. A password reset is different from creating a new role. The workflow checks the reader's role flags, memberships and app-table permissions each run and rejects expanded privileges.

## Security and operation

- Each object contains version, hashed stream ID, sequence, audit hash, publication time and the digest of the previous checkpoint. Conditional object creation rejects replacement; locked duplicate writes are read back and must match. No purchase contents or credentials are uploaded.
- Before verification, a disposable object at `checkpoints/retention-probes/YYYY-MM-DD.txt` must reject both overwrite and deletion with R2's explicit bucket-lock error. One tiny probe per UTC day stays stored; daily rotation avoids failures when an old probe's retention expires. A generic permission error is not accepted as proof of retention. This tests enforcement at that prefix, not the configured duration or protection against Cloudflare administrators. Keep retention longer than a day.
- The workflow uses read-only repository permissions and serializes scheduled/manual runs. Publication is per store, not atomic across stores: if a later upload fails, earlier valid checkpoints may already exist. A retry adopts matching objects safely. Verification of all stores completes before any upload.
- A failure is a failed Actions run and a failure summary. Configure GitHub Actions failure notifications for the responsible owner. The last successful external checkpoint remains the protection boundary. No new checkpoint means no new external protection.
- Entries after the repeatable-read snapshot wait for a later successful run. Six hours is a target interval, not a delivery guarantee. Hashes are evidence of changes, not backups or proof that the original event was truthful.
- Store deletion/uninstall must not silently remove enrollment. Missing checkpointed stores, shorter logs and rewrites (even with recomputed internal hashes) fail verification. Never use bootstrap to dismiss an unexplained loss of external evidence.
- Lock expiry permits privileged object deletion. This implementation verifies the linked retained history from its first checkpoint; deleting old checkpoint objects intentionally will fail verification. Plan a separately reviewed trust rollover/archive policy before pruning; do not simply delete expired objects. Keep old evidence and the roster under independent control.
- The app dashboard has not been wired to these independent results. Its existing “chain intact” result means database-internal consistency. The Actions summary lists the externally protected sequence and hash, with full hashes also in JSON logs.
- Keep ISM-133 credential rotation separate and complete it before relying on credential isolation.

## Removing the former hourly scheduler

The old `hourly.yml` (already commented out) is removed. The manually callable `/jobs/hourly` backend remains for compatibility but the new workflow never invokes it. It still combines business actions; it must not be used as a checkpoint endpoint.

Coverage review: inventory webhooks trigger restocking; opening Approvals runs the PayPal Orders sweep. **Payout reconciliation is currently invoked only by the old hourly backend job.** Without a separate app-level trigger, pending payout statuses may stay stale. This replacement intentionally does not claim equivalent payment coverage or reintroduce scheduled business actions. Resolve that gap separately before relying on unattended payout reconciliation.

## Local checks

`node --import tsx scripts/check-checkpoints.ts` runs offline tamper, truncation, checkpoint continuity, bootstrap, concurrency, duplicate and retry checks.

With dedicated credentials exported, run `node --import tsx scripts/publish-checkpoints.ts` (append `--bootstrap` only for explicitly reviewed first enrollment). Cloudflare lock behavior and the database role require live integration checks after provisioning.

References: [R2 locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/), [pricing](https://developers.cloudflare.com/r2/pricing/), [S3 SDK](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/).
