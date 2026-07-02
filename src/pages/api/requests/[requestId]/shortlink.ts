import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { createShortLink } from "../../../../lib/shortio";
import { readRequest, writeRequest } from "../../../../lib/storage";

export const prerender = false;

// Creates the branded short link ON CLICK (never automatically), or records a
// hand-made one pasted into the manual field. A short.io failure (path taken,
// API unreachable) redirects back with ?warning= so the form stays usable —
// only malformed input gets an error page.

const PATH_RE = /^[a-z0-9-]{3,40}$/;

function field(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function errorPage(status: number, message: string, backHref?: string) {
  const back = backHref
    ? `<p><a href="${backHref}">Return to the request</a>, or use your browser's <strong>Back</strong> button — your entries are preserved there.</p>`
    : `<p>Use your browser's <strong>Back</strong> button to return to the form — your entries are preserved there.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Short link not saved</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size:1.25rem;">Short link not saved</h1>
<p>${message}</p>
${back}
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
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

  // Manual fallback: paste an existing short link and record it verbatim.
  const manualUrl = field(form, "manual_url");
  if (manualUrl) {
    if (!isHttpUrl(manualUrl)) {
      return errorPage(400, "The pasted short link must be an http(s) URL.", detailHref);
    }
    const segments = new URL(manualUrl).pathname.split("/").filter(Boolean);
    record.short_link = { url: manualUrl, path: segments[segments.length - 1] ?? "" };
    await writeRequest(record);
    return redirect(`${detailHref}#card-shortlink`);
  }

  const path = field(form, "path");
  const originalUrl = field(form, "original_url");
  if (!PATH_RE.test(path)) {
    return errorPage(
      400,
      "The short link path must be 3–40 characters using lowercase letters, numbers, and hyphens (e.g. mls17354).",
      detailHref
    );
  }
  if (!isHttpUrl(originalUrl)) {
    return errorPage(400, "The destination URL must start with http:// or https://.", detailHref);
  }

  const result = await createShortLink(path, originalUrl, record.listing_address);
  if (!result.ok || !result.short_url) {
    const warning = result.warning ?? "short.io did not return a link. Try again or paste an existing one.";
    return redirect(`${detailHref}?warning=${encodeURIComponent(warning)}#card-shortlink`);
  }

  record.short_link = {
    url: result.short_url,
    path: result.path ?? path,
    ...(result.link_id ? { link_id: result.link_id } : {})
  };
  await writeRequest(record);

  return redirect(`${detailHref}#card-shortlink`);
};
