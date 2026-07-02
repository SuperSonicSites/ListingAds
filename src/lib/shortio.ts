// short.io link creation + click statistics on the branded nowforsale.co
// domain. Links are created ON CLICK from the request detail page — never
// automatically; stats feed the report's "In-Depth Data Of Users" page. Same
// adapter contract as the Meta modules: never throws, degrades to a warning +
// manual fallback.

const SHORTIO_API = "https://api.short.io/links";
const SHORTIO_STATS_API = "https://api-v2.short.io/statistics/link";
const TIMEOUT_MS = 8000;

export type ShortLinkResult = {
  source: "shortio_api" | "mock";
  ok: boolean;
  short_url?: string;
  link_id?: string;
  path?: string;
  warning?: string;
};

function apiKey(): string | undefined {
  return process.env.SHORTIO_API_KEY ?? import.meta.env.SHORTIO_API_KEY;
}

export function shortDomain(): string {
  return process.env.SHORTIO_DOMAIN ?? import.meta.env.SHORTIO_DOMAIN ?? "nowforsale.co";
}

function demoMode(): boolean {
  return (process.env.DEMO_MODE ?? import.meta.env.DEMO_MODE) === "1";
}

export async function createShortLink(
  path: string,
  originalURL: string,
  title?: string
): Promise<ShortLinkResult> {
  const key = apiKey();
  const domain = shortDomain();

  if (!key) {
    if (demoMode()) {
      return { source: "mock", ok: true, short_url: `https://${domain}/${path}`, path };
    }
    return {
      source: "shortio_api",
      ok: false,
      warning: "SHORTIO_API_KEY is not configured. Paste an existing short link instead."
    };
  }

  try {
    // short.io takes the raw secret key as the Authorization header value (not Bearer).
    const response = await fetch(SHORTIO_API, {
      method: "POST",
      headers: {
        Authorization: key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        domain,
        originalURL,
        path,
        title: title ?? "",
        allowDuplicates: false
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const body: any = await response.json().catch(() => ({}));

    if (response.status === 409) {
      return {
        source: "shortio_api",
        ok: false,
        warning: `The path "${path}" is already taken on ${domain} — edit the slug and try again.`
      };
    }
    if (!response.ok) {
      const message = typeof body?.message === "string" ? body.message : `short.io error ${response.status}`;
      return { source: "shortio_api", ok: false, warning: message };
    }

    const shortUrl =
      typeof body?.shortURL === "string" && body.shortURL ? body.shortURL : `https://${domain}/${path}`;
    return {
      source: "shortio_api",
      ok: true,
      short_url: shortUrl,
      link_id: typeof body?.idString === "string" ? body.idString : undefined,
      path: typeof body?.path === "string" ? body.path : path
    };
  } catch {
    return {
      source: "shortio_api",
      ok: false,
      warning: "short.io was unreachable. Try again, or paste an existing short link."
    };
  }
}

// --- Link click statistics (the report's "In-Depth Data Of Users" page) --------

export type NameCount = { name: string; clicks: number };

export type LinkStatsResult = {
  source: "shortio_api" | "manual" | "mock";
  total_clicks: number;
  human_clicks: number;
  series: { date: string; clicks: number }[]; // clicks per day (ISO date)
  cities: NameCount[];
  countries: NameCount[];
  browsers: NameCount[];
  os: NameCount[];
  referrers: NameCount[];
  warning?: string;
};

const MAX_LIST_ROWS = 7;
const MAX_SERIES_POINTS = 60;

// The owner's real Smithdale report numbers — the DEMO walkthrough renders the
// In-Depth page exactly like the reference.
function mockLinkStats(): LinkStatsResult {
  const series: { date: string; clicks: number }[] = [];
  const clicksByDay = [2, 21, 42, 24, 11, 12, 12, 12, 13, 11, 6, 4, 5, 9, 5, 2];
  for (let i = 0; i < clicksByDay.length; i++) {
    const day = String(10 + i).padStart(2, "0");
    series.push({ date: `2026-06-${day}`, clicks: clicksByDay[i] });
  }
  return {
    source: "mock",
    total_clicks: 908,
    human_clicks: 157,
    series,
    cities: [
      { name: "Ucluelet", clicks: 25 },
      { name: "Vancouver", clicks: 10 },
      { name: "Victoria", clicks: 8 },
      { name: "Brampton", clicks: 7 },
      { name: "Unknown", clicks: 6 },
      { name: "Gallatin", clicks: 6 },
      { name: "Montréal", clicks: 4 }
    ],
    countries: [
      { name: "Canada", clicks: 141 },
      { name: "United States", clicks: 16 },
      { name: "Denmark", clicks: 0 },
      { name: "France", clicks: 0 },
      { name: "Ireland", clicks: 0 }
    ],
    browsers: [
      { name: "Facebook", clicks: 76 },
      { name: "Chrome", clicks: 37 },
      { name: "Mobile Safari", clicks: 14 },
      { name: "Chrome Mobile", clicks: 10 },
      { name: "Edge", clicks: 7 },
      { name: "Safari", clicks: 6 },
      { name: "Chrome Mobile iOS", clicks: 4 }
    ],
    os: [
      { name: "iOS", clicks: 72 },
      { name: "Windows", clicks: 34 },
      { name: "Android", clicks: 32 },
      { name: "Mac OS X", clicks: 18 },
      { name: "Linux", clicks: 1 }
    ],
    referrers: [
      { name: "l.facebook.com", clicks: 64 },
      { name: "facebook.com", clicks: 35 },
      { name: "m.facebook.com", clicks: 23 },
      { name: "lm.facebook.com", clicks: 20 },
      { name: "Unknown", clicks: 11 },
      { name: "www.facebook.com", clicks: 3 },
      { name: "nowforsale.co", clicks: 1 }
    ]
  };
}

function emptyStats(source: LinkStatsResult["source"], warning: string): LinkStatsResult {
  return {
    source,
    total_clicks: 0,
    human_clicks: 0,
    series: [],
    cities: [],
    countries: [],
    browsers: [],
    os: [],
    referrers: [],
    warning
  };
}

// Breakdown arrays arrive as [{ score, <dimension> }] with the dimension key
// named after the list (browser/os/country/city/referer). Normalize tolerantly:
// take the first string-valued property as the name and score/clicks as the
// count, so a key-name drift degrades to fewer rows instead of an empty page.
function normalizeList(raw: unknown): NameCount[] {
  if (!Array.isArray(raw)) return [];
  const rows: NameCount[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const count = Number(record.score ?? record.clicks ?? record.count ?? record.y);
    let name = "";
    for (const key of ["browser", "os", "country", "city", "referer", "referrer", "social", "name"]) {
      if (typeof record[key] === "string" && (record[key] as string).trim()) {
        name = (record[key] as string).trim();
        break;
      }
    }
    if (!name || !Number.isFinite(count)) continue;
    rows.push({ name: name.slice(0, 60), clicks: Math.max(0, Math.round(count)) });
  }
  return rows.sort((a, b) => b.clicks - a.clicks).slice(0, MAX_LIST_ROWS);
}

// Clicks-over-time from clickStatistics.datasets[0].data = [{ x: ISO, y }],
// bucketed per day (the API returns day buckets for period=total).
function normalizeSeries(raw: any): { date: string; clicks: number }[] {
  const data = raw?.datasets?.[0]?.data;
  if (!Array.isArray(data)) return [];
  const byDay = new Map<string, number>();
  for (const point of data) {
    const date = typeof point?.x === "string" ? point.x.slice(0, 10) : "";
    const clicks = Number(point?.y);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(clicks)) continue;
    byDay.set(date, (byDay.get(date) ?? 0) + Math.max(0, Math.round(clicks)));
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-MAX_SERIES_POINTS)
    .map(([date, clicks]) => ({ date, clicks }));
}

/**
 * Fetch a link's click statistics for the report's In-Depth page.
 * Endpoint per developers.short.io ("Link Statistics"):
 *   GET https://api-v2.short.io/statistics/link/{linkId}?period=total&tzOffset=0
 * with the raw secret key in the Authorization header. totalClicks/humanClicks
 * are documented; the series + breakdown key names are normalized tolerantly —
 * VERIFY ON FIRST LIVE CALL (no SHORTIO_API_KEY exists in dev).
 */
export async function fetchLinkStats(linkId: string): Promise<LinkStatsResult> {
  const key = apiKey();

  if (!key) {
    if (demoMode()) return mockLinkStats();
    return emptyStats("manual", "SHORTIO_API_KEY is not configured — link analytics unavailable.");
  }
  if (!linkId) {
    return emptyStats(
      "manual",
      "The short link has no stats id — it wasn't created through the app."
    );
  }

  try {
    const response = await fetch(
      `${SHORTIO_STATS_API}/${encodeURIComponent(linkId)}?period=total&tzOffset=0`,
      {
        headers: { Authorization: key },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }
    );
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body?.message === "string" ? body.message : `short.io error ${response.status}`;
      return emptyStats("shortio_api", `Link analytics unavailable: ${message}`);
    }

    return {
      source: "shortio_api",
      total_clicks: Math.max(0, Math.round(Number(body?.totalClicks) || 0)),
      human_clicks: Math.max(0, Math.round(Number(body?.humanClicks) || 0)),
      series: normalizeSeries(body?.clickStatistics),
      cities: normalizeList(body?.cities ?? body?.city),
      countries: normalizeList(body?.countries ?? body?.country),
      browsers: normalizeList(body?.browsers ?? body?.browser),
      os: normalizeList(body?.os),
      referrers: normalizeList(body?.referers ?? body?.referrers ?? body?.referer)
    };
  } catch {
    return emptyStats("shortio_api", "short.io statistics were unreachable. Try again.");
  }
}
