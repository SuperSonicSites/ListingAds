import type { APIRoute } from "astro";
import { errorPage as sharedErrorPage, field, isHttpUrl, redirect } from "../../lib/http";
import { createRequestId, findBrokerageByToken, writeRequest } from "../../lib/storage";
import { AD_BUDGETS, emptyPostDraft } from "../../lib/types";
import type { AdBudget, AdRequest, CampaignType } from "../../lib/types";
import { sendAndLog } from "../../lib/email";
import { intakeConfirmation } from "../../lib/emailTemplates";

export const prerender = false;

const MAX_BODY_BYTES = 65536;
const MAX_PER_HOUR = 5;
const WINDOW_MS = 60 * 60 * 1000;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const MAX_ADDRESS_CHARS = 200;
const MAX_NOTES_CHARS = 600;

// In-memory rate limit: token -> submission timestamps within the rolling hour.
// globalThis singleton so dev hot-reload doesn't reset the counters.
type RateStore = Map<string, number[]>;
const globalScope = globalThis as typeof globalThis & { __sarIntakeRate?: RateStore };
const rateStore: RateStore = globalScope.__sarIntakeRate ?? new Map();
globalScope.__sarIntakeRate = rateStore;

// Form POSTs navigate the browser, so a bare text/plain 400 is a dead end. Entries are
// only preserved via history back (bfcache) — a fresh GET of the form would be blank,
// so the copy steers to the Back button and the link is a last resort. Messages are
// static strings only — never echo client input into this HTML.
function errorPage(status: number, message: string, backHref?: string) {
  return sharedErrorPage(
    status,
    "Request not submitted",
    `<p>${message}</p>
<p>Use your browser's <strong>Back</strong> button to return to the form — your entries are preserved there.</p>
${backHref ? `<p><a href="${backHref}">Or start over with a blank form</a>.</p>` : ""}`
  );
}

export const POST: APIRoute = async ({ request }) => {
  // Body size cap — the intake form is a handful of short text fields; anything
  // bigger than 64KB is abuse, not a listing.
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
  if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
    return errorPage(413, "The submission is too large. Please shorten your entries and try again.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage(400, "The submission could not be read. Please try again.");
  }

  const token = field(form, "intake_token");
  const backHref = TOKEN_RE.test(token) ? `/intake/${token}` : undefined;

  // Honeypot: real clients never see this field. Bots that fill it get a
  // convincing redirect and nothing is stored.
  if (field(form, "website_url") !== "") {
    return redirect(backHref ? `${backHref}/thanks` : "/");
  }

  const brokerage = TOKEN_RE.test(token) ? await findBrokerageByToken(token) : undefined;
  if (!brokerage) {
    return errorPage(404, "This link is not active. Please contact Supersonic Sites.");
  }

  // Rolling-hour rate limit per token. Attempts count even when validation
  // fails below — the cap is an abuse control, not a success counter.
  const now = Date.now();
  const stamps = (rateStore.get(token) ?? []).filter((at) => now - at < WINDOW_MS);
  if (stamps.length >= MAX_PER_HOUR) {
    rateStore.set(token, stamps);
    return errorPage(429, "Too many submissions — try again later.", backHref);
  }
  stamps.push(now);
  rateStore.set(token, stamps);

  const listingAddress = field(form, "listing_address");
  if (listingAddress.length < 1 || listingAddress.length > MAX_ADDRESS_CHARS) {
    return errorPage(400, "Please provide the listing address (up to 200 characters).", backHref);
  }

  const budgetValue = Number(field(form, "ad_budget"));
  if (!(AD_BUDGETS as readonly number[]).includes(budgetValue)) {
    return errorPage(400, "Please choose one of the ad budget options.", backHref);
  }
  const adBudget = budgetValue as AdBudget;

  const campaignTypeRaw = field(form, "campaign_type");
  if (campaignTypeRaw !== "new" && campaignTypeRaw !== "extend") {
    return errorPage(400, "Please choose a campaign type.", backHref);
  }
  const campaignType: CampaignType = campaignTypeRaw;

  const cities: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i <= 10; i++) {
    const city = field(form, `city_${i}`);
    if (city === "") continue;
    if (city.length < 2 || city.length > 80) {
      return errorPage(400, "Each city name must be between 2 and 80 characters.", backHref);
    }
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cities.push(city);
  }
  if (cities.length === 0) {
    return errorPage(400, "Please list at least one town or city to target.", backHref);
  }

  const photosLink = field(form, "photos_link");
  if (!isHttpUrl(photosLink)) {
    return errorPage(400, "The photos link must be a valid http(s) URL (Dropbox or Google Drive).", backHref);
  }

  const realtorStatsLink = field(form, "realtor_stats_link");
  if (!isHttpUrl(realtorStatsLink)) {
    return errorPage(400, "The REALTOR.ca stats link must be a valid http(s) URL.", backHref);
  }

  const specialNotes = field(form, "notes").slice(0, MAX_NOTES_CHARS);

  const nowIso = new Date().toISOString();
  const adRequest: AdRequest = {
    id: createRequestId(),
    brokerage_slug: brokerage.slug,
    status: "new_order",
    status_history: [{ status: "new_order", at: nowIso }],
    created_at: nowIso,
    listing_address: listingAddress,
    ad_budget: adBudget,
    campaign_type: campaignType,
    target_cities: cities,
    photos_link: photosLink,
    realtor_stats_link: realtorStatsLink,
    special_notes: specialNotes,
    post: emptyPostDraft(),
    assets: [],
    emails: []
  };

  await writeRequest(adRequest);

  // Email #1 — confirmation to the brokerage point person. sendAndLog never
  // throws by contract, but a template bug must not lose the saved request.
  try {
    await sendAndLog(adRequest.id, "intake_confirmation", intakeConfirmation(adRequest, brokerage));
  } catch (error) {
    console.error("[intake] confirmation email failed:", error);
  }

  return redirect(`/intake/${token}/thanks?address=${encodeURIComponent(listingAddress)}`);
};
