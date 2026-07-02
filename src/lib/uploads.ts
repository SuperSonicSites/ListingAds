import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { AdRequest, AssetEntry, AssetKind } from "./types";
import { SINGLE_SLOT_KINDS } from "./types";
import { assetPath, createAssetId, readRequest, uploadsDir, writeRequest } from "./storage";

// Size caps: Meta's documented safe JPEG limit for /photos uploads is 4MB; the
// snapshot embed ceiling (report kinds) is 6MB. The upload UI downscales
// client-side (canvas, ≤2000px, JPEG q0.85) so these are rarely hit.
export const POST_PHOTO_MAX_BYTES = 4_000_000;
export const REPORT_IMAGE_MAX_BYTES = 6_000_000;

export function maxBytesFor(kind: AssetKind): number {
  return kind === "post_photo" ? POST_PHOTO_MAX_BYTES : REPORT_IMAGE_MAX_BYTES;
}

type DetectedImage = { ext: AssetEntry["ext"]; mime: string };

// Magic-byte sniffing — the client-declared mimetype and filename are never
// trusted; the on-disk extension comes only from this map.
export function detectImage(bytes: Buffer): DetectedImage | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { ext: "png", mime: "image/png" };
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return undefined;
}

export function mimeForExt(ext: AssetEntry["ext"]): string {
  return ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : "image/webp";
}

/**
 * Persist an uploaded image and record it in the request's asset manifest.
 * Single-slot kinds (hero, previews, realtor 7/30/90) replace the previous
 * file + entry. The request record is re-read before writing so a concurrent
 * edit elsewhere isn't clobbered. Throws with a user-facing message on
 * validation failure — the API route turns that into a 400/413.
 */
export async function saveUpload(
  requestId: string,
  kind: AssetKind,
  bytes: Buffer,
  originalName: string
): Promise<AssetEntry> {
  const detected = detectImage(bytes);
  if (!detected) {
    throw new Error("Only JPEG, PNG, or WebP images are accepted.");
  }
  if (bytes.byteLength > maxBytesFor(kind)) {
    const cap = Math.round(maxBytesFor(kind) / 1_000_000);
    throw new Error(`Image is too large — keep ${kind.replaceAll("_", " ")} files under ${cap} MB.`);
  }

  const entry: AssetEntry = {
    id: createAssetId(),
    kind,
    ext: detected.ext,
    original_name: originalName.slice(0, 120),
    bytes: bytes.byteLength,
    uploaded_at: new Date().toISOString()
  };

  const dir = uploadsDir(requestId);
  await mkdir(dir, { recursive: true });
  const file = assetPath(requestId, entry.id, entry.ext);
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);

  const request = await readRequest(requestId);
  const replaced = SINGLE_SLOT_KINDS.includes(kind)
    ? request.assets.filter((asset) => asset.kind === kind)
    : [];
  request.assets = [...request.assets.filter((asset) => !replaced.includes(asset)), entry];
  await writeRequest(request);

  for (const old of replaced) {
    await unlink(assetPath(requestId, old.id, old.ext)).catch(() => {});
  }

  return entry;
}

export async function deleteAsset(requestId: string, assetId: string): Promise<void> {
  const request = await readRequest(requestId);
  const entry = request.assets.find((asset) => asset.id === assetId);
  if (!entry) return;
  request.assets = request.assets.filter((asset) => asset.id !== assetId);
  request.post.photo_ids = request.post.photo_ids.filter((id) => id !== assetId);
  await writeRequest(request);
  await unlink(assetPath(requestId, entry.id, entry.ext)).catch(() => {});
}

/** Resolve an asset through the manifest (unknown id -> undefined, never a path guess). */
export function findAsset(request: AdRequest, assetId: string): AssetEntry | undefined {
  return request.assets.find((asset) => asset.id === assetId);
}

export async function readAssetBytes(request: AdRequest, entry: AssetEntry): Promise<Buffer> {
  return readFile(assetPath(request.id, entry.id, entry.ext));
}

/**
 * Freeze an asset as a base64 data URI (snapshot invariant: reports render only
 * from embedded bytes, never from files that may later change). Returns "" on
 * any failure so the report renders without the image, never with a broken one.
 */
export async function embedAsset(request: AdRequest, assetId: string | undefined): Promise<string> {
  if (!assetId) return "";
  const entry = findAsset(request, assetId);
  if (!entry) return "";
  try {
    const bytes = await readAssetBytes(request, entry);
    if (bytes.byteLength === 0 || bytes.byteLength > REPORT_IMAGE_MAX_BYTES) return "";
    return `data:${mimeForExt(entry.ext)};base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
}
