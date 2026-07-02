import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { EMAIL_RE, errorPage as sharedErrorPage, field, redirect } from "../../../../lib/http";
import { readBrokerage, readRequest, readSnapshot, writeRequest } from "../../../../lib/storage";
import { appBaseUrl, sendAndLog } from "../../../../lib/email";
import { reportDelivery } from "../../../../lib/emailTemplates";
import { renderReportPdf, reportPdfFilename } from "../../../../lib/pdf";
import { applyTransition } from "../../../../lib/transitions";

export const prerender = false;

// Send the Executive Report to the client (Email #5). The PDF is rendered
// server-side over loopback and attached when it fits Resend comfortably;
// otherwise the email carries a public tokenized download link instead. On a
// successful send the request auto-completes and report_sent_at is stamped.

// Resend's hard limit is ~40MB post-encode; attach only when the raw PDF is
// comfortably under that after base64 (+33%).
const MAX_ATTACH_BYTES = 15_000_000;

function errorPage(status: number, message: string, backHref: string) {
  return sharedErrorPage(status, "Report not sent", `<p>${message}</p>
<p>Use your browser's <strong>Back</strong> button to return — your entries are preserved there.</p>
<p><a href="${backHref}">Or go back to the request</a>.</p>`);
}

export const POST: APIRoute = async ({ params, request }) => {
  if (!isAdmin(request)) {
    return errorPage(401, "Admin sign-in required.", "/login");
  }

  const requestId = params.requestId ?? "";
  const backHref = `/requests/${requestId}`;

  let adRequest;
  try {
    adRequest = await readRequest(requestId);
  } catch {
    return errorPage(404, "Request not found.", "/");
  }

  const snapshotId = adRequest.report_snapshot_id;
  if (!snapshotId) {
    return errorPage(400, "Generate the Executive Report before sending it.", backHref);
  }

  let snapshot;
  try {
    snapshot = await readSnapshot(snapshotId);
  } catch {
    return errorPage(400, "The report snapshot is missing — regenerate the Executive Report.", backHref);
  }

  let brokerage;
  try {
    brokerage = await readBrokerage(adRequest.brokerage_slug);
  } catch {
    return errorPage(400, "The brokerage record for this request could not be read.", backHref);
  }

  const form = await request.formData();
  const to = field(form, "to") || brokerage.contact_email;
  if (!EMAIL_RE.test(to)) {
    return errorPage(400, "Enter a valid recipient email address.", backHref);
  }

  let pdf;
  try {
    pdf = await renderReportPdf(snapshotId, request.headers.get("cookie"));
  } catch (error) {
    console.error(`[send-report] PDF render failed for ${snapshotId}:`, error);
    return redirect(
      `${backHref}?warning=${encodeURIComponent("PDF generation failed — check that Chrome is available.")}`
    );
  }

  let payload;
  if (pdf.byteLength <= MAX_ATTACH_BYTES) {
    payload = reportDelivery(adRequest, brokerage, { to });
    payload.attachments = [
      { filename: reportPdfFilename(snapshot, snapshotId), content: pdf.toString("base64") }
    ];
  } else {
    // Too big to attach — same email, but with a public tokenized download link.
    const shareUrl = `${appBaseUrl()}/reports/${snapshotId}?t=${snapshot.share_token}`;
    payload = reportDelivery(adRequest, brokerage, { to, shareUrl });
  }

  const entry = await sendAndLog(requestId, "report_delivery", payload);

  if (!entry.ok) {
    return redirect(`${backHref}?warning=${encodeURIComponent(entry.error ?? "Email send failed.")}`);
  }

  // Fresh read: sendAndLog already rewrote the record (email log append).
  const fresh = await readRequest(requestId);
  fresh.report_sent_at = new Date().toISOString();
  await writeRequest(fresh);

  // Auto-complete. May legitimately fail (already completed / moved) — the
  // send itself succeeded, so the failure is ignored.
  await applyTransition(requestId, "completed");

  return redirect(`${backHref}?sent=1`);
};
