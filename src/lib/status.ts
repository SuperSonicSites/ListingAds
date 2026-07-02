import type { AdRequest, Brokerage, RequestStatus } from "./types";
import { REQUEST_STATUSES } from "./types";

// Single source of truth for the kanban workflow. The transitions API rejects
// anything not allowed here; side effects (emails, required fields) live with
// the API route but the *shape* of the machine is defined in this module.

export const STATUS_LABELS: Record<RequestStatus, string> = {
  new_order: "New Order",
  post_created: "Post Created",
  post_reviewed: "Post Reviewed",
  ad_published: "Ad Published",
  campaign_in_progress: "Campaign In Progress",
  completed: "Completed"
};

export function statusIndex(status: RequestStatus): number {
  return REQUEST_STATUSES.indexOf(status);
}

/**
 * Forward transitions. "Extend Existing Campaign" requests skip the post stages
 * entirely (the post already exists on the page): new_order -> ad_published.
 */
export function allowedForward(request: AdRequest): RequestStatus[] {
  switch (request.status) {
    case "new_order":
      return request.campaign_type === "extend" ? ["ad_published"] : ["post_created"];
    case "post_created":
      return ["post_reviewed"];
    case "post_reviewed":
      return ["ad_published"];
    case "ad_published":
      return ["campaign_in_progress"];
    case "campaign_in_progress":
      return ["completed"];
    case "completed":
      return [];
  }
}

/**
 * The effective forward path for a request, honoring the extend skip. Used to
 * derive the "move back" target so it never depends on raw status_history —
 * which, after a correction, contains the current status twice and would
 * otherwise resolve to the status you just came back FROM.
 */
function effectivePath(request: AdRequest): RequestStatus[] {
  if (request.campaign_type === "extend") {
    return ["new_order", "ad_published", "campaign_in_progress", "completed"];
  }
  return [...REQUEST_STATUSES];
}

/**
 * Correction path: back one step along the effective path (handles the extend
 * skip naturally), plus reopening a completed request for regenerate + resend.
 * Always strictly earlier than any allowedForward target, so a back-move can
 * never be misclassified as a forward move (which would re-fire its emails).
 */
export function moveBackTarget(request: AdRequest): RequestStatus | undefined {
  const path = effectivePath(request);
  const index = path.indexOf(request.status);
  return index > 0 ? path[index - 1] : undefined;
}

export function isTransitionAllowed(request: AdRequest, to: RequestStatus): boolean {
  return allowedForward(request).includes(to) || moveBackTarget(request) === to;
}

/**
 * Derived task — there is no task store. The exact strings from the spec are a
 * pure function of the record; moving the card is completing the task.
 * `today` is a YYYY-MM-DD business date (America/Vancouver).
 */
export function taskFor(request: AdRequest, brokerage: Brokerage, today: string): string | null {
  const suffix = `${request.listing_address} - ${brokerage.name}`;
  switch (request.status) {
    case "new_order":
      return request.campaign_type === "extend" ? `EXTEND CAMPAIGN: ${suffix}` : `CREATE POST: ${suffix}`;
    case "post_created":
      return `REVIEW POST: ${suffix}`;
    case "post_reviewed":
      return `PUBLISH & LAUNCH: ${suffix}`;
    case "ad_published":
      return null; // one-click continue to Campaign In Progress
    case "campaign_in_progress":
      if (request.report_due_date && request.report_due_date <= today) {
        return `${request.listing_address} - Send Executive Report for - ${brokerage.name}`;
      }
      return null; // "Campaign running — report due {date}" is rendered by the page
    case "completed":
      return null;
  }
}
