import { createHash } from "node:crypto";

/**
 * Password gate — admin-only in this app. One password from ADMIN_PASSWORD (env)
 * unlocks the whole tool. Clients never sign in: they only ever see their
 * tokenized intake link and the emails we send them.
 *
 * The cookie carries a derived token (never the password), so changing the
 * password invalidates outstanding cookies with no session state on disk.
 * Cookie name differs from SupersonicAnalytics ("srg_auth") on purpose:
 * cookies don't isolate by port, and both apps run on 127.0.0.1 in dev.
 */
export const AUTH_COOKIE = "sar_auth";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function adminPassword(): string | undefined {
  // Trim: platform variable UIs love to smuggle in trailing whitespace/newlines.
  const value = (process.env.ADMIN_PASSWORD ?? import.meta.env.ADMIN_PASSWORD)?.trim();
  return value || undefined;
}

// One log line at boot so "is the variable actually set on this deployment?"
// is answerable from the host logs without guessing. Never logs the value.
console.log(`[auth] ADMIN_PASSWORD is ${adminPassword() ? "set" : "NOT set — admin sign-in will always fail"}`);

export function adminCookieValue(): string | undefined {
  const password = adminPassword();
  return password ? `admin:${sha256(`admin:${password}`)}` : undefined;
}

export function checkAdminPassword(password: string): boolean {
  const expected = adminPassword();
  return Boolean(expected && password === expected);
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === AUTH_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function isAdmin(request: Request): boolean {
  const value = cookieValue(request);
  const expected = adminCookieValue();
  return Boolean(value && expected && value === expected);
}

export function authCookieHeader(value: string) {
  return `${AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${THIRTY_DAYS}`;
}
