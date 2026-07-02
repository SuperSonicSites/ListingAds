import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { errorPage as sharedErrorPage, field, redirect } from "../../../../lib/http";
import { sendAndLog, type EmailPayload } from "../../../../lib/email";
import {
  intakeConfirmation,
  launchConfirmation,
  reportDueReminder,
  reportReadyInternal,
  reviewRequest
} from "../../../../lib/emailTemplates";
import { readBrokerage, readRequest } from "../../../../lib/storage";
import type { EmailKind } from "../../../../lib/types";

export const prerender = false;

// Resend a logged workflow email. The payload is rebuilt from CURRENT data
// (request + brokerage), never replayed from the log — so a fixed contact
// email or corrected listing address flows into the retry. report_delivery is
// the exception: it carries the PDF and must go through send-report.

function errorPage(status: number, message: string, backHref?: string) {
  const back = backHref
    ? `<p><a href="${backHref}">Return to the request</a>, or use your browser's <strong>Back</strong> button.</p>`
    : `<p>Use your browser's <strong>Back</strong> button to return to the request.</p>`;
  return sharedErrorPage(status, "Email not sent", `<p>${message}</p>
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
  const kind = field(form, "kind");

  // The delivery email carries the rendered PDF — resending it here would drop
  // the attachment. Steer to the real path instead of a dead-end error page.
  if (kind === "report_delivery") {
    const warning = "Use the Send Executive Report button to resend the report.";
    return redirect(`${detailHref}?warning=${encodeURIComponent(warning)}#card-report`);
  }

  let payload: EmailPayload;
  switch (kind) {
    case "intake_confirmation":
    case "launch":
    case "report_due_reminder": {
      let brokerage;
      try {
        brokerage = await readBrokerage(record.brokerage_slug);
      } catch {
        return errorPage(
          400,
          "The brokerage record no longer exists, so this email cannot be rebuilt.",
          detailHref
        );
      }
      payload =
        kind === "intake_confirmation"
          ? intakeConfirmation(record, brokerage)
          : kind === "launch"
            ? launchConfirmation(record, brokerage)
            : reportDueReminder(record, brokerage);
      break;
    }
    case "review_request":
      payload = reviewRequest(record);
      break;
    case "report_ready_internal":
      payload = reportReadyInternal(record);
      break;
    default:
      return errorPage(400, "Unknown email kind.", detailHref);
  }

  await sendAndLog(record.id, kind as EmailKind, payload);
  return redirect(`${detailHref}#card-emails`);
};
