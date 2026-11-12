# GuardBuy

**An AI restocking agent for Shopify that can't overspend.** The AI proposes what to reorder. A deterministic policy engine, running rules the merchant signed, decides. PayPal pays the supplier. Every step is written to a hash-chained audit log that anyone can verify.

GuardBuy was built for the PayPal AI Hackathon. This repository is public and [MIT licensed](#license).

## What GuardBuy does

Small Shopify merchants reorder stock by hand: watch inventory, guess quantities, email the supplier, pay. GuardBuy automates that loop without handing an LLM the merchant's PayPal account.

- Shopify inventory webhooks and recorded sales tell GuardBuy when a product is running low.
- The AI proposes a purchase (supplier, quantity and its reasoning) from suppliers the merchant linked.
- A deterministic policy engine checks the proposal against signed limits: price cap, accepted price, order size versus history, new or lookalike suppliers, recent payee changes, split orders, spending caps, cash floor and approval limit. The strictest result wins: **allow**, **needs a person**, or **block**.
- Only after the rules allow it does one executor move money through PayPal, and the rules are re-checked at payment time.
- Every proposal, decision, approval and payment is appended to a hash-chained audit log. A public page verifies a PayPal payment against it.

The AI never chooses the payee, never edits the rules and never moves money. Supplier text and model output are treated as untrusted, and the audit log is append-only in the database role GuardBuy runs as.

## How GuardBuy uses PayPal

| What | How GuardBuy uses it |
| --- | --- |
| **Payouts API** (`/v1/payments/payouts`) | Pays suppliers for purchases the rules allow, or that a staff member approved in GuardBuy |
| **Orders API v2** (`/v2/checkout/orders`) | "Approve in PayPal": an order with the supplier as payee, approved by the merchant in PayPal, then captured |
| **Balances** (`/v1/reporting/balances`) | Cash-floor rule, adjusted for PayPal's reporting lag |
| **Agent Toolkit: `get_order`** | Checks order status on return from PayPal and in the background sweep |
| **Agent Toolkit: `list_transactions`** | Confirms each payout in PayPal's own transaction records |
| **Payout webhooks** (`/paypal/webhook`) | Verified payout updates; notifications are never used as payment proof |

Only the read-only Agent Toolkit tools (`get_order`, `list_transactions`) are loaded. Payments use idempotency keys, a database lock and durable request snapshots, so a double click, a second tab or a retry cannot pay twice. Uncertain outcomes keep the product and budget reserved until PayPal reports a definitive result. All payment tests run against PayPal **sandbox** accounts, and the kill switch (`GUARDBUY_PAYMENTS_DISABLED=1`) refuses every payout and capture.

## How GuardBuy uses AI

- **Proposals.** The [Vercel AI SDK](https://ai-sdk.dev/) calls Google Gemini (`@ai-sdk/google`) with OpenRouter fallback models (`@openrouter/ai-sdk-provider`). The model receives stock, sales speed, coverage, the merchant's target quantity, and supplier ids, names, prices, lead times, preferences and notes — never Shopify or PayPal credentials, balances, payment emails or shopper records.
- **Untrusted output.** The model returns a supplier, quantity and explanation. It cannot choose a payee, change a rule, approve a payment or call PayPal. Every field is validated, and the policy engine decides independently of the explanation. The explanation is shown to the merchant as "not verified".
- **Adversarial tests.** The app ships prompt-injection scenarios where a supplier note tells the AI to ignore rules or pay a different address. The AI may be fooled; the signed rules still block or hold the purchase, and the scoreboard records what happened.
- **Analytics assistant.** An optional assistant answers questions about products, purchases, budgets and rules. Routine intents are planned in the browser from the staff-authorized snapshot; unknown questions use a bounded planner that returns a strict query schema. It is read-only and refuses payment or write requests.
- **Failures are labelled.** Provider errors are mapped to sanitized categories (missing configuration, rejected credentials, quota, unavailable model, timeout, invalid output) without exposing prompts or provider bodies.

## Tools and technologies

| Layer | Used |
| --- | --- |
| Runtime and app | TypeScript, Node.js 22.12+, React 18, React Router 7, Vite |
| Shopify | Shopify app template and CLI, App Bridge, Polaris web components, Admin GraphQL API `2026-10`, app proxy, webhooks |
| Data | Prisma 6 on PostgreSQL (Neon in the reference deployment), hand-written migrations, a restricted append-only app role |
| AI | Vercel AI SDK, Google Gemini, OpenRouter fallback models |
| Payments | PayPal Payouts, Orders v2, Reporting/Balances, the PayPal Agent Toolkit and verified sandbox webhooks |
| UI data views | AG Grid Enterprise 36.3, AG Charts Enterprise 14.3 and AG Studio 3.1 (licensed, browser-only keys) |
| Hosting and CI | Render (web service and [`render.yaml`](render.yaml)), GitHub Actions for CI and the independent audit-checkpoint workflow |
| Optional services | Telegram Bot API for merchant alerts, Cloudflare R2 for external audit checkpoints |
| Checks | Node assertion scripts run with `tsx`, disposable local Postgres in CI, ESLint and `tsc` |

**Hackathon sponsor integrations:** PayPal (Payouts, Orders, Agent Toolkit, sandbox webhooks) and Render (hosting and deployment). The project does not use APIMatic or Postman.

## Judge deployment and testing

Use this guide to deploy your own GuardBuy instance and Shopify development store. Give it to your coding agent; the agent performs the setup and tests, while you supply credentials through a local `.env` file or your hosting service’s secret manager.

**Fresh accounts still require their owner to sign in and approve Shopify installation/permissions. PayPal account creation, service entitlements and Telegram pairing may also require owner interaction. This repository does not automate those provider requirements.** An agent can handle the remaining commands and browser setup once accounts are accessible.

## Before handing the repository to your agent

**Trying the existing app needs none of the accounts below:** open [the public judge demo](https://guardbuy.onrender.com/demo). No Shopify login, installation or credentials are needed but this is a very limited basic experience.

**Recommended: Deploying your own copy is agent-assisted, not a one-click installer.** The repository does not create provider accounts or obtain their permissions from environment keys. Have the following ready:

| Judge supplies or authorizes                                                                                                                                | What the agent can do afterwards                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub account and repository access**                                                                                                                    | Fork/clone the public repository and connect the fork to Render. A separate fork avoids deploying changes from the original demo unexpectedly.                                                                                                                                                                                            |
| **Render account** with permission to create a web service and connect GitHub                                                                               | Configure the service, upload secrets securely, deploy and check the deployed commit/health endpoint. Supply an API token securely if the agent uses Render's API instead of an authenticated browser.                                                                                                                                    |
| **Neon account or another Postgres service**, with database-owner access                                                                                    | Create an isolated database, apply migrations and create the restricted runtime role. Supply pooled and direct connection URLs; ordinary runtime credentials alone cannot provision the database roles.                                                                                                                                   |
| **Shopify account with Dev Dashboard/organization access** and permission to create a development store and app                                             | Create/link the app and store, configure scopes and URLs, install the app, seed the catalog/history/suppliers, and configure the test storefront. The owner must complete sign-in, installation consent and permission prompts when required.                                                                                             |
| **PayPal Developer account**, a merchant **Business sandbox account**, a separate supplier sandbox account, and the merchant's sandbox REST app credentials | Configure Payouts, Orders, reporting and verified webhooks. Provide the merchant payer ID and supplier sandbox email as well as the client ID/secret. Ensure Payouts and balance/transaction reporting are available and the sandbox balance exceeds the configured cash floor plus test purchases. No live payment credentials are used. |
| **OpenRouter account/key with usable quota**, or a configured alternative AI provider                                                                       | Configure the available model chain and verify an actual model response. A Google-only configuration needs an explicit Google model override for purchasing.                                                                                                                                                                              |
| **Your own valid AG Studio Pro and AG Grid/AG Charts Enterprise entitlements**                                                                              | Enable the full hosted Home workspace. Environment variable names alone do not provide licences; the production workspace remains disabled without both configured licence values.                                                                                                                                                        |
| **A public privacy/support contact**                                                                                                                        | Configure the app's privacy contact URL or email.                                                                                                                                                                                                                                                                                         |
| **Optional Telegram account and bot credentials**                                                                                                           | Register the webhook and prepare pairing. The account owner still starts the private bot chat and enters its connection code. Telegram is not required to deploy or test purchasing.                                                                                                                                                      |

The judge's work is providing account access/keys, completing authentication or MFA, accepting provider terms/permissions, and confirming personal/account choices. The agent handles configuration files, commands, seeding, deployment and verification. Browser authentication is not supplied by an API key for an unrelated service. Keep credentials in `.env` or a secret manager, never in the agent's chat or repository.

A Shopify development store retains its storefront password gate. For account-free access to a newly deployed judge console, explicitly enable the public demo and share **`https://YOUR_APP_HOST/demo`**, not the store's root URL. See the optional deployment section below.

### Prompt to give the deployment agent

> Deploy this repository into my own Render account and a fresh Postgres database using this README. Use a separate Shopify development store/app and PayPal sandbox accounts. Verify prerequisites first and tell me exactly which account access or secret is missing. Follow the database-role, seeding and Shopify configuration-release steps; do not reuse the original demo's IDs or credentials. Keep payments disabled until the funding/payee mapping and signed sandbox rules are verified. Perform the testing flows at the end, then report the deployed commit, app/store/public-demo URLs and actual results. Stop for authentication, terms or consent that requires me. Do not print secrets, bypass payment safeguards or claim deployment succeeded before checking it.

## 1. Supply accounts and environment values

Use a new Shopify development store, a separate Shopify app, an empty Postgres database and PayPal **sandbox** accounts. Do not reuse the original demo’s app ID, database or payment mapping.

The agent needs Node.js 22.12+, npm, Git, Shopify CLI, authenticated Shopify access and access to your hosting provider. Render and Neon are the reference hosting/database combination; another persistent Node host and Postgres also work.

| Value                                      | What to supply                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`    | Client ID and secret for your own Shopify app. The agent can create/link the app using Shopify CLI after you sign in.                                               |
| `SHOPIFY_APP_URL`                          | Your deployed HTTPS app origin, without a trailing slash. The agent fills this after provisioning hosting.                                                          |
| `DATABASE_URL`                             | Initially your owner’s pooled Postgres URL. The agent replaces it with the restricted app-role URL in step 2.                                                       |
| `DIRECT_URL`                               | Owner’s direct Postgres URL, used for migrations and role setup.                                                                                                    |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials for the merchant funding business account.                                                                                             |
| `SUPPLIER_EMAIL`                           | Email of a different sandbox account that receives supplier payments.                                                                                               |
| `GUARDBUY_PAYPAL_STORES`                   | Store/account binding JSON below. Merchant payer ID is the sandbox account’s PayPal merchant/account ID, not its email or supplier ID.                              |
| `OPENROUTER_API_KEY`                       | Required for the default purchase model chain. Use an account with working model access and quota.                                                                  |
| `GOOGLE_GENERATIVE_AI_API_KEY`             | Optional additional provider for advanced Insights questions. A Google key alone requires an explicit working Google model in `GUARDBUY_LLM_MODELS` for purchasing. |
| `AG_STUDIO_LICENSE_KEY`                    | Valid AG Studio Pro entitlement for the Home workspace and assistant.                                                                                               |
| `AG_GRID_LICENSE_KEY`                      | Valid combined AG Grid / AG Charts Enterprise entitlement. Both AG licence variables are required to enable Home analysis in production.                            |
| `GUARDBUY_PRIVACY_CONTACT`                 | Your public HTTPS support URL or `mailto:` address.                                                                                                                 |
| `JOBS_SECRET`                              | Agent-generated random secret, at least 24 characters.                                                                                                              |
| `GUARDBUY_DEMO_STORE`                      | Your new store’s exact `*.myshopify.com` domain.                                                                                                                    |

Create two distinct PayPal sandbox accounts: merchant funding and supplier receiving. The funding app needs Payouts and access to balance/transaction reporting. Fund the merchant sandbox account above the cash floor plus planned purchases. An app key being valid does not guarantee its reporting/Payouts permissions work; check these before payment tests. GuardBuy supports the exact sandbox API origin only.

```dotenv
# Replace every placeholder; this is one JSON line.
GUARDBUY_PAYPAL_STORES={"your-store.myshopify.com":{"clientId":"YOUR_PAYPAL_CLIENT_ID","payerIds":["YOUR_MERCHANT_SANDBOX_PAYER_ID"]}}
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
SCOPES=read_products,read_orders,read_inventory,read_locations,write_inventory,write_app_proxy
GUARDBUY_PUBLIC_DEMO_ENABLED=false
TELEGRAM_ALERTS_ENABLED=false
# Keep payments and the inventory worker off during provisioning/seeding.
GUARDBUY_PAYMENTS_DISABLED=1
GUARDBUY_RESTOCK_WORKER=off
```

The agent derives store URLs, IDs and configuration from the accounts you provision; judges should not have to edit source code. Start from [`.env.example`](.env.example), but use the current scope list above and model configuration described here rather than its older model-order comment. Optional supplier refill credentials are not required for normal payments.

Credential portals: [Shopify Dev Dashboard](https://dev.shopify.com/dashboard), [PayPal Developer](https://developer.paypal.com/dashboard/), [OpenRouter](https://openrouter.ai/settings/keys), [Google AI Studio](https://aistudio.google.com/apikey), [AG Grid licensing](https://www.ag-grid.com/license-pricing/).

## 2. Agent: prepare the application and database

```bash
git clone https://github.com/M00rish/guardbuy.git
cd guardbuy
npm ci
cp .env.example .env
```

Have the judge fill the secret values before continuing. Include the Shopify app values listed above in `.env`; they are not all present in the example. For Neon, use the provider’s pooled/direct connection strings with SSL enabled.

```bash
npx prisma generate
npx prisma migrate deploy
npx tsx scripts/create-app-role.ts --rotate
```

The role script reads `DIRECT_URL`, creates `guardbuy_app`, generates its password and rewrites `DATABASE_URL` in `.env`. It never prints the password. Keep `DIRECT_URL` as the owner connection. Transfer the resulting restricted `DATABASE_URL` to the host’s secret manager securely. Do not run `--rotate` repeatedly against an existing deployment; it changes the running app role’s password.

## 3. Agent: create and seed the Shopify store

1. Use an existing empty development store, or run `shopify store create dev --name "CoffeBuy Judging" --plan basic --json`. Follow the authenticated organization-selection prompts. Use the returned domain throughout this guide.
2. Create the judge’s app in Shopify’s Dev Dashboard, then run `shopify app config link --client-id YOUR_SHOPIFY_API_KEY --file-name judging` to link it. This creates `shopify.app.judging.toml`; retain its newly assigned client ID. Copy the repository configuration’s required scopes, webhook subscriptions, API version `2026-10`, auth callbacks and app proxy into this new configuration. Keep the webhook API version aligned with `app/shopify.server.ts`.
3. Temporarily add `write_products,write_orders,write_publications` to the judging app’s required scopes for seeding. Keep all normal scopes. Enable local URL updates only in this separate judging configuration while using the development tunnel.
4. Start the development session:

```bash
shopify app dev --config judging --store YOUR_STORE.myshopify.com
```

Complete installation and approve the temporary seed scopes. Leave this process running. Open the app once so its authenticated store session exists. Use the actual GraphiQL proxy URL offered by the CLI, including its local access key, as `GRAPHIQL_URL`; do not commit or print that URL. Select API version `2026-10`.

In a second terminal, set `SHOP` to the new store domain and `GRAPHIQL_URL` to that private local proxy URL, then run:

```bash
npx tsx scripts/seed-dev-store.ts
npx tsx scripts/seed-demo-suppliers.ts
```

The first script creates five coffee/homeware products, publishes them to Online Store, adds 30 days of test orders and sets starting stock. It can take several minutes due to Shopify’s test-order rate limits. The second uses `SUPPLIER_EMAIL`, links suppliers and switches on demo products. Both use the same database as the eventual hosted app. Existing SKUs/seeded days are reused, but rerunning seeding can reset stock and supplier setup; do not rerun it during an active payment test.

The seed scripts do **not** create the recorded CoffeBuy storefront design or product images. This repository contains no exported CoffeBuy theme. For a reproducible judging store, the agent should use/publish the development store’s free Shopify theme, set its display name to CoffeBuy, show the seeded product collection and verify products are purchasable. Exact reproduction of the recording needs a separately supplied theme export/assets.

In Shopify admin, the agent configures a test payment gateway, a shipping zone/rate and stock at the shipping location. Keep the development store’s password protection; give the judge its storefront password privately. No paid Shopify plan or live payment method is needed for these tests.

## 4. Agent: deploy the hosted app

Use [Render](https://dashboard.render.com/) to create a Node web service from your fork/checkout. [`render.yaml`](render.yaml) is a starting blueprint; override its original demo domain and its incomplete `SCOPES` value with your values from step 1. Add the AG licence values separately: they are not listed in the blueprint. Optional integrations can be left unset/disabled.

| Setting       | Value                                            |
| ------------- | ------------------------------------------------ |
| Node          | 22.12+                                           |
| Build command | `npm ci && npx prisma generate && npm run build` |
| Start command | `npx prisma migrate deploy && npm run start`     |
| Health check  | `/healthz`                                       |
| `NODE_ENV`    | `production`                                     |

Set all required environment values from step 1, including the rewritten app-role database URL, and deploy. Migrations use `DIRECT_URL`; the server uses `DATABASE_URL`. Use `npm run start` so the access-log preload is retained. A free Render instance can sleep and delay workers; an always-running instance gives a more predictable live demo.

Update **only** `shopify.app.judging.toml` for the deployed origin:

- `application_url`: your HTTPS app origin.
- `auth.redirect_urls`: that origin plus `/auth/callback` and `/auth/shopify/callback`.
- `app_proxy.url`: that origin plus `/proxy`; keep prefix `apps` and subpath `guardbuy`.
- Required scopes: the normal `SCOPES` list from step 1; remove temporary product/order/publication write scopes after seeding.
- `build.automatically_update_urls_on_dev = false` after returning to the hosted app.

```bash
shopify app config validate --config judging --json
shopify app deploy --config judging
```

Stop the local development preview and open the deployed app from Shopify admin; end/reset the CLI development preview if Shopify still routes to the tunnel. Approve any permission change and confirm the hosted app has an installed offline session. **Deploying to Render does not deploy Shopify app configuration, and deploying Shopify configuration does not deploy the Node server.**

The agent checks `/healthz`, `/privacy`, authenticated Home, Products & Suppliers, Rules & Approvals, Deliveries and Activity. A direct `/app` visit outside Shopify can lead to login; open the embedded app through Shopify admin. Both AG licences must be valid, and the configured AI provider must actually answer. Never use the original demo’s licence keys or credentials.

## 5. Agent: prepare a predictable judging run

Keep payments/worker disabled until configuration is complete. In the authenticated app:

1. Switch off every product except **House Blend Coffee 1kg** for the first test. Retain Atlas Roasters as its preferred supplier; do not approve Bean Bargains Wholesale. Check Atlas’s payee is the intended sandbox supplier.
2. In product management set **Expected sales per day = 1**. In Shopify inventory set **available stock = 8**, at the checkout location. Ensure no earlier purchase or incoming shipment reserves this product.
3. Set rules to **reorder below 7 days**, **target 14 days**, **approval above $500**, **7-day cap $1,500**, **minimum PayPal balance $1,000**, and **5 purchases per 24 hours**. Approve the intended legitimate suppliers. Sign through the authenticated staff UI; do not forge signatures or insert audit history directly.
4. On the host set `GUARDBUY_PAYMENTS_DISABLED=0` and remove `GUARDBUY_RESTOCK_WORKER=off` (or set it to `on`), then redeploy. Resume the agent if paused. Home should show 8 stock, 8 days of cover and no outstanding approval.
5. Tell the judge the app/store URLs, storefront password, deployed commit, enabled integrations and any actual setup blockers. Never include secrets in this handoff.

A new supplier’s **first purchase needs approval**. Do that bootstrap flow below before recording a fully automatic purchase. Existing same-product/same-supplier purchases within 24 hours count together toward the approval limit; reservations also consume budget. Resetting stock does not reset these limits or erase history. A declined purchase pauses that product until you reset it; use the app’s **Reset cooldown and recheck** only when intentionally preparing another sandbox run. A purchase blocked by a rule pauses that product until you lift it: open the product in **Products** and choose **Lift block and recheck**. Neither pause has a time limit, and the rules and payment safeguards still decide the new attempt.

PayPal payout webhooks register automatically at `/paypal/webhook` using the existing sandbox app credentials and deployed origin. No separate webhook secret is required. Background workers require a running server. Open data pages update automatically approximately every five seconds after recorded changes; supplier settlement can take longer than page refresh.

### Optional deployment additions

- **Telegram:** set `TELEGRAM_ALERTS_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` without `@`, and an agent-generated 32+ character `TELEGRAM_WEBHOOK_SECRET`. The agent registers `SHOPIFY_APP_URL/telegram/webhook` with Telegram `setWebhook`, the same `secret_token`, and `allowed_updates=["message"]` using secrets in memory. In Alerts, the judge starts the private bot chat and confirms the pairing code. See [Telegram setup](docs/telegram-alerts.md). Pairing cannot be completed by environment variables alone.
- **Public demo:** explicitly opt in with `GUARDBUY_PUBLIC_DEMO_ENABLED=true` and your bound `GUARDBUY_DEMO_STORE`. Open `https://YOUR_STORE.myshopify.com/apps/guardbuy` through Shopify’s signed proxy, not the app’s bare `/proxy` endpoint. Authenticated Home has a separate fictional-data mode; it does not exercise real purchases.
- **External audit checkpoints:** optional for deployment; configure dedicated database-reader/R2 credentials and retention using [the checkpoint setup guide](anchors/README.md). Leave `AUDIT_CHECKPOINTS_ENABLED` unset until that setup is complete. Internal Activity chain verification works without R2.
- **Sandbox refill:** only if needed, supply `SUPPLIER_PAYPAL_CLIENT_ID` and `SUPPLIER_PAYPAL_CLIENT_SECRET` and run `npx tsx scripts/refill-sandbox.ts`. This transfers sandbox funds from supplier to merchant. `scripts/reset-demo.ts` also changes inventory and can trigger restocks; it does not clear audit history, approvals, cooldowns or spending limits.

## 6. Test the app flows

Run one flow at a time against your new development store. Keep payment tests on the sandbox. Treat provider-pending outcomes as pending; do not submit replacements to make the demo appear complete.

| Flow                                | Actions                                                                                                                                                                                                                                      | Expected result                                                                                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First supplier / approval bootstrap | With stock 8 and expected sales/day 1, buy **2 bags** using Shopify’s test gateway. Open Home, then expand the new row in Approvals. Approve the exact sandbox amount after reviewing the checks.                                            | Stock becomes 6; a proposal appears. A newly added supplier needs first-purchase approval. Submission shows pending until PayPal confirms; no duplicate payment is created.                                                                                            |
| Receive the bootstrap purchase      | Wait for confirmed payment, open Deliveries, choose the new purchase, its correct location and the received quantity. Record receipt once.                                                                                                   | Available Shopify stock increases by the received quantity; remaining incoming falls. A full receipt closes the delivery.                                                                                                                                              |
| Automatic restock                   | After the bootstrap purchase settles and its delivery is received, reset available stock to 8. Keep sales/day 1 and the signed rules above. Buy 2 bags again. Check cumulative 24-hour supplier/product spending and remaining budget first. | Home updates from 8 to 6 without clicking Refresh snapshot. If **all** policy checks pass, GuardBuy submits the new restock automatically; it appears in Purchases/Deliveries. A pending payment is not labelled as waiting for approval.                              |
| Approval threshold                  | After resolving earlier purchases, set and sign an approval threshold below the next proposed amount. Restage stock and make one new low-stock event. Expand its approval row.                                                               | Facts, amount and failing check appear inside the expanded row. No payment occurs before an explicit approval. Decline is logged and pauses the product until its cooldown is reset; resetting it queues a fresh check under current rules. Restore/sign the normal threshold after this flow. |
| Approve in PayPal                   | On a fresh unpaid approval, choose **Approve in PayPal** instead of the in-app payment route. Sign in with a merchant sandbox payer listed in `GUARDBUY_PAYPAL_STORES`, approve and return.                                                  | The supplier and amount match the proposal. GuardBuy records the capture/outcome. An unrelated payer is refused. Do not try the alternate route for the same purchase.                                                                                                 |
| Spending guardrails                 | Pause the agent, set/sign a cash floor above available funds or a weekly cap below the next purchase, then resume and trigger one stock change.                                                                                              | The purchase is blocked with a concrete reason and no payment. Restore/sign normal rules afterwards.                                                                                                                                                                   |
| Product control                     | Switch a product off, then lower its Shopify stock. Switch it back on only after checking intended policy and budget.                                                                                                                        | Disabled products never start a purchase. Enabling queues a fresh stock check.                                                                                                                                                                                         |
| AG Grid / assistant                 | On Home, filter and sort products, expand a product, switch to Purchases, and ask AI about stock risk or remaining budget. Try a request to make a payment. Switch to fictional data and back.                                               | Grids and answers use the selected data scope; routine supported answers match the snapshot. The assistant refuses payment/write requests. Fictional data cannot act on the live store.                                                                                |
| Activity and verification           | Follow a purchase into Activity and select **Verify the log**. If available, follow its public payment-verification link.                                                                                                                    | Proposal, policy decision, staff approval where applicable, submission and later provider updates are traceable. Chain verification is intact. Public verification does not disclose private account details by default.                                               |
| Telegram, if enabled                | Trigger a genuine unresolved approval and wait for the background notification. Open its link. Resolve the approval before testing another notification.                                                                                     | The private bot sends the actual state notification and links to that purchase. Opening the link does not approve or submit payment.                                                                                                                                   |

**If a flow stops:** inspect its displayed policy checks and Activity first. Check app installation/scopes, funding-account mapping, PayPal reporting access/balance, AI quota, valid AG licences, worker flags and host sleep. New-supplier review, cumulative 24-hour spend, reserved budget, incoming stock and decline cooldowns are expected reasons a fresh automatic-payment test may not proceed. Record actual outcomes; do not bypass the policy or rewrite audit rows to obtain a pass.

## License

MIT, an OSI-approved license. See [LICENSE.md](LICENSE.md) for the full text. Portions are from Shopify's app template, also released under the MIT license.

You may use, copy, modify, merge, publish, distribute, sublicense and sell copies of this software, provided the copyright and permission notice are included in all copies or substantial portions. The software is provided "as is", without warranty of any kind, express or implied.
