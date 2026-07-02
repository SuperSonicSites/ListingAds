import type { APIRoute } from "astro";
import { isAdmin } from "../../../lib/auth";
import { readSnapshot } from "../../../lib/storage";
import { renderReportPdf, reportPdfFilename } from "../../../lib/pdf";

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  const snapshotId = params.snapshotId ?? "";

  let snapshot;
  try {
    snapshot = await readSnapshot(snapshotId);
  } catch {
    return new Response("Snapshot not found.", { status: 404 });
  }

  // Middleware already gates this route, but double-check here (defense in
  // depth): either the admin cookie or the snapshot's own share token.
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const shareOk = /^[a-f0-9]{32}$/.test(token) && token === snapshot.share_token;
  if (!shareOk && !isAdmin(request)) {
    return new Response("Sign-in required.", { status: 401 });
  }

  try {
    // Share-token callers have no cookie — forward the token to the loopback
    // print page instead so it passes the middleware too.
    const pdf = await renderReportPdf(
      snapshotId,
      request.headers.get("cookie"),
      shareOk ? token : undefined
    );
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${reportPdfFilename(snapshot, snapshotId)}"`
      }
    });
  } catch (error) {
    console.error(`PDF generation failed for ${snapshotId}:`, error);
    return new Response("PDF generation failed. Check the server logs and try again.", { status: 500 });
  }
};
