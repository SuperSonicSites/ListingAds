import type { AdRequest, Brokerage } from "./types";
import { appBaseUrl, reviewEmail, teamEmail, teamName, type EmailPayload } from "./email";
import { vancouverWeekday } from "./dates";

// The six workflow emails. Copy is verbatim from the owner's spec; the few
// sentences the spec elided are filled in and safe to tweak here. All
// variables are HTML-escaped; bodies are simple inline-styled single-column
// HTML so they render everywhere.

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shell(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px 16px;background:#f5f7fa;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e9f0;border-radius:12px;padding:28px;font-family:Inter,-apple-system,'Segoe UI',sans-serif;color:#182230;font-size:15px;line-height:1.65;">
      ${bodyHtml}
    </div>
    <p style="max-width:560px;margin:14px auto 0;color:#94a3b8;font-family:Inter,-apple-system,'Segoe UI',sans-serif;font-size:12px;text-align:center;">Supersonic Sites</p>
  </body>
</html>`;
}

function p(html: string): string {
  return `<p style="margin:0 0 16px;">${html}</p>`;
}

function crmLink(requestId: string, label: string): string {
  return `<a href="${appBaseUrl()}/requests/${requestId}" style="color:#0f8ac4;font-weight:600;">${escapeHtml(label)}</a>`;
}

/** #1 — to the client point person, on intake submission. */
export function intakeConfirmation(request: AdRequest, brokerage: Brokerage): EmailPayload {
  const address = escapeHtml(request.listing_address);
  const client = escapeHtml(brokerage.contact_name || brokerage.name);
  return {
    to: brokerage.contact_email,
    subject: `Request received — ${request.listing_address} ad campaign 🚀`,
    html: shell(
      p(`Hi ${client},`) +
        p(
          `Thanks for submitting your ad campaign details for launch ${address}. The rocket engineers are all systems go, if you have any questions just hit reply.`
        ) +
        p(`3,2,1... BOOM 🚀`) +
        p(`<strong>Extra Info: Here's what happens next:</strong>`) +
        p(
          `<strong>1. Expert Setup:</strong> Our team is already reviewing your submission and crafting high-impact ad creatives tailored to your listing, brand and market.`
        ) +
        p(
          `<strong>2. Launch Confirmation:</strong> You'll receive an email once your ad passes our internal review and goes live, ensuring no oversights and keeping you in the loop.`
        ) +
        p(
          `<strong>3. Executive Report:</strong> Approximately two weeks after launch, you'll get an Executive Report for the campaign, ready to forward to your seller — so you look like the pro they hired.`
        ) +
        p(`Got questions? Just reply to this email — we're here to help`)
    )
  };
}

/** #2 — to the reviewer (Brent), when the post is marked ready for review. */
export function reviewRequest(request: AdRequest): EmailPayload {
  const address = escapeHtml(request.listing_address);
  return {
    to: reviewEmail(),
    subject: `Ready for review — ${request.listing_address} listing post`,
    html: shell(
      p(`Hi Brent,`) +
        p(`This listing post for ${address} is now ready for your review.`) +
        p(`Please take a look when you have a moment and let me know if any adjustments are needed before we move forward.`) +
        p(crmLink(request.id, "Click Here to Access CRM Record")) +
        p(`Supersonic CRM`)
    )
  };
}

/** #3 — to the client point person, when the ad is published. */
export function launchConfirmation(request: AdRequest, brokerage: Brokerage): EmailPayload {
  const address = escapeHtml(request.listing_address);
  const client = escapeHtml(brokerage.contact_name || brokerage.name);
  return {
    to: brokerage.contact_email,
    subject: `Your ad campaign for ${request.listing_address} is live! 🚀`,
    html: shell(
      p(`Hi ${client},`) +
        p(`Your ad campaign for ${address} is officially launched! 3,2,1... BOOM 🚀`) +
        p(`Got questions? Just reply to this email — we're here for you.`) +
        p(`<strong>Extra Info: Here's what's happening now:</strong>`) +
        p(
          `<strong>1. Your Ad Is Getting Up &amp; Running:</strong> It's being pushed live across the Meta platform and targeting the right audience(s).`
        ) +
        p(
          `<strong>2. We're Monitoring Performance:</strong> Our team is keeping a close eye to ensure everything runs smoothly, and handling any Meta Ad platform items that may arise.`
        ) +
        p(
          `<strong>3. Your Report Is Coming Soon:</strong> In approximately two weeks, we'll email an Executive Report that is client-ready straight to your inbox. Reports go out Monday to Friday during regular business hours of 9-5pm PST.`
        )
    )
  };
}

/** #4 — to the team inbox, when the Executive Report snapshot is generated. */
export function reportReadyInternal(request: AdRequest): EmailPayload {
  const address = escapeHtml(request.listing_address);
  return {
    to: teamEmail() ?? reviewEmail(),
    subject: `Report ready to send — ${request.listing_address}`,
    html: shell(
      p(`Hi ${escapeHtml(teamName())},`) +
        p(
          `Just a quick note to let you know that the report for ${address} is ready and can be sent out at your convenience.`
        ) +
        p(crmLink(request.id, `See ${request.listing_address}`)) +
        p(`Supersonic CRM`)
    )
  };
}

/**
 * #5 — to the client point person, delivering the Executive Report. The PDF is
 * attached by the caller when it fits; otherwise `shareUrl` renders a download
 * button (public tokenized report link).
 */
export function reportDelivery(
  request: AdRequest,
  brokerage: Brokerage,
  options: { to?: string; shareUrl?: string } = {}
): EmailPayload {
  const address = escapeHtml(request.listing_address);
  const client = escapeHtml(brokerage.contact_name || brokerage.name);
  const day = vancouverWeekday();
  let body =
    p(`Hello ${client},`) +
    p(
      `Happy ${day}! Please find attached the final Executive Report for ${address} that you can share with everyone.`
    );
  if (options.shareUrl) {
    body =
      p(`Hello ${client},`) +
      p(
        `Happy ${day}! Your final Executive Report for ${address} is ready — use the button below to download it, and feel free to share it with everyone.`
      ) +
      p(
        `<a href="${options.shareUrl}" style="display:inline-block;background:#0d1522;color:#ffffff;border-radius:10px;padding:12px 22px;font-weight:600;text-decoration:none;">Download the Executive Report</a>`
      );
  }
  return {
    to: options.to ?? brokerage.contact_email,
    subject: `Executive Report — ${request.listing_address}`,
    html: shell(body)
  };
}

/** #6 — to the team inbox, daily while a report is due and unsent. */
export function reportDueReminder(request: AdRequest, brokerage: Brokerage): EmailPayload {
  const address = escapeHtml(request.listing_address);
  return {
    to: teamEmail() ?? reviewEmail(),
    // Exact reminder string from the spec.
    subject: `${request.listing_address} - Send Executive Report for - ${brokerage.name}`,
    html: shell(
      p(`The campaign for ${address} has reached its report due date.`) +
        p(`Open the report builder, generate the Executive Report, and send it to the client.`) +
        p(crmLink(request.id, `See ${request.listing_address}`)) +
        p(`Supersonic CRM`)
    )
  };
}
