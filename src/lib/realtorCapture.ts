import { Buffer } from "node:buffer";
import puppeteer from "puppeteer-core";
import type { AssetKind } from "./types";
import { isHttpUrl } from "./http";
import { BROWSER_ARGS, browserPath } from "./browser";
import { saveUpload } from "./uploads";

// Automated REALTOR.ca listing-stats capture. The client's intake stores a
// member.realtor.ca share URL whose page has three tabbed stat panes
// (7 / 30 / 90 days). This module screenshots each pane and stores it as the
// matching single-slot request asset (realtor_7/30/90). Modelled on
// captureAdPreviews in metaAds.ts: same puppeteer-core + browser.ts helpers +
// uploads.ts, and the same never-throws adapter contract — any failure degrades
// to ok:false + a human warning so the manual upload fallback stays the answer.

export type RealtorCaptureResult = {
  ok: boolean;
  captured: string[]; // which of realtor_7 / realtor_30 / realtor_90 were saved
  warnings: string[];
};

export type RealtorPhotosResult = {
  ok: boolean;
  saved: number;
  warnings: string[];
};

// A modern desktop Chrome UA. The headless UA contains "HeadlessChrome", which
// bot protection flags — override it so the automated session reads as a normal
// desktop browser.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PANES: { days: 7 | 30 | 90; pane: string; kind: AssetKind }[] = [
  { days: 7, pane: "myTabContent-days7", kind: "realtor_7" },
  { days: 30, pane: "myTabContent-days30", kind: "realtor_30" },
  { days: 90, pane: "myTabContent-days90", kind: "realtor_90" }
];

// Best-effort cookie-consent dismissal. The banner markup is unknown, so match a
// BUTTON (not a link — links here point at policy pages and would navigate away)
// whose whole visible text reads like an accept action. Matching is exact/prefix
// only: a loose substring match risks clicking "Cookie Policy" and navigating
// off the stats page. Never throws — no banner simply matches nothing.
async function dismissConsent(page: import("puppeteer-core").Page): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      // REALTOR.ca's own disclaimer banner uses this exact button. Try it first.
      const known = document.getElementById("btn_publicDisclaimerDismiss");
      if (known) {
        known.click();
        return true;
      }
      // Generic fallback for a markup change: a button whose whole text reads
      // like a dismiss/accept action. Exact/prefix only — a loose substring
      // match risks clicking "Cookie Policy" and navigating off the page.
      const phrases = [
        "dismiss",
        "accept all",
        "accept cookies",
        "accept",
        "i accept",
        "agree",
        "i agree",
        "got it",
        "i understand",
        "allow all",
        "allow cookies"
      ];
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>("button, [role='button'], input[type='button'], input[type='submit']")
      );
      for (const el of buttons) {
        const text = (el.textContent || (el as HTMLInputElement).value || "").trim().toLowerCase();
        if (text && text.length <= 40 && phrases.some((p) => text === p || text.startsWith(p))) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      // Let the banner + scrim animate out before capturing.
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } catch {
    /* no banner / unexpected markup — capture with it, better than nothing */
  }
}

/**
 * Capture the 7 / 30 / 90-day graph panes from a REALTOR.ca listing-stats share
 * URL and store each as its single-slot request asset (auto-replacing any prior
 * upload). Partial captures are valuable, so a pane that fails adds a specific
 * warning and the loop continues to the next pane.
 */
export async function captureRealtorStats(
  requestId: string,
  statsUrl: string
): Promise<RealtorCaptureResult> {
  const warnings: string[] = [];
  const captured: string[] = [];

  if (!isHttpUrl(statsUrl)) {
    return { ok: false, captured, warnings: ["The REALTOR.ca stats link is not a valid http(s) URL."] };
  }

  const executablePath = browserPath();
  if (!executablePath) {
    return {
      ok: false,
      captured,
      warnings: ["REALTOR.ca capture needs Chrome, Edge, or CHROME_PATH set. Upload the screenshots manually."]
    };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      // --disable-blink-features=AutomationControlled hides the navigator.webdriver
      // signal bot walls key on, on top of the shared container args.
      args: [...BROWSER_ARGS, "--disable-blink-features=AutomationControlled"]
    });
    const page = await browser.newPage();
    await page.setUserAgent(DESKTOP_UA);
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
    console.log(`[realtorCapture] ${requestId}: opening ${statsUrl}`);
    await page.goto(statsUrl, { waitUntil: "networkidle2", timeout: 30_000 });
    console.log(`[realtorCapture] ${requestId}: loaded ${page.url()} ("${(await page.title()).slice(0, 80)}")`);

    // Dismiss the cookie-consent banner — it dims the whole page with a scrim and
    // overlaps the bottom of each pane, which would spoil the client-facing
    // screenshots. Best-effort: click the first "accept"-style button if present.
    await dismissConsent(page);

    // Fail fast with a precise message when this clearly isn't the stats page
    // (e.g. the client pasted realtor.ca's homepage or a listing URL). Otherwise
    // the three per-pane timeouts stack into ~30s of silence ending in generic
    // warnings.
    try {
      await page.waitForSelector(`#${PANES[0].pane}`, { timeout: 12_000 });
    } catch {
      const where = page.url();
      console.warn(`[realtorCapture] ${requestId}: no stats tabs found at ${where}`);
      return {
        ok: false,
        captured,
        warnings: [
          `That page (${new URL(where).hostname}) doesn't show the listing-stats tabs. ` +
            `Make sure the request's REALTOR.ca link is the "share listing stats" link from the ` +
            `REALTOR.ca email (it starts with member.realtor.ca/Reports/). Upload the screenshots manually otherwise.`
        ]
      };
    }

    for (const { days, pane, kind } of PANES) {
      try {
        // 30/90 are hidden behind their tab — click it first. 7 is the default
        // visible pane. Tab markup is unknown, so resolve the clickable tab
        // robustly by any attribute that references the pane id, with an
        // id-pattern fallback.
        if (days !== 7) {
          const clicked = await page.evaluate((paneId: string) => {
            const selectors = [
              `[href="#${paneId}"]`,
              `[data-bs-target="#${paneId}"]`,
              `[data-target="#${paneId}"]`,
              `[aria-controls="${paneId}"]`,
              `[aria-controls="#${paneId}"]`
            ];
            for (const selector of selectors) {
              const el = document.querySelector(selector) as HTMLElement | null;
              if (el) {
                el.click();
                return true;
              }
            }
            // Fallback: a tab-role element that references this pane's day count.
            const day = paneId.replace(/\D/g, ""); // "30" / "90"
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>(
                `a[id*="days${day}"], button[id*="days${day}"], [role="tab"][id*="days${day}"], [role="tab"][href*="days${day}"], [role="tab"][data-bs-target*="days${day}"]`
              )
            );
            if (candidates[0]) {
              candidates[0].click();
              return true;
            }
            return false;
          }, pane);
          if (!clicked) {
            warnings.push(`Could not find the ${days}-day tab on the REALTOR.ca page. Upload that screenshot manually.`);
            continue;
          }
        }

        await page.waitForSelector(`#${pane}`, { timeout: 10_000 });
        // The pane element exists in the DOM even when its tab is inactive; wait
        // until it's actually laid out (offsetHeight > 0) before shooting.
        await page.waitForFunction(
          (paneId: string) => {
            const el = document.getElementById(paneId);
            return !!el && el.offsetHeight > 0;
          },
          { timeout: 10_000 },
          pane
        );
        // Fixed settle so the animated charts finish drawing.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const handle = await page.$(`#${pane}`);
        if (!handle) {
          warnings.push(`The ${days}-day stats pane disappeared before capture. Upload that screenshot manually.`);
          continue;
        }
        const png = Buffer.from(await handle.screenshot({ type: "png" }));
        await handle.dispose();
        await saveUpload(requestId, kind, png, `realtor-${days}.png`);
        captured.push(kind);
        console.log(`[realtorCapture] ${requestId}: captured ${kind} (${Math.round(png.byteLength / 1024)} KB)`);
      } catch (error) {
        console.warn(`[realtorCapture] pane capture failed (${days}-day):`, error);
        warnings.push(`Could not capture the ${days}-day REALTOR.ca stats. Upload that screenshot manually.`);
      }
    }
  } catch (error) {
    console.warn("[realtorCapture] capture failed:", error);
    return {
      ok: false,
      captured,
      warnings: [
        ...warnings,
        "REALTOR.ca blocked the automated capture — upload the screenshots manually."
      ]
    };
  } finally {
    await browser?.close();
  }

  console.log(
    `[realtorCapture] ${requestId}: done — captured [${captured.join(", ") || "none"}]` +
      (warnings.length ? `, warnings: ${warnings.join(" | ")}` : "")
  );
  return { ok: captured.length > 0, captured, warnings };
}

// Shared browser launch used by both captures: same executable, args (incl. the
// AutomationControlled flag), UA and viewport. Kept tiny on purpose — the two
// captures diverge entirely after this, so only the launch is factored out.
async function launchBrowser(): Promise<import("puppeteer-core").Browser> {
  const executablePath = browserPath();
  if (!executablePath) {
    // Caller checks browserPath() first; this guard keeps the helper honest.
    throw new Error("no-browser");
  }
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [...BROWSER_ARGS, "--disable-blink-features=AutomationControlled"]
  });
}

const MAX_PHOTOS = 10;

// cdn.realtor.ca serves listing photos under sized path segments
// (…/listings/<lowres|medres|highres>/…). Rewrite a thumb URL to the largest
// variant so the post album gets full-resolution photos, not gallery thumbs.
function toHighRes(url: string): string {
  return url.replace(/\/(?:lowres|medres|lowres_1|reduced|thumbnail)\//i, "/highres/");
}

/**
 * Fetch the first 10 listing photos for a request from REALTOR.ca and store them
 * as `post_photo` assets. Sequence: the member.realtor.ca stats share page →
 * its "View on REALTOR.ca" button → the public listing → its photo gallery.
 *
 * Never throws (adapter contract): any failure returns ok:false + a specific
 * human warning so the manual drag-drop upload stays the fallback. Partial
 * success is valuable — a photo that fails to download just warns and the loop
 * continues, and ok is true as soon as at least one photo is saved.
 */
export async function captureRealtorPhotos(
  requestId: string,
  statsUrl: string
): Promise<RealtorPhotosResult> {
  const warnings: string[] = [];
  let saved = 0;

  if (!isHttpUrl(statsUrl)) {
    return { ok: false, saved, warnings: ["The REALTOR.ca stats link is not a valid http(s) URL."] };
  }

  if (!browserPath()) {
    return {
      ok: false,
      saved,
      warnings: ["REALTOR.ca photo fetch needs Chrome, Edge, or CHROME_PATH set. Upload the photos manually."]
    };
  }

  let browser: import("puppeteer-core").Browser | undefined;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(DESKTOP_UA);
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

    console.log(`[realtorCapture] ${requestId}: opening stats page ${statsUrl}`);
    await page.goto(statsUrl, { waitUntil: "networkidle2", timeout: 30_000 });
    console.log(`[realtorCapture] ${requestId}: stats loaded ${page.url()} ("${(await page.title()).slice(0, 80)}")`);
    await dismissConsent(page);

    // The stats page must show the "View on REALTOR.ca" button — that's the only
    // hop to the public listing. Missing → precise fail-fast (the client pasted
    // the wrong link, or the page shape changed).
    try {
      await page.waitForSelector("#img_reportRight_viewOnRealtorIcon", { timeout: 12_000 });
    } catch {
      return {
        ok: false,
        saved,
        warnings: ["The stats page didn't show the View-on-REALTOR.ca button — fetch photos manually."]
      };
    }

    // Prefer the plain href (simplest, most robust): the icon sits inside an
    // <a> pointing at the public listing. If we can read it, navigate directly
    // and skip the click/new-tab dance entirely.
    const listingHref = await page.evaluate(() => {
      const icon = document.getElementById("img_reportRight_viewOnRealtorIcon");
      const anchor = icon?.closest("a") as HTMLAnchorElement | null;
      return anchor?.href || "";
    });

    let listingPage = page;
    if (listingHref && isHttpUrl(listingHref)) {
      console.log(`[realtorCapture] ${requestId}: following listing href ${listingHref}`);
      await page.goto(listingHref, { waitUntil: "networkidle2", timeout: 30_000 });
    } else {
      // No readable href — click and handle either an in-tab navigation or a new
      // tab. Race the two outcomes; whichever wins, continue on a realtor.ca page.
      console.log(`[realtorCapture] ${requestId}: no href; clicking the View-on-REALTOR.ca button`);
      const newTab = new Promise<import("puppeteer-core").Page | null>((resolve) => {
        const onTarget = async (target: import("puppeteer-core").Target) => {
          try {
            const opened = await target.page();
            if (opened) resolve(opened);
          } catch {
            resolve(null);
          }
        };
        browser!.once("targetcreated", onTarget);
        setTimeout(() => resolve(null), 20_000);
      });
      const sameTabNav = page
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 20_000 })
        .then(() => page)
        .catch(() => null);
      await page.evaluate(() => {
        const icon = document.getElementById("img_reportRight_viewOnRealtorIcon");
        (icon?.closest("a") ?? icon)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const opened = await Promise.race([newTab, sameTabNav]);
      if (opened) listingPage = opened;
      await listingPage.bringToFront().catch(() => {});
    }

    console.log(
      `[realtorCapture] ${requestId}: listing page ${listingPage.url()} ("${(await listingPage.title().catch(() => "")).slice(0, 80)}")`
    );
    // The public listing may show its own cookie/consent banner.
    await dismissConsent(listingPage);

    // The gallery opens from #btnPhotoCount. Wait for it — its absence within 15s
    // means either the listing didn't load or (more likely) public REALTOR.ca's
    // bot wall served a challenge/blocked page instead of the listing.
    try {
      await listingPage.waitForSelector("#btnPhotoCount", { timeout: 15_000 });
    } catch {
      const host = (() => {
        try {
          return new URL(listingPage.url()).hostname;
        } catch {
          return "realtor.ca";
        }
      })();
      console.warn(`[realtorCapture] ${requestId}: no #btnPhotoCount at ${listingPage.url()}`);
      return {
        ok: false,
        saved,
        warnings: [
          `Couldn't open the REALTOR.ca photo gallery (${host}) — the listing page may be blocked by bot ` +
            `protection. Fetch photos manually.`
        ]
      };
    }

    await listingPage.click("#btnPhotoCount").catch(() => {});
    // Wait for the gallery modal's photos to render (it mounts async), then a
    // short settle. The modal (#ImageGalleryModal) fills with the listing's
    // cdn.realtor.ca/listings/… images.
    await listingPage
      .waitForFunction(
        () => document.querySelectorAll("img[src*='cdn.realtor.ca/listings/']").length > 0,
        { timeout: 12_000 }
      )
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Collect the first photo URLs in DISPLAY ORDER, deduped. The gallery renders
    // each photo several times (top grid, sidebar thumbs, list view, grid view),
    // so first-occurrence order is the listing's photo order. Listing photos are
    // the only images served from cdn.realtor.ca/listings/ — icons live on
    // static.realtor.ca and the agent headshot on cdn.realtor.ca/individuals/,
    // so this host+path filter is exact. Data-src/background-image are collected
    // too as a tolerant fallback for a future lazy-loaded gallery variant.
    const urls: string[] = await listingPage.evaluate((cap: number) => {
      const out: string[] = [];
      const seen = new Set<string>();
      const isListingPhoto = (u: string) => /cdn\.realtor\.ca\/listings\//i.test(u);
      const push = (raw: string | null | undefined) => {
        if (!raw) return;
        const u = raw.trim();
        if (!u || !isListingPhoto(u) || seen.has(u)) return;
        seen.add(u);
        out.push(u);
      };
      for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img"))) {
        push(img.getAttribute("src"));
        push(img.currentSrc);
        push(img.getAttribute("data-src"));
      }
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[style*='background-image']"))) {
        const match = /url\(["']?([^"')]+)["']?\)/i.exec(el.style.backgroundImage || "");
        if (match) push(match[1]);
      }
      return out.slice(0, cap);
    }, MAX_PHOTOS);

    if (urls.length === 0) {
      return {
        ok: false,
        saved,
        warnings: ["Opened the REALTOR.ca gallery but found no photos to download — fetch photos manually."]
      };
    }
    console.log(`[realtorCapture] ${requestId}: found ${urls.length} gallery photo URL(s)`);

    // Download each photo on a dedicated page in the same browser (shares the
    // session/cookies). An in-page fetch() is blocked by realtor.ca's CSP
    // (connect-src), so a top-level navigation to the image URL is what works:
    // page.goto → response.buffer() returns the raw JPEG bytes. Try the highres
    // variant first, fall back to the original on failure or the 4MB cap; a photo
    // that fails both just warns and the loop continues.
    const downloader = await browser.newPage();
    await downloader.setUserAgent(DESKTOP_UA);
    // The listing page already loaded these images, so they sit in the HTTP
    // cache — without this the downloader's navigation gets a 304 (no body) and
    // every photo is skipped. Disable the cache to force a fresh 200 with bytes.
    await downloader.setCacheEnabled(false);
    try {
      for (let i = 0; i < urls.length && saved < MAX_PHOTOS; i++) {
        const original = urls[i];
        const candidates = [toHighRes(original), original].filter((u, idx, arr) => arr.indexOf(u) === idx);
        let ok = false;
        for (const candidate of candidates) {
          let buffer: Buffer | undefined;
          try {
            const response = await downloader.goto(candidate, {
              waitUntil: "domcontentloaded",
              timeout: 20_000
            });
            if (response && response.ok()) {
              const contentType = response.headers()["content-type"] ?? "";
              if (contentType.startsWith("image/")) buffer = await response.buffer();
            }
          } catch {
            buffer = undefined;
          }
          if (!buffer || buffer.byteLength === 0) continue;
          try {
            await saveUpload(requestId, "post_photo", buffer, `realtor-photo-${i + 1}.jpg`);
            saved++;
            ok = true;
            console.log(
              `[realtorCapture] ${requestId}: saved photo ${i + 1} (${Math.round(buffer.byteLength / 1024)} KB)` +
                (candidate === original ? "" : " [highres]")
            );
            break;
          } catch (error) {
            // Most likely the 4MB post_photo cap on a big highres — fall through
            // to the smaller original variant on the next loop iteration.
            console.warn(`[realtorCapture] ${requestId}: photo ${i + 1} rejected (${candidate}):`, error);
          }
        }
        if (!ok) warnings.push(`Photo ${i + 1} couldn't be downloaded from REALTOR.ca — add it manually.`);
      }
    } finally {
      await downloader.close().catch(() => {});
    }
  } catch (error) {
    console.warn("[realtorCapture] photo fetch failed:", error);
    return {
      ok: saved > 0,
      saved,
      warnings: [...warnings, "REALTOR.ca blocked the automated photo fetch — upload the photos manually."]
    };
  } finally {
    await browser?.close();
  }

  console.log(
    `[realtorCapture] ${requestId}: done — saved ${saved} photo(s)` +
      (warnings.length ? `, warnings: ${warnings.join(" | ")}` : "")
  );
  return { ok: saved > 0, saved, warnings };
}
