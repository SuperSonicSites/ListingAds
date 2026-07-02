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
import { errorPage as sharedErrorPage, field, redirect } from "../../../../lib/http";
import { embedAsset, embedRemoteImage, findAsset } from "../../../../lib/uploads";
import { statusIndex } from "../../../../lib/status";
import { sendAndLog } from "../../../../lib/email";
import { reportReadyInternal } from "../../../../lib/emailTemplates";
import type { AdRequest, ExecReportSnapshot, InsightsSource } from "../../../../lib/types";

export const prerender = false;

// Freeze the Executive Report snapshot. Every image is embedded as a base64
// data URI at this moment (snapshot invariant: reports render only from frozen
// bytes, never from files or records that may later change). Regeneration
// mints a NEW snapshot id; the request points at the latest.

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

// Form POSTs navigate the browser, so a bare text/plain 400 is a dead end. Entries are
// only preserved via history back (bfcache) — a fresh GET of the form would be blank,
// so the copy steers to the Back button and the link is a last resort.
function errorPage(status: number, message: string, backHref: string) {
  return sharedErrorPage(status, "Report not generated", `<p>${message}</p>
<p>Use your browser's <strong>Back</strong> button to return to the builder — your entries are preserved there.</p>
<p><a href="${backHref}">Or reopen the report builder</a>.</p>`);
}

function singleAssetId(request: AdRequest, kind: string): string | undefined {
  return request.assets.find((asset) => asset.kind === kind)?.id;
}

function coerceCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function coerceNameCounts(raw: unknown, cap = 7): { name: string; clicks: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row: any) => ({ name: String(row?.name ?? "").trim().slice(0, 60), clicks: coerceCount(row?.clicks) }))
    .filter((row) => row.name)
    .slice(0, cap);
}

// The builder's "Pull short.io stats" stores the full LinkStatsResult in a
// hidden JSON field; the two totals stay editable inputs (manual-fallback
// invariant). Malformed/absent JSON → undefined → the In-Depth sheet is omitted.
function parseLinkStats(
  raw: string,
  totalOverride: number | null,
  humanOverride: number | null
): ExecReportSnapshot["link_stats"] {
  let parsed: any;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  const series = Array.isArray(parsed?.series)
    ? parsed.series
        .map((point: any) => ({
          date: String(point?.date ?? "").slice(0, 10),
          clicks: coerceCount(point?.clicks)
        }))
        .filter((point: { date: string }) => /^\d{4}-\d{2}-\d{2}$/.test(point.date))
        .slice(0, 60)
    : [];
  const stats = {
    total_clicks: totalOverride ?? coerceCount(parsed?.total_clicks),
    human_clicks: humanOverride ?? coerceCount(parsed?.human_clicks),
    series,
    cities: coerceNameCounts(parsed?.cities),
    countries: coerceNameCounts(parsed?.countries),
    browsers: coerceNameCounts(parsed?.browsers),
    os: coerceNameCounts(parsed?.os),
    referrers: coerceNameCounts(parsed?.referrers)
  };
  return stats.series.length > 0 || stats.total_clicks > 0 ? stats : undefined;
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

  // Spec §7 row 5: the report can only be frozen once the campaign is live.
  // Freezing earlier mints a snapshot with empty campaign fields and fires the
  // internal report-ready email from the wrong status (e.g. new_order).
  if (statusIndex(adRequest.status) < statusIndex("campaign_in_progress")) {
    return errorPage(
      400,
      "Generate the report once the campaign is in progress — record the ad launch first.",
      backHref
    );
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

  // Ad-preview screenshots are now OPTIONAL manual overrides — when present they
  // replace the generated Facebook-style mockup on the mobile/desktop sample
  // sheets; when absent the sheet renders the ad_sample mockup instead.
  const previewMobileId = singleAssetId(adRequest, "ad_preview_mobile");
  const previewDesktopId = singleAssetId(adRequest, "ad_preview_desktop");

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

  // Sample Overview: the reviewed caption (or the published post text as the
  // manual-fallback) + up to 4 photos. Fetched fbcdn/cdninstagram URLs are
  // frozen as data URIs; if none survive, the published post's own photos (up to
  // 3, else the hero) are embedded from disk so the mockup is never empty.
  const sampleText = (field(form, "ad_sample_text") || adRequest.post.final_text).slice(0, 5000);
  const sampleImageUrls = field(form, "ad_sample_image_urls")
    .split("\n")
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, 4);
  let sampleImages = (await Promise.all(sampleImageUrls.map((url) => embedRemoteImage(url)))).filter(Boolean);
  if (sampleImages.length === 0) {
    const fallbackIds =
      adRequest.post.photo_ids.length > 0 ? adRequest.post.photo_ids.slice(0, 3) : [heroId];
    sampleImages = (await Promise.all(fallbackIds.map((id) => embedAsset(adRequest, id)))).filter(Boolean);
  }

  const linkStats = parseLinkStats(
    field(form, "link_stats_json"),
    field(form, "link_total_clicks") ? numberField(form, "link_total_clicks") : null,
    field(form, "link_human_clicks") ? numberField(form, "link_human_clicks") : null
  );

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
      clicks_all: clicksAll
    },
    ...(linkStats ? { link_stats: linkStats } : {}),
    ad_sample: {
      text: sampleText,
      images: sampleImages
    },
    images: {
      hero: await embedAsset(adRequest, heroId),
      gallery: await Promise.all(galleryIds.map((id) => embedAsset(adRequest, id))),
      ad_preview_mobile: previewMobileId ? await embedAsset(adRequest, previewMobileId) : "",
      ad_preview_desktop: previewDesktopId ? await embedAsset(adRequest, previewDesktopId) : "",
      realtor_7: await embedAsset(adRequest, realtor7Id),
      realtor_30: await embedAsset(adRequest, realtor30Id),
      realtor_90: await embedAsset(adRequest, realtor90Id)
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
