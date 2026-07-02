import type { AdRequest, RequestStatus } from "./types";
import { allowedForward, isTransitionAllowed } from "./status";
import { readBrokerage, readRequest, writeRequest } from "./storage";
import { sendAndLog } from "./email";
import { launchConfirmation, reviewRequest } from "./emailTemplates";

// The one place a status change happens. Guards enforce the §7 table; side
// effects (workflow emails) fire AFTER the state write and never roll a
// transition back — a failed email is logged on the request and retried from
// the email log UI.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type TransitionResult = { ok: true; request: AdRequest } | { ok: false; error: string };

function guard(request: AdRequest, to: RequestStatus): string | undefined {
  const forward = isForward(request, to);
  if (!forward) return undefined; // corrections move freely

  if (to === "post_created") {
    if (!request.post.final_text.trim()) return "Write the post text before marking it ready for review.";
    if (request.post.photo_ids.length === 0) return "Select at least one post photo before review.";
    if (!request.short_link?.url) return "Create the nowforsale.co short link first (on the request page).";
  }

  if (to === "ad_published") {
    if (!request.fb_campaign_id) return "Enter the Facebook Campaign ID before recording the launch.";
    if (!request.ad_launch_date || !ISO_DATE.test(request.ad_launch_date)) {
      return "Set the Ad Launch Date before recording the launch.";
    }
    if (!request.report_due_date || !ISO_DATE.test(request.report_due_date)) {
      return "Set the Report Due Date before recording the launch.";
    }
    if (request.campaign_type !== "extend" && !request.post_published) {
      return "Push the post live (or record its URL manually) before recording the launch.";
    }
  }

  return undefined;
}

function isForward(request: AdRequest, to: RequestStatus): boolean {
  // Anything reachable via allowedForward is a forward move; back/reopen are not.
  return allowedForward(request).includes(to);
}

export async function applyTransition(requestId: string, to: RequestStatus): Promise<TransitionResult> {
  let request: AdRequest;
  try {
    request = await readRequest(requestId);
  } catch {
    return { ok: false, error: "Request not found." };
  }

  if (request.status === to) return { ok: true, request };
  if (!isTransitionAllowed(request, to)) {
    return { ok: false, error: `Cannot move from "${request.status}" to "${to}".` };
  }

  const guardError = guard(request, to);
  if (guardError) return { ok: false, error: guardError };

  const forward = isForward(request, to);
  // An extend request jumps new_order -> ad_published (skipping the post
  // stages); note that on the timeline so the audit trail explains the gap.
  const skipped = forward && to === "ad_published" && request.status === "new_order";
  const note = skipped ? "extension — post stages skipped" : forward ? undefined : "correction";
  request.status = to;
  request.status_history = [
    ...request.status_history,
    { status: to, at: new Date().toISOString(), ...(note ? { note } : {}) }
  ];
  await writeRequest(request);

  // Side-effect emails — forward moves only; failures logged, never blocking.
  if (forward) {
    try {
      const brokerage = await readBrokerage(request.brokerage_slug);
      if (to === "post_created") {
        await sendAndLog(request.id, "review_request", reviewRequest(request));
      } else if (to === "ad_published") {
        await sendAndLog(request.id, "launch", launchConfirmation(request, brokerage));
      }
    } catch (error) {
      console.warn(`[transitions] side-effect email failed for ${request.id} -> ${to}:`, error);
    }
  }

  return { ok: true, request: await readRequest(requestId) };
}
