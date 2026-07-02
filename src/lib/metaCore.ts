// Shared Graph API plumbing for metaAds.ts (Marketing API reads) and
// metaPost.ts (page-post publishing). Conventions carried over from
// SupersonicAnalytics: raw fetch, Bearer token in the Authorization header
// (never in the URL — query strings end up in server logs), short timeouts,
// adapters degrade instead of throwing.

// Graph versions live ~2 years; bump this constant (and re-test) when Meta
// announces the v21.0 sunset. Validated against the live API in the sibling
// app (2026-07).
export const GRAPH_VERSION = "v21.0";
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const GRAPH_TIMEOUT_MS = 8000;

// `.env` values live on import.meta.env under Astro/Vite; process.env only holds
// real runtime env vars. Prefer a runtime override, fall back to the .env value.
export function metaToken(): string | undefined {
  return process.env.META_SYSTEM_USER_TOKEN ?? import.meta.env.META_SYSTEM_USER_TOKEN;
}

export function demoMode(): boolean {
  return (process.env.DEMO_MODE ?? import.meta.env.DEMO_MODE) === "1";
}

export async function fetchJson(url: string, token: string, timeoutMs = GRAPH_TIMEOUT_MS): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `Graph API error ${response.status}`);
  }
  return body;
}

/** POST with url-encoded params (the Graph API's native parameter format). */
export async function postForm(
  url: string,
  token: string,
  params: Record<string, string>,
  timeoutMs = GRAPH_TIMEOUT_MS
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `Graph API error ${response.status}`);
  }
  return body;
}

/** POST multipart form-data (binary photo uploads). Longer timeout: multi-MB bodies. */
export async function postMultipart(
  url: string,
  token: string,
  form: FormData,
  timeoutMs = 30_000
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `Graph API error ${response.status}`);
  }
  return body;
}

// Under the "new Pages experience" a Page access token is required to publish or
// read a Page's content. Mint one from the system-user token; returns undefined
// if the token has no access to the Page (asset not assigned in Business Manager).
export async function getPageAccessToken(pageId: string, userToken: string): Promise<string | undefined> {
  try {
    const body = await fetchJson(`${GRAPH}/${pageId}?fields=access_token`, userToken);
    return typeof body?.access_token === "string" ? body.access_token : undefined;
  } catch {
    return undefined;
  }
}
