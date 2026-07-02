// short.io link creation on the branded nowforsale.co domain. Created ON CLICK
// from the request detail page — never automatically. Same adapter contract as
// the Meta modules: never throws, degrades to a warning + manual fallback.

const SHORTIO_API = "https://api.short.io/links";
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
