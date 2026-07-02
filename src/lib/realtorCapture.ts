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
