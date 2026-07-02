import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { json } from "../../../../lib/http";
import { readRequest } from "../../../../lib/storage";
import { captureRealtorPhotos } from "../../../../lib/realtorCapture";

export const prerender = false;

// Fetch the first 10 listing photos from REALTOR.ca and store them as
// post_photo assets on the request. Admin-only JSON POST (middleware gates it
// too — this is defense in depth). Requires the request's realtor_stats_link;
// captureRealtorPhotos never throws and returns { ok, saved, warnings }.

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

  if (!adRequest.realtor_stats_link) {
    return json(400, { error: "This request has no REALTOR.ca stats link. Upload the photos manually." });
  }

  const result = await captureRealtorPhotos(requestId, adRequest.realtor_stats_link);
  return json(200, result);
};
