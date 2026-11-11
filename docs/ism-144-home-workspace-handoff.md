# ISM-144 Home workspace — implementation checkpoint

Paused at Ismail's request as usage approached the limit. This is a draft, not acceptance-ready. Do not merge/deploy or mark ISM-144/ISM-17 Done before review.

Branch: `feat/ism-144-home-workspace`, based on main merge e2996eb. Previous PR #28 is already merged; this is the follow-up redesign approved after research.

## Implemented

- Replaced Home's metric cards, separate Products/Recent activity tables and Rules/Audit panels with a compact AG Grid summary and Products (default), Purchases, Activity and Store details grid views.
- Removed the green hero and the three filter-button rows. Shared search, native column/Filters tools, saved-view menu, filtered export, optional Insights charts and Ask AI.
- Preserved Home warnings, setup guidance, agent controls and existing product management action. Incoming quantities reuse delivery projections. No new Shopify API, payment or rules commands.
- Product expansion uses exact variant IDs to show purchase history. Projection now includes optional variantId. No unsafe name/SKU joins.
- Entire workspace switches coherently to browser-only demo data. Product writes and real-record links are disabled in demo; live agent controls/warnings above remain labelled live.
- Studio is in view mode. Installed Studio 3.1 only supports its native AI panel in edit mode, so a separate transcript UI uses the actual AG Studio harness/session API and existing single read-only agent. No extra tools or provider access.
- Supplier sparklines are restricted to supplier group rows. Native date filtering and compact/mobile column defaults added.

## Verification completed

- Typecheck passed after the main implementation (typecheck2); latest typecheck3 log has no errors, but retrieve its process completion if needed.
- Production build passed.
- Projection/agent/demo tests passed, including new exact-identity joins, financial summary scope, coherent demo rows and no real demo links.
- Home migration/auth/strict planner resource route tests passed.
- Changed-file ESLint initially found an unused label constant; removed it. Latest lint2 log is empty; retrieve completion if needed. Repo-wide lint already had three unrelated errors in scripts/seed-dev-store.ts.
- Brief automated browser smoke passed: desktop and mobile, all four views, expanded product history, demo action/link isolation, actual AG harness with mock planner, refusal of payment commands, zero page exceptions, zero writes, no page overflow at 390px.

## Remaining before review

1. Visual polish: mobile Stock header is obscured by header icons. Suppress header menu/filter buttons on mobile while retaining the Filters panel; widen desktop numeric columns as necessary. Remove meaningless column menus from the summary grid.
2. Settled amount renderer sits lower than adjacent values. Simplify its flex/100% height styling to align text with other numeric cells; retain a subtle value bar.
3. Main grid height currently adds unnecessary page scrolling, especially with alerts. Fit it to available viewport height while retaining usable minimum height. Purchases has a fixed 620px Studio canvas; optional charts extend it.
4. Re-run typecheck, changed-file lint, relevant tests and a brief screenshot smoke after polish. Add save/restore and filtered-export coverage to the fixture smoke if practical. Keep manual acceptance with Ismail.
5. Update README for the final workspace, upload fresh desktop/mobile/assistant evidence to Linear with the final full commit ID, and finish PR description/manual walkthrough. No new subtasks.
6. Run full CI and leave the PR ready for review; do not assume approval to merge this follow-up.

## Local evidence / harness

`/workspace/scratch/ism144-workspace` contains build.mjs, fixture.ts, server.mjs (port 4195), browser.mjs, logs and screenshots 01–05. Actual Home/grid/agent components; explicitly mocked auth, data and model plans; no local licence keys. These are not hosted licence/provider acceptance tests.

Browser command: `node /workspace/scratch/ism144-workspace/browser.mjs` (server must be running). Fixture browser source build: `node /workspace/scratch/ism144-workspace/build.mjs`. Browser results: browser2.log and browser-results.json.

Existing automated commands: npm run typecheck; npx tsx scripts/check-insights.ts; npx tsx scripts/check-insights-routes.ts; npx tsx scripts/check-insights-planner.ts; npm run build.
