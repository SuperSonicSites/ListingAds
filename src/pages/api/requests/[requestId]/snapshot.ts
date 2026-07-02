import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import {
  createSecretToken,
  createSnapshotId,
  readBrokerage,
  readRequest,
  writeRequest,
  writeSnapshot
} from "../../../../lib/storage";
import { embedAsset, findAsset } from "../../../../lib/uploads";
import { sendAndLog } from "../../../../lib/email";
import { reportReadyInternal } from "../../../../lib/emailTemplates";
import type { AdRequest, BreakdownRow, ExecReportSnapshot, InsightsSource } from "../../../../lib/types";

export const prerender = false;

// Freeze the Executive Report snapshot. Every image is embedded as a base64
// data URI at this moment (snapshot invariant: reports render only from frozen
// bytes, never from files or records that may later change). Regeneration
// mints a NEW snapshot id; the request points at the latest.

const MAX_BREAKDOWN_ROWS = 50;

function field(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}

// Invalid input must be rejected, not silently frozen as 0 in a client-facing PDF.
function numberField(form: FormData, name: string): number | null {
  const raw = field(form, name).replace(/,/g, "");
  if (raw === "") return 0; // empty is a legitimate "no value yet"
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function sourceField(form: FormData, name: string): InsightsSource {
  const value = field(form, name);
  return value === "meta_api" || value === "mock" ? value : "manual";
}

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

// Form POSTs navigate the browser, so a bare text/plain 400 is a dead end. Entries are
// only preserved via history back (bfcache) — a fresh GET of the form would be blank,
// so the copy steers to the Back button and the link is a last resort.
function errorPage(status: number, message: string, backHref: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report not generated</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size:1.25rem;">Report not generated</h1>
<p>${message}</p>
<p>Use your browser's <strong>Back</strong> button to return to the builder — your entries are preserved there.</p>
<p><a href="${backHref}">Or reopen the report builder</a>.</p>
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function coerceNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

// Breakdown rows arrive as JSON serialized from the builder's editable tables.
// Anything malformed degrades to [] — the report simply omits the tables.
function parseBreakdownJson(raw: string): BreakdownRow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row: any): BreakdownRow => ({
        key: String(row?.key ?? "").trim().slice(0, 80),
        impressions: coerceNumber(row?.impressions),
        reach: coerceNumber(row?.reach),
        clicks: coerceNumber(row?.clicks)
      }))
      .filter((row) => row.key)
      .slice(0, MAX_BREAKDOWN_ROWS);
  } catch {
    return [];
  }
}

function singleAssetId(request: AdRequest, kind: string): string | undefined {
  return request.assets.find((asset) => asset.kind === kind)?.id;
}

export const POST: APIRoute = async ({ params, request }) => {
  if (!isAdmin(request)) {
    return errorPage(401, "Admin sign-in required.", "/login");
  }

  const requestId = params.requestId ?? "";
  const backHref = `/requests/${requestId}/report`;

  let adRequest: AdRequest;
  try {
    adRequest = await readRequest(requestId);
  } catch {
    return errorPage(404, "Request not found.", "/");
  }

  const form = await request.formData();

  if (field(form, "approved") !== "yes") {
    return errorPage(400, "Tick the review checkbox to confirm the stats, screenshots, and photos are correct.", backHref);
  }

  const impressions = numberField(form, "impressions");
  const reach = numberField(form, "reach");
  const clicksAll = numberField(form, "clicks_all");
  if (impressions === null || reach === null || clicksAll === null) {
    return errorPage(400, "Impressions, Reach, and All Clicks & Likes must be non-negative numbers.", backHref);
  }

  // Hero + exactly 6 gallery picks, all resolved through the asset manifest.
  const heroId = field(form, "hero_id");
  if (!heroId || !findAsset(adRequest, heroId)) {
    return errorPage(400, "Pick a HERO photo in section 03.", backHref);
  }
  const galleryIds = field(form, "gallery_ids")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const galleryValid =
    galleryIds.length === 6 &&
    new Set(galleryIds).size === 6 &&
    galleryIds.every((id) => Boolean(findAsset(adRequest, id)));
  if (!galleryValid) {
    return errorPage(400, "Pick exactly 6 gallery photos in section 03.", backHref);
  }

  const previewMobileId = singleAssetId(adRequest, "ad_preview_mobile");
  const previewDesktopId = singleAssetId(adRequest, "ad_preview_desktop");
  if (!previewMobileId || !previewDesktopId) {
    return errorPage(400, "Capture or upload both ad previews (mobile and desktop) in section 02.", backHref);
  }

  const realtor7Id = singleAssetId(adRequest, "realtor_7");
  const realtor30Id = singleAssetId(adRequest, "realtor_30");
  const realtor90Id = singleAssetId(adRequest, "realtor_90");
  const waiveRealtor = field(form, "waive_realtor") === "yes";
  if ((!realtor7Id || !realtor30Id || !realtor90Id) && !waiveRealtor) {
    return errorPage(
      400,
      "Upload all three REALTOR.ca screenshots (7/30/90 day) — or tick “Generate without REALTOR.ca pages”.",
      backHref
    );
  }

  let brokerage;
  try {
    brokerage = await readBrokerage(adRequest.brokerage_slug);
  } catch {
    return errorPage(400, "The brokerage record for this request could not be read.", backHref);
  }

  const insightsScreens = adRequest.assets.filter((asset) => asset.kind === "insights_screenshot");

  const snapshot: ExecReportSnapshot = {
    request_id: adRequest.id,
    created_at: new Date().toISOString(),
    share_token: createSecretToken(),
    brokerage: {
      // Prepared-by fields are editable in the builder; brand assets come from
      // the brokerage record (logo_url is already a data URI — passed through).
      name: field(form, "prepared_by") || brokerage.name,
      logo_url: brokerage.logo_url,
      brand_primary: brokerage.brand_primary,
      brand_accent: brokerage.brand_accent,
      address_line: field(form, "brokerage_address"),
      contact_line: field(form, "contact_line"),
      website: field(form, "website") || brokerage.website
    },
    listing: {
      address: adRequest.listing_address,
      short_link: adRequest.short_link?.url ?? "",
      price: adRequest.post.price,
      beds: adRequest.post.beds,
      baths: adRequest.post.baths,
      neighborhood: adRequest.post.neighborhood
    },
    campaign: {
      fb_campaign_id: adRequest.fb_campaign_id ?? "",
      ad_launch_date: adRequest.ad_launch_date ?? "",
      report_due_date: adRequest.report_due_date ?? "",
      budget: adRequest.ad_budget,
      campaign_type: adRequest.campaign_type,
      target_cities: adRequest.target_cities
    },
    insights: {
      source: sourceField(form, "insights_source"),
      impressions,
      reach,
      clicks_all: clicksAll,
      region: parseBreakdownJson(field(form, "region_json")),
      age_gender: parseBreakdownJson(field(form, "age_gender_json")),
      warnings: []
    },
    images: {
      hero: await embedAsset(adRequest, heroId),
      gallery: await Promise.all(galleryIds.map((id) => embedAsset(adRequest, id))),
      ad_preview_mobile: await embedAsset(adRequest, previewMobileId),
      ad_preview_desktop: await embedAsset(adRequest, previewDesktopId),
      realtor_7: await embedAsset(adRequest, realtor7Id),
      realtor_30: await embedAsset(adRequest, realtor30Id),
      realtor_90: await embedAsset(adRequest, realtor90Id),
      insights_screens: (
        await Promise.all(insightsScreens.map((asset) => embedAsset(adRequest, asset.id)))
      ).filter(Boolean)
    }
  };

  const snapshotId = createSnapshotId();
  await writeSnapshot(snapshotId, snapshot);

  // Re-read before writing so a concurrent edit elsewhere isn't clobbered.
  const fresh = await readRequest(requestId);
  fresh.report_snapshot_id = snapshotId;
  await writeRequest(fresh);

  // Email #4 (internal report-ready) — a failure is logged on the request and
  // retried from the email log; it never blocks the freeze.
  await sendAndLog(requestId, "report_ready_internal", reportReadyInternal(fresh));

  return redirect(`/reports/${snapshotId}`);
};
