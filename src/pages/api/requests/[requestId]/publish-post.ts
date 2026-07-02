import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { readBrokerage, readRequest, writeRequest } from "../../../../lib/storage";
import { findAsset, mimeForExt, readAssetBytes } from "../../../../lib/uploads";
import { publishPagePost, type PublishPhoto } from "../../../../lib/metaPost";

export const prerender = false;

// Push the drafted post live to the brokerage's Facebook Page. Only allowed
// once the post is reviewed and not yet published. A Graph failure bounces
// back to the editor with a warning — the form stays usable and the manual
// permalink fallback is always available there.

function errorPage(status: number, message: string, backHref?: string) {
  const back = backHref
    ? `<p><a href="${backHref}">Back to the post editor</a> — or use your browser's <strong>Back</strong> button.</p>`
    : `<p>Use your browser's <strong>Back</strong> button to return to the form.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Post not published</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size:1.25rem;">Post not published</h1>
<p>${message}</p>
${back}
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

export const POST: APIRoute = async ({ params, request }) => {
  // Defense in depth — middleware gates this too.
  if (!isAdmin(request)) {
    return errorPage(401, "Admin sign-in required.");
  }

  const requestId = params.requestId ?? "";
  let adRequest;
  try {
    adRequest = await readRequest(requestId);
  } catch {
    return errorPage(404, "Request not found.");
  }
  const editor = `/requests/${adRequest.id}/post`;

  if (adRequest.status !== "post_reviewed") {
    return errorPage(
      400,
      "The post can only be pushed live after review (status must be Post Reviewed).",
      editor
    );
  }
  if (adRequest.post_published) {
    return errorPage(400, "This post has already been published.", editor);
  }
  if (!adRequest.post.final_text.trim()) {
    return errorPage(400, "The final post text is empty — write it in the editor first.", editor);
  }
  if (adRequest.post.photo_ids.length === 0) {
    return errorPage(400, "Select at least one photo (and Save Draft) before publishing.", editor);
  }

  // Resolve every selected photo through the manifest, in publish order.
  const photos: PublishPhoto[] = [];
  for (const id of adRequest.post.photo_ids) {
    const entry = findAsset(adRequest, id);
    if (!entry || entry.kind !== "post_photo") {
      return errorPage(400, "A selected photo no longer exists — re-pick photos in the editor.", editor);
    }
    try {
      const bytes = await readAssetBytes(adRequest, entry);
      photos.push({ bytes, mime: mimeForExt(entry.ext), name: entry.original_name || entry.id });
    } catch {
      return errorPage(400, `Could not read photo "${entry.original_name || entry.id}" from disk.`, editor);
    }
  }

  let brokerage;
  try {
    brokerage = await readBrokerage(adRequest.brokerage_slug);
  } catch {
    return errorPage(404, "The brokerage for this request no longer exists.", editor);
  }

  const result = await publishPagePost(brokerage.meta_page_id, adRequest.post.final_text, photos);
  if (!result.ok) {
    return redirect(`${editor}?warning=${encodeURIComponent(result.warning ?? "Publishing failed.")}`);
  }

  // Re-read before writing so a concurrent edit made during the (slow) photo
  // uploads isn't clobbered.
  const fresh = await readRequest(requestId);
  // TOCTOU guard: another overlapping submission may have published while our
  // uploads were in flight. Abort rather than overwrite (and orphan) its post id.
  if (fresh.post_published) {
    return redirect(
      `${editor}?warning=${encodeURIComponent("This post was just published in another tab.")}`
    );
  }
  fresh.post_published = {
    post_id: result.post_id ?? "",
    ...(result.permalink_url ? { permalink_url: result.permalink_url } : {}),
    published_at: new Date().toISOString()
  };
  await writeRequest(fresh);

  return redirect(`${editor}?published=1`);
};
