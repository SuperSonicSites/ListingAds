import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { errorPage as sharedErrorPage, field, isHttpUrl, redirect } from "../../../../lib/http";
import { createShortLink } from "../../../../lib/shortio";
import { readRequest, writeRequest } from "../../../../lib/storage";

export const prerender = false;

// Creates the branded short link ON CLICK (never automatically). House
// convention (verified against the live nowforsale.co links): the path is
// mls{MLS® number} and the destination is the brokerage-site listing page with
// the fixed Meta UTM tags appended. A short.io failure (path taken, API
// unreachable) redirects back with ?warning= so the form stays usable — only
// malformed input gets an error page.

const MLS_RE = /^\d{3,10}$/;
// The fixed campaign tags on every ad destination.
const UTM = "utm_source=meta&utm_medium=ppc&utm_campaign=supersonicrealtors";

function errorPage(status: number, message: string, backHref?: string) {
  const back = backHref
    ? `<p><a href="${backHref}">Return to the request</a>, or use your browser's <strong>Back</strong> button — your entries are preserved there.</p>`
    : `<p>Use your browser's <strong>Back</strong> button to return to the form — your entries are preserved there.</p>`;
  return sharedErrorPage(status, "Short link not saved", `<p>${message}</p>\n${back}`);
}

export const POST: APIRoute = async ({ params, request }) => {
  if (!isAdmin(request)) {
    return errorPage(401, "Admin sign-in required.");
  }

  const requestId = params.requestId ?? "";
  const detailHref = `/requests/${requestId}`;

  let record;
  try {
    record = await readRequest(requestId);
  } catch {
    return errorPage(404, "Request not found.");
  }

  const form = await request.formData();

  const mls = field(form, "mls_number").replace(/\D/g, "");
  if (!MLS_RE.test(mls)) {
    return errorPage(400, "Enter the listing's MLS® number (3–10 digits) — it becomes the /mls… path.", detailHref);
  }
  const path = `mls${mls}`;

  let originalUrl = field(form, "original_url");
  if (!isHttpUrl(originalUrl)) {
    return errorPage(400, "The destination URL must start with http:// or https://.", detailHref);
  }
  // The form prefills "{website}/listing/" — submitting it unfinished (or the
  // bare site root) would ship an ad pointing at nothing.
  const destinationPath = new URL(originalUrl).pathname.replace(/\/+$/, "");
  if (destinationPath === "" || destinationPath === "/listing") {
    return errorPage(400, "Complete the destination with the actual listing page on the brokerage site.", detailHref);
  }
  if (!/[?&]utm_/.test(originalUrl)) {
    originalUrl += (originalUrl.includes("?") ? "&" : "?") + UTM;
  }

  const result = await createShortLink(path, originalUrl, record.listing_address);
  if (!result.ok || !result.short_url) {
    const warning = result.warning ?? "short.io did not return a link. Try again.";
    return redirect(`${detailHref}?warning=${encodeURIComponent(warning)}#card-shortlink`);
  }

  // Re-read after the (up to 8s) short.io call so a concurrent write during
  // that window — e.g. the reminder tick — isn't clobbered.
  const fresh = await readRequest(requestId).catch(() => record);
  fresh.short_link = {
    url: result.short_url,
    path: result.path ?? path,
    ...(result.link_id ? { link_id: result.link_id } : {})
  };
  await writeRequest(fresh);

  return redirect(`${detailHref}#card-shortlink`);
};
