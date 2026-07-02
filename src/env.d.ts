/// <reference types="astro/client" />

// Server-side secrets/config read from `.env`. Astro/Vite exposes `.env` values on
// `import.meta.env` (NOT `process.env`), so the adapters read import.meta.env with a
// process.env fallback for real hosting environment variables. Declaring them here keeps
// those reads type-safe under `astro/tsconfigs/strict`.
interface ImportMetaEnv {
  readonly ADMIN_PASSWORD?: string;
  readonly META_SYSTEM_USER_TOKEN?: string;
  readonly RESEND_API_KEY?: string;
  readonly EMAIL_FROM?: string;
  readonly EMAIL_REPLY_TO?: string;
  readonly TEAM_EMAIL?: string;
  readonly TEAM_NAME?: string;
  readonly REVIEW_EMAIL?: string;
  readonly SHORTIO_API_KEY?: string;
  readonly SHORTIO_DOMAIN?: string;
  readonly APP_BASE_URL?: string;
  readonly CHROME_PATH?: string;
  readonly DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
