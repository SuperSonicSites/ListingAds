import { Buffer } from "node:buffer";
import puppeteer from "puppeteer-core";
import type { AssetEntry, BreakdownRow, InsightsSource } from "./types";
import { GRAPH, demoMode, fetchJson, metaToken } from "./metaCore";
import { BROWSER_ARGS, browserPath } from "./browser";
import { saveUpload } from "./uploads";

// Marketing API reads for the Executive Report. The team creates the campaign
// manually in Ads Manager; this module only reads it by the recorded Campaign
// ID (via the brokerage's ad account access). Every function degrades to
// "manual" + warning — the report builder inputs stay editable regardless.

export type CampaignInsightsResult = {
  source: InsightsSource;
  impressions: number;
  reach: number;
  clicks_all: number; // Meta's `clicks` field: ALL clicks incl. like/engagement clicks
  spend: number;
  warning?: string;
};

export type InsightsBreakdownsResult = {
  source: InsightsSource;
  region: BreakdownRow[];
  age_gender: BreakdownRow[];
  warning?: string;
};

export type AdPreviewsResult = {
  source: InsightsSource;
  mobile?: AssetEntry;
  desktop?: AssetEntry;
  warnings: string[];
};

function manualInsights(warning: string): CampaignInsightsResult {
  return { source: "manual", impressions: 0, reach: 0, clicks_all: 0, spend: 0, warning };
}

function timeRange(since: string, until: string): string {
  return encodeURIComponent(JSON.stringify({ since, until }));
}

function num(value: unknown): number {
  const parsed = Number(value); // insights numbers arrive as strings
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function fetchCampaignInsights(
  campaignId: string,
  since: string,
  until: string
): Promise<CampaignInsightsResult> {
  const token = metaToken();
  if (!token) {
    if (demoMode()) {
      // The demo report's numbers.
      return { source: "mock", impressions: 6932, reach: 4154, clicks_all: 1403, spend: 150 };
    }
    return manualInsights("Meta token is not configured. Enter the campaign stats manually.");
  }

  try {
    const url =
      `${GRAPH}/${campaignId}/insights?level=campaign` +
      `&fields=impressions,reach,clicks,inline_link_clicks,spend,actions` +
      `&time_range=${timeRange(since, until)}`;
    const body = await fetchJson(url, token);
    const row = body?.data?.[0];
    if (!row) {
      // Empty data = no delivery in range (a valid zero, not an error).
      return { source: "meta_api", impressions: 0, reach: 0, clicks_all: 0, spend: 0 };
    }
    return {
      source: "meta_api",
      impressions: num(row.impressions),
      reach: num(row.reach),
      clicks_all: num(row.clicks),
      spend: num(row.spend)
    };
  } catch (error) {
    console.warn(`[metaAds] insights failed for ${campaignId}:`, error);
    return manualInsights("Campaign stats auto-fetch unavailable. Enter the numbers manually.");
  }
}

async function fetchBreakdown(
  campaignId: string,
  breakdowns: string,
  since: string,
  until: string,
  token: string,
  keyOf: (row: any) => string
): Promise<BreakdownRow[]> {
  const url =
    `${GRAPH}/${campaignId}/insights?level=campaign` +
    `&fields=impressions,reach,clicks&breakdowns=${breakdowns}` +
    `&time_range=${timeRange(since, until)}&limit=50`;
  const body = await fetchJson(url, token);
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((row) => ({
      key: keyOf(row),
      impressions: num(row.impressions),
      reach: num(row.reach),
      clicks: num(row.clicks)
    }))
    .filter((row) => row.key)
    .sort((a, b) => b.impressions - a.impressions);
}

export async function fetchInsightsBreakdowns(
  campaignId: string,
  since: string,
  until: string
): Promise<InsightsBreakdownsResult> {
  const token = metaToken();
  if (!token) {
    if (demoMode()) {
      return {
        source: "mock",
        region: [
          { key: "Whitehorse, Yukon", impressions: 4210, reach: 2483, clicks: 861 },
          { key: "British Columbia", impressions: 1954, reach: 1201, clicks: 388 },
          { key: "Alberta", impressions: 768, reach: 470, clicks: 154 }
        ],
        age_gender: [
          { key: "35-44 · female", impressions: 1730, reach: 1044, clicks: 402 },
          { key: "45-54 · female", impressions: 1418, reach: 852, clicks: 331 },
          { key: "35-44 · male", impressions: 1339, reach: 809, clicks: 274 },
          { key: "25-34 · female", impressions: 1122, reach: 688, clicks: 213 },
          { key: "55-64 · male", impressions: 703, reach: 428, clicks: 108 }
        ]
      };
    }
    return { source: "manual", region: [], age_gender: [], warning: "Meta token is not configured." };
  }

  try {
    // region cannot be combined with age/gender — two separate calls.
    const [region, ageGender] = await Promise.all([
      fetchBreakdown(campaignId, "region", since, until, token, (row) => String(row.region ?? "")),
      fetchBreakdown(campaignId, "age,gender", since, until, token, (row) =>
        [row.age, row.gender].filter(Boolean).join(" · ")
      )
    ]);
    return { source: "meta_api", region, age_gender: ageGender };
  } catch (error) {
    console.warn(`[metaAds] breakdowns failed for ${campaignId}:`, error);
    return {
      source: "manual",
      region: [],
      age_gender: [],
      warning: "Breakdown auto-fetch unavailable. Add rows manually or upload Ads Manager screenshots."
    };
  }
}

// --- Ad preview screenshots ---------------------------------------------------

// NOTE: enum spellings are the long-standing /previews values — if Meta renames
// them the Graph error message lists the valid set; update here.
const PREVIEW_FORMATS = [
  { format: "MOBILE_FEED_STANDARD", kind: "ad_preview_mobile" as const, width: 375, height: 812, scale: 2 },
  { format: "DESKTOP_FEED_STANDARD", kind: "ad_preview_desktop" as const, width: 1240, height: 900, scale: 1 }
];

function extractIframeSrc(html: string): string | undefined {
  const match = html.match(/src="([^"]+)"/);
  return match ? match[1].replaceAll("&amp;", "&") : undefined;
}

function demoPreviewPage(label: string): string {
  const html = `<!doctype html><html><body style="margin:0;display:grid;place-items:center;height:100vh;background:#f0f2f5;font-family:sans-serif;">
    <div style="width:80%;max-width:420px;background:#fff;border:1px solid #dfe3ea;border-radius:10px;padding:28px;text-align:center;">
      <div style="width:44px;height:44px;border-radius:50%;background:#1877f2;margin:0 auto 14px;"></div>
      <strong style="font-size:17px;">Ad preview — ${label}</strong>
      <p style="color:#65676b;font-size:13px;">DEMO_MODE placeholder. Live captures replace this screenshot.</p>
      <div style="height:180px;border-radius:8px;background:linear-gradient(135deg,#dbe4ee,#c3d0de);margin-top:12px;"></div>
    </div>
  </body></html>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

/**
 * Capture mobile + desktop preview screenshots for the campaign's first active
 * ad and store them as request assets. Preview iframe URLs are short-lived
 * signed URLs — they are screenshotted immediately and never persisted.
 */
export async function captureAdPreviews(campaignId: string, requestId: string): Promise<AdPreviewsResult> {
  const token = metaToken();
  const warnings: string[] = [];
  const demo = !token && demoMode();

  if (!token && !demo) {
    return { source: "manual", warnings: ["Meta token is not configured. Upload preview screenshots manually."] };
  }

  // Resolve the preview URLs first (cheap), then screenshot both in one browser.
  const targets: { kind: (typeof PREVIEW_FORMATS)[number]["kind"]; url: string; width: number; height: number; scale: number }[] = [];

  if (demo) {
    for (const spec of PREVIEW_FORMATS) {
      targets.push({ kind: spec.kind, url: demoPreviewPage(spec.format), width: spec.width, height: spec.height, scale: spec.scale });
    }
  } else {
    let adId: string | undefined;
    try {
      const ads = await fetchJson(
        `${GRAPH}/${campaignId}/ads?fields=id,name,effective_status&limit=25`,
        token!
      );
      const list: any[] = Array.isArray(ads?.data) ? ads.data : [];
      adId = (list.find((ad) => ad.effective_status === "ACTIVE") ?? list[0])?.id;
    } catch (error) {
      console.warn(`[metaAds] ads lookup failed for ${campaignId}:`, error);
    }
    if (!adId) {
      return {
        source: "manual",
        warnings: ["No ads found under that campaign ID. Upload preview screenshots manually."]
      };
    }
    for (const spec of PREVIEW_FORMATS) {
      try {
        const body = await fetchJson(`${GRAPH}/${adId}/previews?ad_format=${spec.format}`, token!);
        const src = extractIframeSrc(String(body?.data?.[0]?.body ?? ""));
        if (src) targets.push({ kind: spec.kind, url: src, width: spec.width, height: spec.height, scale: spec.scale });
        else warnings.push(`No ${spec.format} preview returned. Upload that screenshot manually.`);
      } catch (error) {
        console.warn(`[metaAds] preview fetch failed (${spec.format}):`, error);
        warnings.push(`${spec.format} preview unavailable. Upload that screenshot manually.`);
      }
    }
  }

  if (targets.length === 0) {
    return { source: demo ? "mock" : "manual", warnings };
  }

  const executablePath = browserPath();
  if (!executablePath) {
    return {
      source: "manual",
      warnings: ["Preview capture needs Chrome, Edge, or CHROME_PATH set. Upload screenshots manually."]
    };
  }

  const result: AdPreviewsResult = { source: demo ? "mock" : "meta_api", warnings };
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: BROWSER_ARGS });
    for (const target of targets) {
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: target.width, height: target.height, deviceScaleFactor: target.scale });
        await page.goto(target.url, { waitUntil: "networkidle0", timeout: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, 1500)); // lazy images settle
        const png = Buffer.from(await page.screenshot({ fullPage: true, type: "png" }));
        await page.close();
        const entry = await saveUpload(requestId, target.kind, png, `${target.kind}.png`);
        if (target.kind === "ad_preview_mobile") result.mobile = entry;
        else result.desktop = entry;
      } catch (error) {
        console.warn(`[metaAds] preview screenshot failed (${target.kind}):`, error);
        warnings.push(`Could not capture the ${target.kind.replaceAll("_", " ")}. Upload it manually.`);
      }
    }
  } catch (error) {
    console.warn("[metaAds] preview browser launch failed:", error);
    warnings.push("Preview capture failed to start a browser. Upload screenshots manually.");
  } finally {
    await browser?.close();
  }

  return result;
}
