# Supersonic Ad Manager (SupersonicAdReport)

Internal tool that manages listing ad requests end-to-end: client intake form
(dedicated per-brokerage link) → team kanban (6 stages) → in-app Meta post
drafting with live preview → push-to-live via Graph API → ad launch tracking →
Executive Report generation (PDF) → report delivery by email.

Sibling app: `../SupersonicAnalytics` (Standard Listing Report generator).
This app deliberately mirrors its architecture and conventions.

## Coding principles (walk this ladder before writing anything)

```
1. Does this need to exist?   → no: skip it (YAGNI)
2. Already in this codebase?  → reuse it, don't rewrite
3. Stdlib does it?            → use it
4. Native platform feature?   → use it
5. Installed dependency?      → use it
6. One line?                  → one line
7. Only then: the minimum that works
```

UX/UI is the one area allowed a little more elaboration.

## Commands

```bash
npm install
npm run dev        # http://127.0.0.1:4322 (PORT env; 4322 so it can run beside the sibling on 4321)
npm run build      # astro build -> dist/ (SSR standalone Node server)
npm run start      # node ./dist/server/entry.mjs (production / Railway)
npx astro check    # type-check (no test runner, no linter — house style)
```

`.env` is loaded only by `astro dev`; production uses real env vars. Server code
reads `process.env.X ?? import.meta.env.X`. See `.env.example` for the full list.
`DEMO_MODE=1` makes every external adapter return labeled mock data when its
credential is missing — the entire workflow is walkable with only `ADMIN_PASSWORD` set.

## Architecture

- Astro 7 SSR (`output: "server"`, `@astrojs/node` standalone). No database —
  atomic JSON files under `data/` (temp+rename writes, safe-id regex
  `/^[a-z0-9-]+$/` everywhere). Plain HTML form POSTs → API routes → 303
  redirects; failures return an errorPage steering to the browser Back button.
- `data/brokerages/<slug>.json` — brokerage profiles (incl. 32-hex `intake_token`,
  the dedicated-link secret). `data/requests/req-*.json` — ad requests (the kanban
  cards). `data/uploads/<requestId>/<assetId>.<ext>` — binary photos/screenshots
  (never base64 in JSON; served via `/api/uploads/...` behind auth).
  `data/snapshots/rpt-*.json` — frozen Executive Report snapshots.
- **Snapshot invariant**: `/reports/[snapshotId]` renders ONLY from the frozen
  snapshot; all images are embedded as base64 data URIs at freeze time. Reports
  never change after generation; regeneration mints a new snapshot id.
- **Status machine**: `src/lib/status.ts` defines the 6 stages + allowed moves;
  `src/lib/transitions.ts#applyTransition` is the ONLY way status changes — it
  enforces guards and fires the review/launch emails. Derived tasks (exact spec
  strings) come from `taskFor()`; there is no separate task store.
- **Auth**: single ADMIN_PASSWORD, sha256-derived cookie `sar_auth` (differs from
  the sibling's `srg_auth` on purpose — cookies don't isolate by port). Public
  surfaces: `/intake/<token>` (+thanks), `/api/intake`, and `/reports/<id>?t=<share_token>`.
- **Integrations** (`src/lib/`): raw fetch, Bearer headers, 8s timeouts, adapters
  never throw — they degrade to `"manual"` + warning and every metric stays
  editable. `metaCore/metaAds/metaPost` (Graph v21.0 — bump `GRAPH_VERSION` when
  Meta sunsets it), `shortio` (nowforsale.co links, created on click),
  `email`/`emailTemplates` (Resend, reply-to = team inbox, 6 workflow emails),
  `reminders` (hourly in-process tick, Mon–Fri 9–5 America/Vancouver, daily
  re-nag while a report is due; state persisted on the request).
- **Business dates** (due badges, reminders, "Happy {DAY}", send window) are
  computed in America/Vancouver via `src/lib/dates.ts`; `format.ts` (UTC) is
  display-only.
- **PDF**: Puppeteer over loopback `127.0.0.1:{PORT}` with cookie/share-token
  forwarding; `.report-sheet` = one 8.5×11in page (print model in `global.css`).
  Delivery attaches the PDF when ≤15MB, else emails a tokenized download link.

## Invariants (do not break)

1. Reports render only from frozen snapshots; images embedded at freeze time.
2. Every metric is manually editable; API failure = warning, never a dead end.
3. Status changes only through `applyTransition`; emails never roll back a transition.
4. All user-supplied ids validated against `/^[a-z0-9-]+$/`; upload paths built
   only from server-minted ids + the magic-byte extension map.
5. White-label discipline: no Supersonic chrome on the public intake pages or
   report sheets — those carry only the brokerage's brand.
6. No new npm dependencies without a strong reason (Resend/short.io/Meta are raw fetch).

## Deployment (Railway)

New service; volume mounted at `/app/data` (the boot-time st_dev check logs
whether it's really a volume); `RAILPACK_DEPLOY_APT_PACKAGES=chromium`;
`CHROME_PATH=/usr/bin/chromium`; `HOST=0.0.0.0`; start `npm run start`; env vars
per `.env.example`. If Cloudflare Access fronts the app, exclude `/intake/*`,
`/api/intake`, and `/reports/*` from the SSO rule (clients hit those without SSO).

## Meta Business Manager checklist (per brokerage)

1. Brokerage's FB Page partner-shared to Supersonic BM, assigned to the system
   user with **Create content** permission (View is not enough to publish).
2. Brokerage's ad account shared + assigned with at least **View performance**
   (covers /campaigns, /insights, /ads, /previews).
3. Meta app has Marketing API **Standard Access**.
4. Re-mint the system-user token after new asset grants if per-asset scoped.
5. Record `meta_page_id` + `meta_ad_account_id` (digits only) on the brokerage.
