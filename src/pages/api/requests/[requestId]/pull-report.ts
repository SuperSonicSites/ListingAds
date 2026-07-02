import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { json } from "../../../../lib/http";
import { readRequest } from "../../../../lib/storage";
import {
  fetchAdCreative,
  fetchCampaignInsights,
  fetchInsightsBreakdowns
} from "../../../../lib/metaAds";
import { captureRealtorStats } from "../../../../lib/realtorCapture";

export const prerender = false;

// Report-builder data pulls. Returns JSON that hydrates the form inputs only —
// nothing here writes the snapshot (the freeze happens in snapshot.ts from the
// reviewed, possibly-edited form values). mode=creative returns the ad's
// caption + photo URLs (via the Marketing API) for the Sample Overview.

export const POST: APIRoute = async ({ params, request }) => {
  if (!isAdmin(request)) {
    return json(401, { error: "Admin sign-in required." });
  }

  const requestId = params.requestId ?? "";
  let adRequest;
  try {
    adRequest = await readRequest(requestId);
  } catch {
    return json(404, { error: "Request not found." });
  }

  let mode = "";
  try {
    const body = await request.json();
    mode = String(body?.mode ?? "");
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  if (mode === "stats") {
    if (!adRequest.fb_campaign_id) {
      return json(400, { error: "Record the Facebook Campaign ID on the request page first." });
    }
    if (!adRequest.ad_launch_date || !adRequest.report_due_date) {
      return json(400, {
        error: "Set the Ad Launch Date and Report Due Date on the request page first."
      });
    }
    const [insights, breakdowns] = await Promise.all([
      fetchCampaignInsights(adRequest.fb_campaign_id, adRequest.ad_launch_date, adRequest.report_due_date),
      fetchInsightsBreakdowns(adRequest.fb_campaign_id, adRequest.ad_launch_date, adRequest.report_due_date)
    ]);
    return json(200, { insights, breakdowns });
  }

  if (mode === "creative") {
    if (!adRequest.fb_campaign_id) {
      return json(400, { error: "Record the Facebook Campaign ID on the request page first." });
    }
    const result = await fetchAdCreative(adRequest.fb_campaign_id);
    return json(200, result);
  }

  if (mode === "realtor") {
    if (!adRequest.realtor_stats_link) {
      return json(400, { error: "This request has no REALTOR.ca stats link. Upload the screenshots manually." });
    }
    const result = await captureRealtorStats(requestId, adRequest.realtor_stats_link);
    return json(200, result);
  }

  return json(400, { error: 'Unknown mode — use "stats", "creative", or "realtor".' });
};
