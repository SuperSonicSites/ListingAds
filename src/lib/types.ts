// Canonical data model. Records are JSON files under data/ (see storage.ts);
// uploaded photos/screenshots are binary files on disk referenced by AssetEntry.

export type Brokerage = {
  slug: string; // safe-id, filename
  name: string;
  logo_url: string; // data URI (1MB cap, embedded at save time)
  brand_primary: string; // hex #RRGGBB
  brand_accent: string; // hex #RRGGBB
  website: string;
  contact_name: string; // point person — greeted in client emails ("Hi {client}")
  contact_email: string; // recipient of confirmation/launch/report-delivery emails
  contact_phone: string;
  address_street: string;
  address_city: string;
  address_province: string;
  address_postal: string;
  address_country: string; // default "Canada"
  post_phone_line: string; // e.g. "867-333-HOME (4663)" — rendered after 📞 in posts
  post_signoff: string; // e.g. "Felix & Rachel - Yukon's Real Estate Connection"
  meta_page_id?: string; // digits — FB Page posts are published to
  meta_ad_account_id?: string; // DIGITS ONLY ("act_" stripped in the form); prefixed at call time
  intake_token: string; // 32 lowercase hex — the dedicated intake-link secret
};

export const REQUEST_STATUSES = [
  "new_order",
  "post_created",
  "post_reviewed",
  "ad_published",
  "campaign_in_progress",
  "completed"
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const AD_BUDGETS = [50, 100, 150, 200] as const;
export type AdBudget = (typeof AD_BUDGETS)[number];
export type CampaignType = "new" | "extend";

export const ASSET_KINDS = [
  "post_photo",
  "hero",
  "gallery",
  "ad_preview_mobile",
  "ad_preview_desktop",
  "realtor_7",
  "realtor_30",
  "realtor_90",
  "insights_screenshot"
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

// Kinds that hold exactly one file: a new upload replaces the previous one.
export const SINGLE_SLOT_KINDS: readonly AssetKind[] = [
  "hero",
  "ad_preview_mobile",
  "ad_preview_desktop",
  "realtor_7",
  "realtor_30",
  "realtor_90"
];

export type AssetEntry = {
  id: string; // "ast-<ts>-<hex8>", server-minted, passes the safe-id regex
  kind: AssetKind;
  ext: "jpg" | "png" | "webp"; // from magic bytes, never from the client filename
  original_name: string; // display only, never used in paths
  bytes: number;
  uploaded_at: string; // ISO
};

export type EmailKind =
  | "intake_confirmation"
  | "review_request"
  | "launch"
  | "report_ready_internal"
  | "report_delivery"
  | "report_due_reminder";

export type EmailLogEntry = {
  kind: EmailKind;
  to: string;
  subject: string;
  sent_at: string; // ISO
  ok: boolean;
  resend_id?: string;
  error?: string;
};

export const HEADLINE_FLAGS = [
  "NEW LISTING",
  "JUST LISTED",
  "PRICE REDUCED",
  "OPEN HOUSE",
  "BACK ON THE MARKET",
  "FEATURE LISTING"
] as const;

export type PostDraft = {
  headline_flag: string; // one of HEADLINE_FLAGS
  price_prefix: string; // "Offered at" | "Now Offered at"
  price: string; // team-formatted digits/commas, e.g. "809,900"
  beds: string;
  baths: string;
  neighborhood: string;
  body: string; // descriptive paragraphs, max 2000 chars
  final_text: string; // assembled, editable — published verbatim
  dirty: boolean; // true once final_text was hand-edited (stop re-assembling)
  photo_ids: string[]; // ordered post_photo asset ids (publish order, 1–10)
};

export type AdRequest = {
  id: string; // "req-<ts>-<hex8>"
  brokerage_slug: string;
  status: RequestStatus;
  status_history: { status: RequestStatus; at: string; note?: string }[];
  created_at: string; // ISO
  // — intake (Step 1, verbatim client-submitted fields) —
  listing_address: string;
  ad_budget: AdBudget;
  campaign_type: CampaignType;
  target_cities: string[]; // 1–10, trimmed, deduped
  photos_link: string; // Dropbox/Drive URL (reference only)
  realtor_stats_link: string;
  special_notes: string;
  // — ops fields filled along the pipeline —
  short_link?: { url: string; path: string; link_id?: string };
  fb_campaign_id?: string;
  ad_launch_date?: string; // YYYY-MM-DD
  report_due_date?: string; // YYYY-MM-DD (default launch + 14 days, editable)
  reminder_last_sent_date?: string; // YYYY-MM-DD in America/Vancouver — daily-nag idempotence
  // — post —
  post: PostDraft;
  post_published?: {
    post_id: string;
    permalink_url?: string;
    published_at: string; // ISO
    manual?: boolean; // recorded by hand (posted outside the app)
  };
  // — assets / emails / report —
  assets: AssetEntry[];
  emails: EmailLogEntry[];
  report_snapshot_id?: string; // latest snapshot (regeneration mints a new id)
  report_sent_at?: string; // ISO
};

export type InsightsSource = "meta_api" | "manual" | "mock";

export type BreakdownRow = { key: string; impressions: number; reach: number; clicks: number };

export type ExecReportSnapshot = {
  request_id: string;
  created_at: string; // ISO
  share_token: string; // 32 hex — public ?t= fallback link for oversized PDFs
  brokerage: {
    name: string;
    logo_url: string; // data URI
    brand_primary: string;
    brand_accent: string;
    address_line: string; // "street, city, province postal, country"
    contact_line: string; // point person (+ phone)
    website: string;
  };
  listing: {
    address: string;
    short_link: string;
    price: string;
    beds: string;
    baths: string;
    neighborhood: string;
  };
  campaign: {
    fb_campaign_id: string;
    ad_launch_date: string;
    report_due_date: string;
    budget: AdBudget;
    campaign_type: CampaignType;
    target_cities: string[];
  };
  insights: {
    source: InsightsSource;
    impressions: number;
    reach: number;
    clicks_all: number;
    region: BreakdownRow[];
    age_gender: BreakdownRow[];
    warnings: string[];
  };
  images: {
    // ALL base64 data URIs, embedded at freeze time (snapshot invariant)
    hero: string;
    gallery: string[]; // exactly 6
    ad_preview_mobile: string;
    ad_preview_desktop: string;
    realtor_7: string; // "" if waived
    realtor_30: string;
    realtor_90: string;
    insights_screens: string[]; // optional Ads Manager shots
  };
};

export function emptyPostDraft(): PostDraft {
  return {
    headline_flag: "NEW LISTING",
    price_prefix: "Offered at",
    price: "",
    beds: "",
    baths: "",
    neighborhood: "",
    body: "",
    final_text: "",
    dirty: false,
    photo_ids: []
  };
}
