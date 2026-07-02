import { defineMiddleware } from "astro:middleware";
import { isAdmin } from "./lib/auth";
import { startReminderLoop } from "./lib/reminders";
import { readSnapshot } from "./lib/storage";

// The reminder loop lives in the server process; middleware module scope runs once
// at boot in both `astro dev` and the built standalone entry.
startReminderLoop();

// /login and /api/login must stay reachable. /api/intake authorizes itself by
// resolving the intake token from its body (the middleware cannot read the body
// without consuming it). The intake form + thanks pages are public by token:
// the 32-hex token in the URL *is* the credential.
const OPEN = /^\/(login|api\/login|api\/intake)$/;
const INTAKE_PAGE = /^\/intake\/[a-f0-9]{32}(\/thanks)?\/?$/;

function challenge(url: URL, request: Request): Response {
  const wantsHtml = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) {
    const next = encodeURIComponent(url.pathname + url.search);
    return new Response(null, { status: 303, headers: { Location: `/login?next=${next}` } });
  }
  return new Response("Sign-in required.", { status: 401 });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  if (OPEN.test(pathname) || INTAKE_PAGE.test(pathname)) return next();

  const request = context.request;

  // Report pages/PDFs can carry a per-snapshot share token (?t=...) — used only in
  // the oversized-PDF email fallback so a client can open their own report without
  // a login. The token is minted at snapshot freeze and lives in the snapshot JSON.
  const snapshotMatch = pathname.match(/^\/(?:reports|api\/pdf)\/([a-z0-9-]+)/);
  if (snapshotMatch) {
    const token = context.url.searchParams.get("t");
    if (token && /^[a-f0-9]{32}$/.test(token)) {
      try {
        const snapshot = await readSnapshot(snapshotMatch[1]);
        if (snapshot.share_token === token) return next();
      } catch {
        // Unknown snapshot: fall through to the same challenge as no token, so
        // unauthenticated requests can't probe which snapshot ids exist.
      }
    }
  }

  // Everything else is team-only.
  if (isAdmin(request)) return next();
  return challenge(context.url, request);
});
