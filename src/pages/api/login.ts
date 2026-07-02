import type { APIRoute } from "astro";
import { adminCookieValue, authCookieHeader, checkAdminPassword } from "../../lib/auth";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const password = String(form.get("password") ?? "").trim();
  let next = String(form.get("next") ?? "/");
  // Same-origin relative paths only — never an open redirect. Reject "//host"
  // AND "/\host": browsers normalize the backslash to "/", so "/\evil.com"
  // resolves to the scheme-relative "//evil.com". Also drop control chars.
  if (
    !next.startsWith("/") ||
    next.startsWith("//") ||
    next.startsWith("/\\") ||
    /[\\\x00-\x1f]/.test(next)
  ) {
    next = "/";
  }

  const cookie = checkAdminPassword(password) ? adminCookieValue() : undefined;

  if (!cookie) {
    return new Response(null, {
      status: 303,
      headers: { Location: `/login?next=${encodeURIComponent(next)}&error=1` }
    });
  }

  return new Response(null, {
    status: 303,
    headers: { Location: next, "Set-Cookie": authCookieHeader(cookie) }
  });
};
