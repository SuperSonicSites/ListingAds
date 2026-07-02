import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { addDays } from "../../../../lib/dates";
import { readRequest, writeRequest } from "../../../../lib/storage";
import { applyTransition } from "../../../../lib/transitions";
import { REQUEST_STATUSES, type RequestStatus } from "../../../../lib/types";

export const prerender = false;

// Status transitions — the only mutation this route performs besides saving the
// campaign fields that "Record Ad Launch" submits alongside the move. All
// guard logic lives in lib/transitions (the single place a status changes).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CAMPAIGN_ID = /^\d{5,25}$/;

function field(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function errorPage(status: number, message: string, backHref?: string) {
  const back = backHref
    ? `<p><a href="${backHref}">Return to the request</a>, or use your browser's <strong>Back</strong> button — your entries are preserved there.</p>`
    : `<p>Use your browser's <strong>Back</strong> button to return to the form — your entries are preserved there.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Status not changed</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size:1.25rem;">Status not changed</h1>
<p>${message}</p>
${back}
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// 303 back to where the form was submitted from (board or detail page), as long
// as the referer is ours; otherwise land on the request detail page.
function backTo(request: Request, fallback: string) {
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.origin === new URL(request.url).origin) return url.pathname;
    } catch {
      /* unparseable referer — use the fallback */
    }
  }
  return fallback;
}

export const POST: APIRoute = async ({ params, request }) => {
  if (!isAdmin(request)) {
    return errorPage(401, "Admin sign-in required.");
  }

  const requestId = params.requestId ?? "";
  const detailHref = `/requests/${requestId}`;
  const form = await request.formData();

  const to = field(form, "to");
  if (!(REQUEST_STATUSES as readonly string[]).includes(to)) {
    return errorPage(400, "Unknown status target.", detailHref);
  }
  const target = to as RequestStatus;

  // "Record Ad Launch" saves the campaign fields FIRST, then transitions —
  // applyTransition's guard reads them off the stored record.
  if (target === "ad_published") {
    let record;
    try {
      record = await readRequest(requestId);
    } catch {
      return errorPage(404, "Request not found.");
    }

    const campaignId = field(form, "fb_campaign_id") || record.fb_campaign_id || "";
    const allowAny = field(form, "allow_any") === "on";
    if (!campaignId) {
      return errorPage(400, "Enter the Facebook Campaign ID before recording the launch.", detailHref);
    }
    if (allowAny) {
      if (campaignId.length > 100) {
        return errorPage(400, "Campaign ID must be 1–100 characters.", detailHref);
      }
    } else if (!CAMPAIGN_ID.test(campaignId)) {
      return errorPage(
        400,
        "The Facebook Campaign ID should be 5–25 digits. Tick the non-standard ID override to record it anyway.",
        detailHref
      );
    }

    const launchDate = field(form, "ad_launch_date") || record.ad_launch_date || "";
    if (!ISO_DATE.test(launchDate)) {
      return errorPage(400, "Set the Ad Launch Date before recording the launch.", detailHref);
    }
    let dueDate = field(form, "report_due_date") || record.report_due_date || "";
    if (!dueDate) dueDate = addDays(launchDate, 14); // spec default: launch + 14 days
    if (!ISO_DATE.test(dueDate)) {
      return errorPage(400, "The Report Due Date must be a valid date.", detailHref);
    }

    record.fb_campaign_id = campaignId;
    record.ad_launch_date = launchDate;
    record.report_due_date = dueDate;
    await writeRequest(record);
  }

  const result = await applyTransition(requestId, target);
  if (!result.ok) {
    return errorPage(400, result.error, detailHref);
  }

  return redirect(backTo(request, detailHref));
};
