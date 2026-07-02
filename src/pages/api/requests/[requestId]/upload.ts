import { Buffer } from "node:buffer";
import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { readRequest } from "../../../../lib/storage";
import { saveUpload } from "../../../../lib/uploads";
import type { AssetEntry, AssetKind } from "../../../../lib/types";
import { ASSET_KINDS } from "../../../../lib/types";

export const prerender = false;

// Multipart image upload for a request: `kind` + one or more `file` entries.
// Two response modes: plain-form callers pass a `redirect` field (path-only)
// and get a 303 back (with ?warning= on failure); fetch() callers get JSON
// { ok, assets, error? }. saveUpload() does the real validation (magic bytes,
// size caps) and throws user-facing messages.

function json(status: number, body: { ok: boolean; assets: AssetEntry[]; error?: string }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// Only ever bounce back to a same-origin path — never an absolute URL.
function safeRedirectPath(value: string): string | undefined {
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return undefined;
}

function redirectWith(path: string, warning?: string) {
  const location = warning
    ? `${path}${path.includes("?") ? "&" : "?"}warning=${encodeURIComponent(warning)}`
    : path;
  return new Response(null, { status: 303, headers: { Location: location } });
}

export const POST: APIRoute = async ({ params, request }) => {
  // Defense in depth — middleware gates this too.
  if (!isAdmin(request)) {
    return json(401, { ok: false, assets: [], error: "Admin sign-in required." });
  }

  const requestId = params.requestId ?? "";
  try {
    await readRequest(requestId);
  } catch {
    return json(404, { ok: false, assets: [], error: "Request not found." });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { ok: false, assets: [], error: "Expected a multipart form upload." });
  }

  const redirect = safeRedirectPath(String(form.get("redirect") ?? ""));
  const fail = (status: number, message: string, saved: AssetEntry[]) =>
    redirect ? redirectWith(redirect, message) : json(status, { ok: false, assets: saved, error: message });

  const kind = String(form.get("kind") ?? "") as AssetKind;
  if (!ASSET_KINDS.includes(kind)) {
    return fail(400, "Unknown upload kind.", []);
  }

  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length === 0) {
    return fail(400, "Choose at least one image to upload.", []);
  }

  const saved: AssetEntry[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await file.arrayBuffer());
    } catch {
      return fail(400, `Could not read "${file.name || "upload"}".`, saved);
    }
    try {
      saved.push(await saveUpload(requestId, kind, bytes, file.name || "upload"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      const status = /too large/i.test(message) ? 413 : 400;
      return fail(status, message, saved);
    }
  }

  return redirect ? redirectWith(redirect) : json(200, { ok: true, assets: saved });
};
