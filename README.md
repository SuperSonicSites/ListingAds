# Supersonic Ad Manager

Internal tool for managing listing ad campaigns end-to-end:

1. **Client intake** — each brokerage gets a dedicated secret link
   (`/intake/<token>`) where they submit: listing address, ad budget
   ($50/$100/$150/$200), campaign type (new / extend), up to 10 target cities,
   a Dropbox/Drive photos link (exactly 10 photos), their REALTOR.ca stats
   share link, and notes. They get an on-screen confirmation + a confirmation
   email; a card appears in **New Order** on the team kanban.
2. **Post creation** — the card's post editor auto-assembles the emoji listing
   post (price, beds/baths, neighborhood, nowforsale.co short link, brokerage
   phone line and sign-off) with a live Facebook-style preview. The short link
   is created on click via short.io on the nowforsale.co domain.
3. **Review** — "Mark Ready for Review" emails the reviewer with a CRM deep
   link; approving moves the card to **Post Reviewed**.
4. **Publish** — "Push Live" publishes the multi-photo page post via the Graph
   API (or record a manually-posted URL). The team creates the ad campaign in
   Ads Manager, records the Campaign ID + launch date; the report due date
   defaults to launch + 14 days. The client gets the launch email.
5. **Campaign In Progress** — the board shows due/overdue badges; an hourly
   in-process reminder emails the team (Mon–Fri 9–5 PT, daily while overdue)
   with the exact task string.
6. **Reporting** — the report builder pulls campaign insights (impressions,
   reach, all clicks) + region and age/gender breakdowns from the Marketing
   API, fetches the ad's caption + photos from the Marketing API for the
   Facebook-style Sample Overview (falling back to the published post's text
   and photos, or a manual Ads Manager screenshot), takes hero + 6 listing
   photos and fetched REALTOR.ca 7/30/90-day screenshots (from the client's
   share link, with manual upload as the fallback), and freezes an
   immutable snapshot rendered as the branded Executive Report (HTML → Letter
   PDF). "Send Executive Report" emails the PDF to the client ("Happy
   {weekday}!"), then the card auto-completes.

## Run it

```bash
npm install
cp .env.example .env   # fill in ADMIN_PASSWORD at minimum
npm run dev            # http://127.0.0.1:4322
```

Set `DEMO_MODE=1` to walk the whole workflow with mock integrations (no Meta /
Resend / short.io credentials needed; emails are logged, not sent). PDF
generation and REALTOR.ca capture use your local Chrome/Edge (`CHROME_PATH` to
override).

## Deploy (Railway)

- Build `npm install && npm run build`, start `npm run start`, `HOST=0.0.0.0`.
- Persistent volume mounted at `/app/data` (boot log confirms it).
- `RAILPACK_DEPLOY_APT_PACKAGES=chromium` + `CHROME_PATH=/usr/bin/chromium`.
- Env vars per `.env.example`. Resend sending domain must be DKIM/SPF-verified.
- If Cloudflare Access fronts the app, exclude `/intake/*`, `/api/intake`, and
  `/reports/*` from the SSO rule.

See `CLAUDE.md` for architecture, invariants, and the per-brokerage Meta
Business Manager checklist.

## Phase 2 (deliberately not built)

- Scheduled Meta publishing (`published=false` + `scheduled_publish_time`).
- Campaign-ID dropdown from `GET /act_{id}/campaigns` (v1 is a text input).
- Instagram cross-posting of the listing post.

## Maintenance notes

- `GRAPH_VERSION` (src/lib/metaCore.ts) is pinned to v21.0 — Graph versions live
  ~2 years; bump and re-test when Meta announces the sunset.
- The ad-creative story attachments shape (`media.image.src`, `subattachments`
  for multi-photo posts) and the short.io response field names are
  verified-on-first-live-call items; each is isolated in its module.
