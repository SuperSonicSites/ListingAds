import { Buffer } from "node:buffer";
import { GRAPH, demoMode, fetchJson, getPageAccessToken, metaToken, postForm, postMultipart } from "./metaCore";

// Multi-photo Facebook Page post publishing. There is no reliable API-created
// "draft" for Page posts — the draft lives in our request JSON, and Meta is
// touched only here, at push-to-live. Requires the system-user token to carry
// pages_manage_posts + pages_read_engagement and the Page to be assigned with
// "Create content" permission in Business Manager.

export type PublishPostResult = {
  source: "meta_api" | "mock";
  ok: boolean;
  post_id?: string;
  permalink_url?: string;
  warning?: string;
};

export type PublishPhoto = { bytes: Buffer; mime: string; name: string };

export async function publishPagePost(
  pageId: string | undefined,
  message: string,
  photos: PublishPhoto[]
): Promise<PublishPostResult> {
  const token = metaToken();
  if (!token) {
    if (demoMode()) {
      const fakeId = `${pageId ?? "0"}_${Date.now()}`;
      return {
        source: "mock",
        ok: true,
        post_id: fakeId,
        permalink_url: `https://www.facebook.com/demo/posts/${Date.now()}`
      };
    }
    return { source: "meta_api", ok: false, warning: "Meta token is not configured." };
  }
  if (!pageId) {
    return {
      source: "meta_api",
      ok: false,
      warning: "This brokerage has no Facebook Page ID. Add it on the brokerage profile first."
    };
  }
  if (photos.length === 0) {
    return { source: "meta_api", ok: false, warning: "Select at least one photo for the post." };
  }

  const pageToken = await getPageAccessToken(pageId, token);
  if (!pageToken) {
    return {
      source: "meta_api",
      ok: false,
      warning:
        "The Meta token cannot access this Page. Check the Business Manager asset assignment (Create content permission)."
    };
  }

  // Upload every photo unpublished first; abort before /feed on any failure so a
  // partial album is never published. Unpublished photos are invisible on the
  // Page and need no cleanup.
  const mediaIds: string[] = [];
  for (const [index, photo] of photos.entries()) {
    try {
      const form = new FormData();
      form.append("source", new Blob([new Uint8Array(photo.bytes)], { type: photo.mime }), photo.name);
      form.append("published", "false");
      const body = await postMultipart(`${GRAPH}/${pageId}/photos`, pageToken, form);
      const id = typeof body?.id === "string" ? body.id : undefined;
      if (!id) throw new Error("No photo id returned.");
      mediaIds.push(id);
    } catch (error) {
      console.warn(`[metaPost] photo upload ${index + 1}/${photos.length} failed:`, error);
      return {
        source: "meta_api",
        ok: false,
        warning: `Photo ${index + 1} of ${photos.length} ("${photo.name}") failed to upload — nothing was published. Try again.`
      };
    }
  }

  try {
    const body = await postForm(`${GRAPH}/${pageId}/feed`, pageToken, {
      message,
      attached_media: JSON.stringify(mediaIds.map((id) => ({ media_fbid: id })))
    });
    const postId = typeof body?.id === "string" ? body.id : undefined;
    if (!postId) throw new Error("No post id returned.");

    let permalink: string | undefined;
    try {
      const details = await fetchJson(`${GRAPH}/${postId}?fields=permalink_url`, pageToken);
      permalink = typeof details?.permalink_url === "string" ? details.permalink_url : undefined;
    } catch {
      // Permalink is nice-to-have; the publish already succeeded.
    }

    return { source: "meta_api", ok: true, post_id: postId, permalink_url: permalink };
  } catch (error) {
    console.warn("[metaPost] /feed publish failed:", error);
    return {
      source: "meta_api",
      ok: false,
      warning: `Publishing failed: ${error instanceof Error ? error.message : "Graph API error"}. The photos were uploaded unpublished and are harmless — fix the issue and try again.`
    };
  }
}
