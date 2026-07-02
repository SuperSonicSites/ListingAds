import { Buffer } from "node:buffer";
import puppeteer from "puppeteer-core";
import type { ExecReportSnapshot } from "./types";
import { slugify } from "./storage";
import { BROWSER_ARGS, browserPath } from "./browser";

// Shared Executive Report PDF renderer — used by the download route and by
// send-report (which attaches the PDF to the delivery email). Renders the
// frozen report page over loopback (never the request's own origin: the Host
// header is client-controlled, and behind a TLS proxy the public origin can
// serve an access gate instead of the report). Throws on failure — callers
// map that to a 500 or a redirect warning.

export function reportPdfFilename(snapshot: ExecReportSnapshot, fallbackId = ""): string {
  const addressSlug = slugify(snapshot.listing.address) || fallbackId || snapshot.request_id;
  // A snapshot frozen without a due date must not produce a trailing-hyphen
  // "...-.pdf"; fall back to the freeze date.
  const dateSuffix = snapshot.campaign.report_due_date || snapshot.created_at.slice(0, 10);
  return `executive-report-${addressSlug}-${dateSuffix}.pdf`;
}

export async function renderReportPdf(
  snapshotId: string,
  cookie: string | null,
  shareToken?: string
): Promise<Buffer> {
  const executablePath = browserPath();
  if (!executablePath) {
    throw new Error("PDF generation needs Chrome, Edge, or CHROME_PATH set.");
  }

  const port = process.env.PORT ?? "4322";
  // When the caller reached us via a snapshot share token (?t=), forward the same
  // token on the loopback URL so the print page passes the middleware without a
  // cookie. Otherwise the admin cookie is forwarded below.
  const tokenParam = shareToken ? `&t=${encodeURIComponent(shareToken)}` : "";
  const reportUrl = `http://127.0.0.1:${port}/reports/${snapshotId}?print=1${tokenParam}`;

  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: BROWSER_ARGS });
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1600, deviceScaleFactor: 1 });
    if (cookie) await page.setExtraHTTPHeaders({ cookie });
    await page.goto(reportUrl, { waitUntil: "networkidle0", timeout: 30_000 });
    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" }
    });
    return Buffer.from(pdf);
  } finally {
    await browser?.close();
  }
}
