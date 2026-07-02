// Shared HTTP/form helpers for API routes. Every form-handling route needs the
// same handful of primitives; keeping one copy makes the reflected-XSS
// discipline (static strings only in errorPage) enforceable in one place.

/** Trimmed string value from multipart/urlencoded form data. */
export function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

/** 303 redirect (POST -> GET) to a location. */
export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

/** JSON response for fetch() callers. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/** http(s) URL check — rejects everything else (mailto:, data:, file:, ...). */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const CAMPAIGN_ID = /^\d{5,25}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a Facebook Campaign ID. Returns an error message, or null when the
 * id is valid (or empty — presence/absence is the caller's concern). Shared by
 * the campaign-save and Record-Ad-Launch routes, which post the same field.
 * `overrideVerb` is "save"/"record" so each route keeps its exact copy.
 */
export function validateCampaignId(campaignId: string, allowAny: boolean, overrideVerb: string): string | null {
  if (!campaignId) return null;
  if (allowAny) {
    return campaignId.length > 100 ? "Campaign ID must be 1–100 characters." : null;
  }
  return CAMPAIGN_ID.test(campaignId)
    ? null
    : `The Facebook Campaign ID should be 5–25 digits. Tick the non-standard ID override to ${overrideVerb} it anyway.`;
}

/**
 * Form-error page. Form POSTs navigate the browser, so a bare text/plain 400 is
 * a dead end — this renders the shared HTML shell and steers to the browser
 * Back button (entries survive there via bfcache). `title` and `bodyHtml` MUST
 * be static strings — never interpolate client input (reflected-XSS).
 */
export function errorPage(status: number, title: string, bodyHtml: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size:1.25rem;">${title}</h1>
${bodyHtml}
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
