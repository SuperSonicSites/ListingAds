# Design Brief — Supersonic Ad Manager

> **For the designer.** This document is a complete map of the product so you can
> re-imagine the interface and deliver a prototype. It lists every page, every
> field, every component, and every state that must survive the redesign. You do
> **not** need to read the code — everything the UI does is described here.
>
> Re-imagine the *look, layout, and interaction*. Keep the *fields, states, and
> workflow rules* — they are load-bearing. Where a rule constrains the design, it
> is called out as **`Constraint:`**.

---

## 1. What this product is

Supersonic Ad Manager is an **internal tool** used by a small team to run
Facebook/Instagram (Meta) listing ads for real-estate brokerages, end to end:

```
Client intake form  →  Team kanban board  →  Draft the Meta post (live preview)
   →  Push the ad live  →  Track the campaign  →  Generate an Executive Report (PDF)
   →  Email the report to the client
```

There are **two audiences**, and they must look and feel different:

| Audience | Surfaces | Branding |
|---|---|---|
| **The internal team** (operators) | Login, Board, Brokerage admin, Request cockpit, Post editor, Report builder | **Supersonic** brand (blue `#29abe2`, "Supersonic Sites" mark) |
| **The brokerage's clients** (public) | Intake form, Thanks page, Executive Report | **White-label** — the brokerage's own logo + colors, *no Supersonic chrome* |

**`Constraint:` White-label discipline.** The public intake pages and the
Executive Report must carry **only the brokerage's brand** (its logo, its two
brand colors). The one permitted exception is a small "powered by Supersonic
Sites" line on the intake pages. The Executive Report PDF has **zero** Supersonic
branding anywhere on the printed sheets.

---

## 2. The workflow (the spine of the whole product)

Every request moves through **6 stages** in order. The board has one column per
stage; the request cockpit shows them as a stepper. This state machine is the
single most important concept to express visually.

| # | Stage key | Label | What it means |
|---|---|---|---|
| 1 | `new_order` | **New Order** | Client just submitted the intake form |
| 2 | `post_created` | **Post Created** | Team drafted the Facebook post; awaiting internal review |
| 3 | `post_reviewed` | **Post Reviewed** | Post approved; ready to push live |
| 4 | `ad_published` | **Ad Published** | The ad is live on Facebook |
| 5 | `campaign_in_progress` | **Campaign In Progress** | Ad is running; a report is due ~2 weeks after launch |
| 6 | `completed` | **Completed** | Executive Report generated and sent |

**Forward moves (the only legal advances):**

- New Order → Post Created  *(normal)*  **or**  New Order → Ad Published *(see Extend, below)*
- Post Created → Post Reviewed
- Post Reviewed → Ad Published
- Ad Published → Campaign In Progress
- Campaign In Progress → Completed

**The "Extend" shortcut.** A request can be a *new* campaign or an *extend an
existing campaign* request. **Extend requests skip stages 2 and 3 entirely** (the
post already exists on Facebook): they go New Order → **Ad Published** directly.
In the stepper, the two skipped stages must render in a distinct **"skipped"**
style (dashed dot, struck-through, "(skipped)" appended).

**Move back / correct.** An operator can move a card back exactly one step to fix
a mistake, and can **reopen** a Completed request back to Campaign In Progress
(to regenerate + resend the report). Back-moves must be visually distinct from
forward advances (they are a correction, not progress).

**`Constraint:` Guards block illegal forward moves.** The UI must surface these
gate conditions (as disabled buttons + helper text), because the server rejects
the move otherwise:

- **→ Post Created** requires: post text written **and** ≥1 photo selected **and**
  the short link created.
- **→ Ad Published** requires: Facebook Campaign ID **and** Ad Launch Date **and**
  Report Due Date **and** (unless Extend) the post actually pushed live.

**Derived task labels.** Each stage shows the operator a single next-action string
(rendered as a prominent task banner). These exact strings matter:

| Stage | Task banner text |
|---|---|
| New Order (normal) | `CREATE POST: {address} - {brokerage}` |
| New Order (extend) | `EXTEND CAMPAIGN: {address} - {brokerage}` |
| Post Created | `REVIEW POST: {address} - {brokerage}` |
| Post Reviewed | `PUBLISH & LAUNCH: {address} - {brokerage}` |
| Ad Published | *(one-click "Start Campaign Tracking" banner)* |
| Campaign In Progress | `{address} - Send Executive Report for - {brokerage}` once the report is due; otherwise "Campaign running — report due {date}" |
| Completed | *(a "done" banner)* |

---

## 3. The pages

There are **11 surfaces**. Below, each lists its purpose, fields, actions, and the
states you must design for. Fields are grouped exactly as the workflow needs them.

### 3.1 Login  *(internal)*
Single password gate. Supersonic-branded, no top nav.

- **Fields:** `password` (required, autofocus).
- **Actions:** "Continue".
- **States:** default; **error** ("That password didn't match. Try again.").

---

### 3.2 Board (home)  *(internal)*
The kanban of all requests. **Read-mostly** — cards advance from their detail page,
not by dragging. Six fixed columns (the six stages), horizontally scrollable.

- **Column head:** stage label + a **count badge**.
- **Card contents (per request):**
  - Brokerage logo tile (or first initial) + brokerage name
  - Listing address (the primary link, 2-line clamp)
  - Chips: **budget** (`$50/$100/$150/$200`), an amber **EXTEND** chip (extend only),
    a muted **age** chip ("today" / "3d ago")
  - The derived **task** line (section 2)
  - **🔗 short link** (if created)
  - A **status-dependent footer** (see states)
- **Card actions:** the whole card links to the request cockpit. The *only* inline
  action is **"Approve post"** on Post-Created cards (one click → Post Reviewed).
- **States (footer varies by stage):**
  - Post Created → "Awaiting review" + **Approve post** button
  - Ad Published → "Launched {date}"
  - Campaign In Progress → one of: "No due date set" / **red** "Report overdue Nd" /
    **amber** "Report due today" / **green** "Report due {date}", plus a "reminded ✓" marker
  - Completed → **green** "Report sent {date}"
  - **Empty column** → dashed "No requests." placeholder

**`Constraint:` Due-date urgency coloring** (overdue = red, today = amber,
future = green) is meaningful and must be preserved.

---

### 3.3 Brokerage roster  *(internal)*
List of all brokerage client profiles. Each brokerage has a **secret dedicated
intake link** that the operator copies and sends to that brokerage.

- **Per brokerage card:** logo, name, "{contact} · {email}", location; **Edit**
  button; an **intake-link strip** with the URL, a **Copy** button (flashes
  "Copied ✓"), and an "Open form" link.
- **Actions:** "New brokerage".
- **States:** populated grid; **empty** ("No brokerages yet").

---

### 3.4 Brokerage create / edit form  *(internal)*
One shared form (create + edit). This defines the brokerage's identity, branding,
contact, and Meta integration. Grouped into sections:

**Brand**
- `name` (required)
- `slug` (auto from name on create; **read-only** once created)
- `logo_file` (upload PNG/JPEG/SVG/WebP, ≤1 MB) **or** `logo_url` (alternative)
- `brand_primary` (color, default `#111111`)
- `brand_accent` (color, default `#c9a86a`)
- *(edit)* a "Current logo" preview

**Contact**
- `contact_name` (required — greeted by name in every client email)
- `contact_email` (required — receives confirmation/launch/report emails)
- `contact_phone`
- `website`

**Address:** `address_street`, `address_city`, `address_province`,
`address_postal`, `address_country` (default "Canada").

**Post settings** (feed the Facebook caption)
- `post_phone_line` (shown after 📞 in every post, e.g. "867-333-HOME (4663)")
- `post_signoff` (the last line of every post)

**Meta integration (optional)**
- `meta_page_id` (digits — the FB Page posts publish to)
- `meta_ad_account_id` (digits only; a pasted `act_` prefix is stripped)

**Intake link** *(edit only)*
- `regenerate_token` checkbox — mints a new secret intake URL; old link dies
  immediately (only for a leaked link).

- **Actions:** "Create brokerage" / "Save changes".
- **Danger zone** *(edit only):* **Delete brokerage** — requires typing the
  brokerage name to confirm. (Existing requests and frozen reports survive.)

**`Constraint:` The two brand colors** chosen here drive *all* white-label
surfaces (intake pages + report). Design the color pickers so the operator
understands their downstream impact.

---

### 3.5 Request cockpit  *(internal)* — the operating surface
`/requests/{id}` — where every transition (except the board's inline Approve)
happens. Layout is a **main column of numbered cards + a sticky brokerage side
panel**.

**Header:** brokerage name (eyebrow), listing address (H1), and the **6-stage
stepper** (done / current / todo / **skipped**).

**Task banner:** the derived task (section 2) plus **stage-specific action
buttons**:
- New Order (extend) → "Record Ad Launch"
- New Order (normal) → "Open Post Editor"
- Post Created → "Open Post Editor" + **Approve post**
- Post Reviewed → "Open Post Editor (Push Live)" + "Record Ad Launch"
- Ad Published → **Start Campaign Tracking**
- Campaign In Progress → "Open Report Builder"

**Numbered cards:**

1. **Submission** (read-only): address, budget, campaign type, target cities,
   Realtor.ca stats link, special notes, submitted timestamp.
2. **Short link** — if none yet, a form:
   - `mls_number` (required, digits — auto-derives the path)
   - `path` on the short domain (read-only, derived: `mls{digits}`)
   - `original_url` (destination URL, prefilled to `{website}/listing/`)
   - "Create link" → then shows the URL + **Copy**.
3. **Post** — published state (permalink or post ID, "Published {time}", a
   **manual** badge if recorded by hand, a text preview) or "Not published yet".
4. **Campaign** — form:
   - `fb_campaign_id` + a "Non-standard ID (skip the digits check)" checkbox
   - `ad_launch_date` (date)
   - `report_due_date` (date — auto-fills to **launch + 14 days**)
   - "Save campaign details" and (when applicable) **Record Ad Launch**
5. **Report** — "View report" + "Download PDF" if generated; otherwise "No report
   yet". When Campaign In Progress + a report exists, a **send block**:
   - `to` (recipient email, default = brokerage contact)
   - "Send Executive Report"
   - **Send-window notice:** reports go out **Mon–Fri, 9–5 Pacific**; outside that
     window, warn "send now or wait".
6. **Status timeline** — the full `status_history` with timestamps and note pills
   ("correction", "extension — post stages skipped").
7. **Email log** — table of all emails (kind, to, subject, sent time, **Sent**/
   **Failed** chip), each with a **Resend** button.

**Footer controls:** "Reopen" (Completed) / "Move back to {stage}" / "Complete"
(with a soft-confirm if the report was never sent).

**Side panel (sticky):** brokerage logo, name, contact (mailto), phone, website,
ad account `act_{id}` (+Copy), page ID, address, "Edit brokerage". If the
brokerage was deleted: a "Brokerage deleted" explainer.

**States:** not-found (404) panel; dismissible warning (red) / "Report sent"
(green) notices.

---

### 3.6 Meta post editor  *(internal)* — split-screen with **live preview**
`/requests/{id}/post` — draft the Facebook caption + pick photos, with a
**live Facebook-style preview that mirrors the exact published text**. This is the
most craft-heavy internal screen.

**Left column — the form:**

*Post details*
- `headline_flag` (select: NEW LISTING / JUST LISTED / PRICE REDUCED / OPEN HOUSE /
  BACK ON THE MARKET / FEATURE LISTING). *Choosing "PRICE REDUCED" suggests price
  prefix "Now Offered at".*
- `price_prefix` (select: "Offered at" / "Now Offered at")
- `price` (numbers only, no `$`, e.g. "809,900")
- `neighborhood`
- `beds` (number, step 0.5) · `baths` (number, step 0.5)
- `body` (textarea, descriptive paragraphs, ≤2000 chars)
- Read-only: short link, 📞 phone line, sign-off (pulled from the brokerage)

*Final post text*
- `final_text` (the **exact** text that publishes) — a large textarea
- **"Regenerate from fields"** button
- **`Constraint:` Auto-assembly rule.** As the operator types in the fields, the
  final text auto-assembles from them — **until** they hand-edit the final text,
  at which point auto-assembly stops (a "dirty" flag) until they hit Regenerate.

*Photos*
- Count badge "{n} of 10 picked"
- **"Fetch photos from REALTOR.ca"** (pulls first 10 listing photos, ~30s)
- **Dropzone**: drop / click-to-browse / **paste a screenshot**
- Photo grid of **toggle tiles** — clicking selects/deselects; a **number badge =
  publish order**; max 10.

*Actions:* "Save Draft"; "Mark Ready for Review" (when eligible).

**Publish panel** (when approved + short link exists):
- **"Push Live to Facebook"** (confirm dialog)
- Or record a manual publish: paste `manual_permalink` → "Record manual publish"

**Right column — live preview** (sticky): a **Facebook post card** — brokerage
avatar, name, "Just now · 🌐", the caption (mirrors final text exactly), a photo
grid (odd count → first photo spans full width), and fake Like/Comment/Share.

**`Constraint:` The caption assembly format.** The final text is built as three
blocks separated by blank lines. Empty fields are omitted cleanly (never a
dangling emoji):

```
🚨 {FLAG}!🚨 {address}          ← headline (or bare address if no flag)
{short link}
💲 {price prefix} ${price}
🛏️ {beds} Bedrooms | 🛁 {baths} Bathrooms
📍 {neighborhood}

{descriptive body paragraphs}

🔗 {short link}
📞{phone line}
{sign-off}
```

**States:** notices for saved / published / warning / "create short link first";
photo upload flow ("Preparing… / Uploading…"); empty photo state.

---

### 3.7 Report builder  *(internal)*
`/requests/{id}/report` — assemble the Executive Report through numbered sections
that **mirror the report's printed pages**. Every auto-pulled number lands in an
**editable field** before it is frozen.

**`Constraint:` Manual-fallback invariant.** Every integration can fail silently.
Each "Pull / Fetch" button fills editable inputs and shows a **source badge**
(**Manual** / **Meta API** / **Mock**). The operator reviews and can override
*everything*; the snapshot freezes what they approved, never raw API data.

Sections:

1. **Ad stats** — "Pull ad stats" → `impressions`, `reach`, `clicks_all` (all editable).
2. **Ad sample** — "Fetch ad creative from Meta"; `ad_sample_text` (caption,
   defaults to the published post); fetched-photo thumbnails; optional **mobile**
   and **desktop** screenshot upload slots (a real screenshot replaces the
   generated mockup).
3. **Link analytics** — "Pull short.io stats" → `total clicks`, `human clicks`,
   plus a frozen preview line (top city/browser/referrer + N-day chart).
4. **Listing photos** — a pick grid: **first click = HERO**, next clicks = gallery
   (**exactly 6 required**), click again to deselect. Gallery dropzone
   (click/drag/paste). Summary: "HERO picked · n / 6 gallery photos."
5. **REALTOR.ca stats** — `realtor_stats_link` + "Fetch"; **7 / 30 / 90 day**
   screenshot slots (auto-captured or uploaded).
6. **Prepared by** — `prepared_by`, `website`, `brokerage_address`, `contact_line`
   (all default from the brokerage, all editable).

**Submit panel:**
- **Approval checkbox** (required): "I have reviewed the stats, screenshots, and photos above."
- **Waiver checkbox** (only if realtor screenshots missing): "Generate without REALTOR.ca pages."
- **"Generate / Regenerate Executive Report"** (+ "View current report" if one exists).

**`Constraint:` Submit validation** blocks generation unless **1 HERO + exactly 6
gallery** photos are chosen.

**States:** early-status warning (not yet Campaign In Progress); per-section
warnings; upload/fetch progress; not-found (404).

---

### 3.8 Client intake form  *(public / white-label)*
`/intake/{token}` — the brokerage-branded form a realtor fills to request a
campaign. **Must work without JavaScript.** ~2 minutes to complete.

**Header:** brokerage logo + "Ad Campaign Request — powered by Supersonic Sites"
(the one allowed Supersonic mention) + a brand-color accent rule.
**Hero:** "Launch a Listing Ad Campaign" + "Fill this out and our team takes it
from here."

**Fields, as five numbered cards:**

1. **Listing Address** — `listing_address` (required, ≤200 chars)
2. **Budget & Campaign**
   - `ad_budget` (required radio pills: **$50 / $100 / $150 / $200**)
   - `campaign_type` (radio pills: **New Ad Campaign** / **Extend Existing
     Campaign**, default New)
3. **Location Targeting** — `city_1` (required) … up to `city_10`; cities 4–10
   hidden behind an "Add more cities" disclosure. Caption: "closest first."
4. **Listing Stats** — `realtor_stats_link` (required URL) + a tip on using
   Realtor.ca's "SHARE LISTING" button.
5. **Special notes** — `notes` (optional textarea, ≤600 chars)

**Submit:** full-width "Submit Ad Campaign Request". **On mobile the submit bar is
sticky to the bottom.**

**`Constraint:` Mobile-first.** Realtors fill this on phones. 16px inputs (no iOS
zoom), sticky mobile submit, big tap targets on the radio pills.

**States:** default; **submitting** ("Submitting…", button disabled); invalid
token → a minimal "Link not active" 404 panel. *(There is also a hidden honeypot
anti-spam field — keep it invisible to humans but present in the DOM.)*

---

### 3.9 Intake thanks  *(public / white-label)*
`/intake/{token}/thanks` — confirmation after submit.

- Brand header (same as intake).
- "Request received" / "You're all set. 🚀" / (if address known) "Your ad campaign
  request for **{address}** is in the queue…"
- **Next-steps list (3):** Expert Setup → Launch Confirmation → Executive Report
  (~2 weeks after launch).
- "A confirmation email is on its way." + **"Submit another listing"** link.

---

### 3.10 Executive Report  *(public / white-label)* — the client deliverable
`/reports/{id}` — a **white-label, Letter-size, multi-page, PDF-printable** report
for the seller. **Rendered only from a frozen snapshot** — every image is embedded,
so it never changes after generation.

**`Constraint:` Print fidelity.** Each sheet is exactly one 8.5×11 in Letter page.
The design must paginate cleanly to PDF (this is printed / forwarded to sellers).
Brand color appears only as thin accents (cover rule, chart line, list bars) on
otherwise white paper, and is auto-darkened if too light to stay legible.

**On-screen toolbar (hidden in print/PDF):** "← Back" (hidden for public share
viewers), a small Supersonic mark labelled "Executive Report preview", and
**"Download PDF"** (shows "Preparing PDF…" while it renders).

**The sheets:**

- **S1 · Cover** — brokerage logo/name lockup; "Executive Report: {address}";
  "Online Advertising Campaign"; optional hero image + 3-up photo grid.
- **S2 · Campaign Stats + Sample Overview** — big numbers: **Total Ad Impressions**,
  **Reach**, **All Clicks & Likes**; then a **Facebook/Instagram ad mockup** built
  from the caption + photos (or real Ads-Manager screenshots if the team uploaded them).
- **S3 · In-Depth Data Of Users** *(omitted if no link stats)* — a print-safe
  **clicks-over-time chart** (inline SVG, no JS), **Total / Human clicks** tiles,
  and "Top" lists (cities, countries, browsers, operating systems, referrers) with
  proportional bars.
- **S4 · REALTOR.ca MLS Stats** *(omitted if no screenshots)* — stacked 7 / 30 / 90
  day screenshots.
- **S5 · Disclaimer** — two legal/privacy paragraphs; "Prepared by {brokerage}";
  address + contact; footer with website + listing address.

**Access modes:** normal (internal, with Back link); `?print=1` (PDF renderer,
toolbar hidden); `?t={token}` public share link (for clients, no login — used when
the PDF is too big to email).

**States:** not-found (404) "Report not found" panel.

---

## 4. The 6 workflow emails
The system sends transactional emails at workflow milestones. The designer should
provide email templates too (single-column, ~560px, works in email clients).
Three are **client-facing** (should feel brokerage-appropriate but currently carry
a Supersonic footer) and three are **internal**.

| # | Email | Trigger | To | Audience |
|---|---|---|---|---|
| 1 | **Intake confirmation** — "Request received 🚀" + 3 next steps | Intake submitted | Client | Client |
| 2 | **Review request** — "Ready for review" + CRM link | Post marked ready | Reviewer | Internal |
| 3 | **Launch confirmation** — "Your ad is live! 🚀" + what's happening | Ad published | Client | Client |
| 4 | **Report ready (internal)** — "Report ready to send" | Report generated | Team | Internal |
| 5 | **Report delivery** — "Executive Report — {address}" (PDF attached, or a download button if too big) | Report sent | Client | Client |
| 6 | **Report due reminder** — daily nag while a report is due | Due date reached | Team | Internal |

---

## 5. Design system notes (current — reinvent freely)

The current internal chrome uses these tokens. You are free to replace them; they
are listed so you know the starting palette and the semantic roles needed.

- **Supersonic accent:** `#29abe2` (blue), deep `#0f8ac4`, ink `#0b6d9f`
- **Ink / text:** `#0d1522` / `#182230`, soft `#47536b`, muted `#64748b`
- **Surfaces:** background `#f5f7fa`, card `#ffffff`, border `#e4e9f0`
- **Radii:** 16 / 12 / 8 px · **Shadows:** subtle 1px + soft large drop
- **Type:** Inter (400/500/600/700), shipped locally so report PDFs render
  identically everywhere
- **Button roles needed:** primary, secondary, ghost, danger (+ a small size)
- **Semantic status colors** (must survive): **green** = done/on-track/sent,
  **amber** = due-today/warning, **red** = overdue/error/failed.

**Brand-color roles for white-label:** each brokerage supplies exactly two colors
(`brand_primary`, `brand_accent`). The intake pages and report must theme
themselves from just these two. Design so any pair (including a very light one, on
the report) stays legible.

---

## 6. What we need from you (the prototype)

**Priority order** (highest-value screens first):

1. **Board** + **Kanban card** (the daily driver — nail the 6-stage clarity and
   the due-date urgency states).
2. **Request cockpit** (the operating surface — stepper, task banner, the numbered
   cards, the side panel).
3. **Post editor** with the **live Facebook preview** split-screen.
4. **Executive Report** (the client-facing deliverable — must be print-perfect and
   fully white-label).
5. **Intake form** (mobile-first, white-label).
6. **Report builder**, **Brokerage admin**, **Login**, **Thanks**, **emails**.

**Deliverables we'd love:**
- High-fidelity mockups for the screens above, in **desktop and mobile** where the
  screen is used on both (intake = mobile-first; board/cockpit/editor = desktop-first).
- Both **light and dark** treatments if you take the internal tool that way.
- The **two visual languages** clearly separated: Supersonic-branded internal tool
  vs. white-label client-facing surfaces.
- **Every state** on the key screens: empty, loading/submitting, success, error,
  and the status-specific variants (overdue/due-today, skipped stages, published/
  manual, sent).
- A short **component inventory** (buttons, chips, cards, form fields, badges,
  stepper, the FB preview card, stat tiles, the report sheet) so we can build a
  reusable system.

**Non-negotiables to honor** (the `Constraint:` callouts throughout, summarized):
- White-label discipline on public surfaces; report PDF has no Supersonic chrome.
- The 6-stage machine + Extend skip + move-back correction, expressed visually.
- Guard conditions surfaced as disabled actions + helper text.
- Post editor: live preview mirrors the exact published caption; the assembly format.
- Report builder: every value editable; source badges; HERO + exactly 6 gallery.
- Report: one Letter page per sheet, print-clean, brand-legible.
- Intake: mobile-first, works without JS.
- Status color semantics (green / amber / red).
