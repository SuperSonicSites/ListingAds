import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { readRequest } from "../../../../lib/storage";
import { findAsset, mimeForExt, readAssetBytes } from "../../../../lib/uploads";

export const prerender = false;

// Serve an uploaded asset's bytes. The asset is resolved through the request's
// manifest only — an unknown id is a 404, never a filesystem guess — and the
// on-disk path is built from validated ids + the server-recorded extension.

function notFound() {
  return new Response("Not found.", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

export const GET: APIRoute = async ({ params, request }) => {
  // Defense in depth — middleware gates this too.
  if (!isAdmin(request)) {
    return new Response("Sign-in required.", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  let adRequest;
  try {
    adRequest = await readRequest(params.requestId ?? "");
  } catch {
    return notFound();
  }

  const entry = findAsset(adRequest, params.assetId ?? "");
  if (!entry) return notFound();

  let bytes;
  try {
    bytes = await readAssetBytes(adRequest, entry);
  } catch {
    return notFound();
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": mimeForExt(entry.ext),
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=3600"
    }
  });
};
