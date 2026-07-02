import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { addDays } from "../../../../lib/dates";
import { ISO_DATE, errorPage as sharedErrorPage, field, redirect, validateCampaignId } from "../../../../lib/http";
import { readRequest, writeRequest } from "../../../../lib/storage";

export const prerender = false;

// Saves the three campaign fields (fb_campaign_id, ad_launch_date,
// report_due_date) WITHOUT transitioning. "Record Ad Launch" posts the same
// form to /status with to=ad_published instead.

function errorPage(status: number, message: string, backHref?: string) {
  const back = backHref
    ? `<p><a href="${backHref}">Return to the request</a>, or use your browser's <strong>Back</strong> button — your entries are preserved there.</p>`
    : `<p>Use your browser's <strong>Back</strong> button to return to the form — your entries are preserved there.</p>`;
  return sharedErrorPage(status, "Campaign not saved", `<p>${message}</p>
${back}`);
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

  const campaignId = field(form, "fb_campaign_id");
  const allowAny = field(form, "allow_any") === "on";
  const campaignIdError = validateCampaignId(campaignId, allowAny, "save");
  if (campaignIdError) {
    return errorPage(400, campaignIdError, detailHref);
  }

  const launchDate = field(form, "ad_launch_date");
  if (launchDate && !ISO_DATE.test(launchDate)) {
    return errorPage(400, "The Ad Launch Date must be a valid date.", detailHref);
  }
  let dueDate = field(form, "report_due_date");
  if (dueDate && !ISO_DATE.test(dueDate)) {
    return errorPage(400, "The Report Due Date must be a valid date.", detailHref);
  }
  if (!dueDate && launchDate) {
    dueDate = addDays(launchDate, 14); // spec default: launch + 14 days
  }

  // Once launched, these three fields are load-bearing invariants (board due
  // badges, reminders, insight pulls, the frozen report). Refuse to blank them
  // out here — clearing them would silently break the campaign with no warning.
  const launched = record.status === "ad_published" || record.status === "campaign_in_progress" || record.status === "completed";
  if (launched && (!campaignId || !launchDate || !dueDate)) {
    return errorPage(
      400,
      "This campaign is already launched — Campaign ID, Ad Launch Date, and Report Due Date can't be cleared. Edit the values instead of blanking them.",
      detailHref
    );
  }

  // Re-read immediately before writing so a concurrent save (e.g. the reminder
  // tick) isn't clobbered; apply only the fields this route owns.
  const fresh = await readRequest(requestId).catch(() => record);
  fresh.fb_campaign_id = campaignId || undefined;
  fresh.ad_launch_date = launchDate || undefined;
  fresh.report_due_date = dueDate || undefined; // blank clears only pre-launch
  await writeRequest(fresh);

  return redirect(`${detailHref}#card-campaign`);
};
