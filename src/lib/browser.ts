import { existsSync } from "node:fs";

// Shared Chrome/Edge/Chromium detection — used by the PDF route and the
// ad-preview screenshot capture. `.env` values land on import.meta.env under
// Astro/Vite; process.env only holds real runtime env vars (the built server
// never loads .env). Check both.
const chromeCandidates = [
  process.env.CHROME_PATH,
  import.meta.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean) as string[];

export function browserPath(): string | undefined {
  return chromeCandidates.find((candidate) => existsSync(candidate));
}

// --disable-dev-shm-usage: container /dev/shm is often 64MB and Chrome crashes
// mid-render without it.
export const BROWSER_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
