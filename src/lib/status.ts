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
 * Correction path: back to the previous *recorded* status (handles the extend
 * skip naturally), plus reopening a completed request for regenerate + resend.
 */
export function moveBackTarget(request: AdRequest): RequestStatus | undefined {
  if (request.status === "completed") return "campaign_in_progress";
  const history = request.status_history;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].status === request.status) {
      return i > 0 ? history[i - 1].status : undefined;
    }
  }
  // History predates this status (shouldn't happen) — fall back to the fixed order.
  const index = statusIndex(request.status);
  return index > 0 ? REQUEST_STATUSES[index - 1] : undefined;
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
