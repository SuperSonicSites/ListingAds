import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdRequest, Brokerage, ExecReportSnapshot } from "./types";

const dataDir = path.join(process.cwd(), "data");
const brokeragesDir = path.join(dataDir, "brokerages");
const requestsDir = path.join(dataDir, "requests");
const snapshotsDir = path.join(dataDir, "snapshots");
const uploadsRoot = path.join(dataDir, "uploads");
const safeId = /^[a-z0-9-]+$/;

// Everything under data/ is created at runtime (brokerages, requests, uploads,
// snapshots) and is NOT in git — on a hosted container it survives deploys ONLY if a
// persistent volume is mounted at data/. A mounted volume lives on a different device
// than the app dir, so equal st_dev in a hosted environment means every deploy wipes
// the board. Shout at boot rather than letting the loss be discovered after the fact.
if (process.env.RAILWAY_ENVIRONMENT ?? process.env.KUBERNETES_SERVICE_HOST) {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (statSync(process.cwd()).dev === statSync(dataDir).dev) {
      console.warn(
        "[storage] WARNING: data/ is on the container filesystem, NOT a mounted volume. " +
          "Brokerages, requests, and reports WILL BE LOST on every deploy. Mount a volume at /app/data."
      );
    } else {
      console.log("[storage] data/ is on a mounted volume — records persist across deploys.");
    }
  } catch (error) {
    console.warn("[storage] Could not verify the data volume:", error);
  }
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function assertSafeId(value: string, label: string) {
  if (!safeId.test(value)) {
    throw new Error(`Invalid ${label}. Use lowercase letters, numbers, and hyphens only.`);
  }
}

async function readJson<T>(file: string) {
  const text = await readFile(file, "utf-8");
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
  } catch (error) {
    console.error(`Corrupt JSON in ${file}:`, error);
    throw error;
  }
}

// Write to a temp file then rename so a concurrent reader never sees a truncated file.
async function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(tmp, file);
}

export function createRequestId() {
  return `req-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function createSnapshotId() {
  return `rpt-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function createAssetId() {
  return `ast-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

// 32 lowercase hex (128 bits) — intake links and report share links.
export function createSecretToken() {
  return randomUUID().replace(/-/g, "");
}

// --- Brokerages -------------------------------------------------------------

export async function listBrokerages() {
  await mkdir(brokeragesDir, { recursive: true });
  const files = await readdir(brokeragesDir);
  // One corrupt or misnamed file must not take down the list.
  const brokerages = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          return await readBrokerage(file.replace(/\.json$/, ""));
        } catch {
          return null;
        }
      })
  );

  return brokerages
    .filter((brokerage): brokerage is Brokerage => brokerage !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function brokerageExists(slug: string) {
  assertSafeId(slug, "brokerage slug");
  try {
    await access(path.join(brokeragesDir, `${slug}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function readBrokerage(slug: string) {
  assertSafeId(slug, "brokerage slug");
  return readJson<Brokerage>(path.join(brokeragesDir, `${slug}.json`));
}

export async function writeBrokerage(brokerage: Brokerage) {
  assertSafeId(brokerage.slug, "brokerage slug");
  await mkdir(brokeragesDir, { recursive: true });
  await writeJsonAtomic(path.join(brokeragesDir, `${brokerage.slug}.json`), brokerage);
}

export async function deleteBrokerage(slug: string) {
  assertSafeId(slug, "brokerage slug");
  // Requests and snapshots stay on disk: history remains viewable by the team.
  await unlink(path.join(brokeragesDir, `${slug}.json`));
}

// The intake link carries only this token; constant token shape is validated by the
// caller (middleware/API) before lookup. O(n) over a few dozen brokerages is correct
// here — no index file to keep in sync.
export async function findBrokerageByToken(token: string): Promise<Brokerage | undefined> {
  if (!/^[a-f0-9]{32}$/.test(token)) return undefined;
  const brokerages = await listBrokerages();
  return brokerages.find((brokerage) => brokerage.intake_token === token);
}

// --- Ad requests --------------------------------------------------------------

export async function listRequests() {
  await mkdir(requestsDir, { recursive: true });
  const files = await readdir(requestsDir);
  const requests = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          return await readRequest(file.replace(/\.json$/, ""));
        } catch {
          return null;
        }
      })
  );

  return requests
    .filter((request): request is AdRequest => request !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function readRequest(requestId: string) {
  assertSafeId(requestId, "request id");
  return readJson<AdRequest>(path.join(requestsDir, `${requestId}.json`));
}

export async function writeRequest(request: AdRequest) {
  assertSafeId(request.id, "request id");
  await mkdir(requestsDir, { recursive: true });
  await writeJsonAtomic(path.join(requestsDir, `${request.id}.json`), request);
}

// --- Report snapshots ----------------------------------------------------------

export async function readSnapshot(snapshotId: string) {
  assertSafeId(snapshotId, "snapshot id");
  return readJson<ExecReportSnapshot>(path.join(snapshotsDir, `${snapshotId}.json`));
}

export async function writeSnapshot(snapshotId: string, snapshot: ExecReportSnapshot) {
  assertSafeId(snapshotId, "snapshot id");
  await mkdir(snapshotsDir, { recursive: true });
  await writeJsonAtomic(path.join(snapshotsDir, `${snapshotId}.json`), snapshot);
}

// --- Uploads (binary asset files) ------------------------------------------------

// Path components come only from validated ids + the server-side extension map
// (see uploads.ts), so traversal is impossible by construction.
export function uploadsDir(requestId: string) {
  assertSafeId(requestId, "request id");
  return path.join(uploadsRoot, requestId);
}

export function assetPath(requestId: string, assetId: string, ext: string) {
  assertSafeId(requestId, "request id");
  assertSafeId(assetId, "asset id");
  if (!/^(jpg|png|webp)$/.test(ext)) {
    throw new Error("Invalid asset extension.");
  }
  return path.join(uploadsRoot, requestId, `${assetId}.${ext}`);
}
