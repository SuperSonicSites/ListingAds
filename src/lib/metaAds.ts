import type { InsightsSource } from "./types";
import { GRAPH, demoMode, fetchJson, getPageAccessToken, metaToken } from "./metaCore";

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

// The published ad's creative, read via the system token — the "Sample Overview"
// caption + photos the report renders as a native Facebook-style mockup. Same
// never-throws adapter contract: any failure degrades to "manual" + warning and
// the builder's editable caption field stays the source of truth.
export type AdCreativeResult = {
  source: "meta_api" | "manual" | "mock";
  text: string;
  image_urls: string[];
  warning?: string;
};

const MAX_SAMPLE_IMAGES = 4;

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

// --- Ad creative (Sample Overview) --------------------------------------------

// A 3-line sample listing caption for DEMO_MODE — mirrors the shape of a real
// published post so the report mockup renders with representative text.
const DEMO_SAMPLE_CAPTION =
  "🚨 JUST LISTED!🚨 123 Sample Crescent\n💲 Offered at $749,900\n🛏️ 4 Bedrooms | 🛁 3 Bathrooms";

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Pull image.src values out of a Graph attachments node, subattachments first
// (multi-photo posts nest each photo there) capped at MAX_SAMPLE_IMAGES.
function imagesFromAttachments(attachments: any): string[] {
  const urls: string[] = [];
  const node = attachments?.data?.[0];
  const subs: any[] = Array.isArray(node?.subattachments?.data) ? node.subattachments.data : [];
  for (const sub of subs) {
    const src = trimText(sub?.media?.image?.src);
    if (src) urls.push(src);
  }
  if (urls.length === 0) {
    const src = trimText(node?.media?.image?.src);
    if (src) urls.push(src);
  }
  return urls.slice(0, MAX_SAMPLE_IMAGES);
}

// (b) object_story_spec: an unpublished/inline creative spec. photo_data has a
// single message/url; link_data a message + picture.
function fromObjectStorySpec(spec: any): { text: string; image_urls: string[] } {
  const photo = spec?.photo_data;
  const link = spec?.link_data;
  const text = trimText(photo?.message) || trimText(link?.message);
  const image = trimText(photo?.url) || trimText(link?.picture);
  return { text, image_urls: image ? [image] : [] };
}

function manualCreative(warning: string): AdCreativeResult {
  return { source: "manual", text: "", image_urls: [], warning };
}

/**
 * Read the published ad's creative for the report's Sample Overview. Uses the
 * system token to find the campaign's first ACTIVE ad (else the first ad), then
 * resolves the creative in three fallbacks — the effective published story, an
 * inline object_story_spec, or the creative's own body + image fields — taking
 * whatever resolves first. Missing pieces degrade gracefully (empty text or []).
 *
 * NOTE (production): the story-fetch attachments shape (media.image.src, and
 * subattachments for multi-photo posts) is the documented Graph structure but
 * could only be exercised against DEMO_MODE here — verify field shapes against a
 * real token before relying on multi-photo extraction.
 */
export async function fetchAdCreative(campaignId: string): Promise<AdCreativeResult> {
  const token = metaToken();
  if (!token) {
    if (demoMode()) {
      return { source: "mock", text: DEMO_SAMPLE_CAPTION, image_urls: [] };
    }
    return manualCreative(
      "Ad creative auto-fetch unavailable. The report will use the published post text and photos instead."
    );
  }

  try {
    // First ACTIVE ad (else the first ad) under the campaign, with its creative.
    const ads = await fetchJson(
      `${GRAPH}/${campaignId}/ads?fields=id,effective_status,` +
        `creative{effective_object_story_id,object_story_spec,image_url,thumbnail_url,body}&limit=25`,
      token
    );
    const list: any[] = Array.isArray(ads?.data) ? ads.data : [];
    const ad = list.find((entry) => entry.effective_status === "ACTIVE") ?? list[0];
    const creative = ad?.creative;
    if (!creative) {
      return manualCreative(
        "Ad creative auto-fetch unavailable. The report will use the published post text and photos instead."
      );
    }

    // (a) The effective published story ("<pageId>_<postId>"). Reading a Page's
    // own post needs a Page token minted from the system-user token.
    const storyId = trimText(creative.effective_object_story_id);
    if (storyId) {
      const pageId = storyId.split("_")[0];
      const pageToken = pageId ? await getPageAccessToken(pageId, token) : undefined;
      if (pageToken) {
        const story = await fetchJson(
          `${GRAPH}/${storyId}?fields=message,full_picture,` +
            `attachments{media,subattachments{media}}`,
          pageToken
        );
        const text = trimText(story?.message);
        let images = imagesFromAttachments(story?.attachments);
        if (images.length === 0) {
          const full = trimText(story?.full_picture);
          if (full) images = [full];
        }
        if (text || images.length > 0) {
          return { source: "meta_api", text, image_urls: images };
        }
      }
    }

    // (b) An inline object_story_spec (unpublished creative).
    const fromSpec = fromObjectStorySpec(creative.object_story_spec);
    if (fromSpec.text || fromSpec.image_urls.length > 0) {
      return { source: "meta_api", text: fromSpec.text, image_urls: fromSpec.image_urls };
    }

    // (c) The creative's own body + image fields.
    const body = trimText(creative.body);
    const image = trimText(creative.image_url) || trimText(creative.thumbnail_url);
    return { source: "meta_api", text: body, image_urls: image ? [image] : [] };
  } catch (error) {
    console.warn(`[metaAds] ad creative fetch failed for ${campaignId}:`, error);
    return manualCreative(
      "Ad creative auto-fetch unavailable. The report will use the published post text and photos instead."
    );
  }
}
