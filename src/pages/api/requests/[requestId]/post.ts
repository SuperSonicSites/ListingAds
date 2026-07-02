import type { APIRoute } from "astro";
import { isAdmin } from "../../../../lib/auth";
import { errorPage as sharedErrorPage, field, isHttpUrl, redirect } from "../../../../lib/http";
import { readBrokerage, readRequest, writeRequest } from "../../../../lib/storage";
import { HEADLINE_FLAGS } from "../../../../lib/types";
import { assembleCaption } from "../../../../lib/postFormat";
import { applyTransition } from "../../../../lib/transitions";

export const prerender = false;

// Post editor form handler: save the draft (action=save), save + mark ready
// for review (action=ready — the row-1 transition, guarded by transitions.ts),
// or record a manually published post's URL (action=record_manual).

function errorPage(status: number, message: string, backHref?: string) {
  const back = backHref
    ? `<p><a href="${backHref}">Back to the post editor</a> — or use your browser's <strong>Back</strong> button; your entries are preserved there.</p>`
    : `<p>Use your browser's <strong>Back</strong> button to return to the form — your entries are preserved there.</p>`;
  return sharedErrorPage(status, "Post not saved", `<p>${message}</p>
${back}`);
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

  const form = await request.formData();
  const action = field(form, "action");

  // --- Record a hand-posted permalink (separate small form) -----------------
  if (action === "record_manual") {
    if (adRequest.status !== "post_reviewed" && adRequest.status !== "ad_published") {
      return errorPage(400, "The post must be reviewed before recording a manual publish.", editor);
    }
    if (adRequest.post_published) {
      return errorPage(400, "This post is already recorded as published.", editor);
    }
    const permalink = field(form, "manual_permalink");
    if (!isHttpUrl(permalink)) {
      return errorPage(400, "Paste the full post URL (it must start with http:// or https://).", editor);
    }
    const freshManual = await readRequest(requestId).catch(() => adRequest);
    if (freshManual.post_published) {
      return errorPage(400, "This post is already recorded as published.", editor);
    }
    freshManual.post_published = {
      post_id: "",
      permalink_url: permalink,
      published_at: new Date().toISOString(),
      manual: true
    };
    await writeRequest(freshManual);
    return redirect(`${editor}?published=1`);
  }

  if (action !== "save" && action !== "ready") {
    return errorPage(400, "Unknown action.", editor);
  }

  // --- Save the draft fields -------------------------------------------------
  const headlineFlag = field(form, "headline_flag");
  if (!(HEADLINE_FLAGS as readonly string[]).includes(headlineFlag)) {
    return errorPage(400, "Pick a headline flag from the list.", editor);
  }

  const pricePrefix = field(form, "price_prefix");
  const price = field(form, "price").replace(/^\$/, "");
  const beds = field(form, "beds");
  const baths = field(form, "baths");
  const neighborhood = field(form, "neighborhood");
  const body = field(form, "body");
  const finalText = field(form, "final_text");
  if (pricePrefix.length > 40) return errorPage(400, "Price prefix is too long (max 40 characters).", editor);
  if (price.length > 20) return errorPage(400, "Price is too long (max 20 characters).", editor);
  if (beds.length > 10 || baths.length > 10) {
    return errorPage(400, "Beds/baths values are too long (max 10 characters).", editor);
  }
  if (neighborhood.length > 80) return errorPage(400, "Neighborhood is too long (max 80 characters).", editor);
  if (body.length > 2000) return errorPage(400, "Post body is too long (max 2000 characters).", editor);
  if (finalText.length > 5000) return errorPage(400, "Final post text is too long (max 5000 characters).", editor);

  // Photo picks: ordered, capped at 10, and every id must be a post_photo the
  // request actually owns — a stale/foreign id is rejected, never stored.
  const photoIds = field(form, "photo_ids").split(",").map((id) => id.trim()).filter(Boolean);
  if (photoIds.length > 10) {
    return errorPage(400, "Pick at most 10 photos for the post.", editor);
  }
  for (const id of photoIds) {
    const asset = adRequest.assets.find((entry) => entry.id === id && entry.kind === "post_photo");
    if (!asset) return errorPage(400, "A selected photo no longer exists — reload the editor and re-pick.", editor);
  }

  const dirty = field(form, "dirty") === "1";
  // Re-read immediately before writing so in-flight photo uploads (which append
  // to request.assets via their own read-modify-write) aren't clobbered; apply
  // only the post fields to the fresh copy.
  const fresh = await readRequest(requestId).catch(() => adRequest);
  fresh.post = {
    headline_flag: headlineFlag,
    price_prefix: pricePrefix,
    price,
    beds,
    baths,
    neighborhood,
    body,
    final_text: finalText,
    dirty,
    photo_ids: photoIds
  };

  // Not hand-edited -> the server-side template is the single source of truth.
  if (!dirty) {
    const brokerage = await readBrokerage(fresh.brokerage_slug).catch(() => undefined);
    if (brokerage) {
      fresh.post.final_text = assembleCaption(fresh, brokerage);
    }
  }

  await writeRequest(fresh);

  if (action === "ready") {
    const result = await applyTransition(adRequest.id, "post_created");
    if (!result.ok) return errorPage(400, result.error, editor);
    return redirect(editor); // the new status renders its own banner
  }

  return redirect(`${editor}?saved=1`);
};
