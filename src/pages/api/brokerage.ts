import { Buffer } from "node:buffer";
import type { APIRoute } from "astro";
import { isAdmin } from "../../lib/auth";
import {
  brokerageExists,
  createSecretToken,
  deleteBrokerage,
  readBrokerage,
  slugify,
  writeBrokerage
} from "../../lib/storage";
import type { Brokerage } from "../../lib/types";

export const prerender = false;

const hex = /^#[0-9a-fA-F]{6}$/;
const digits = /^[0-9]{1,32}$/;
const emailish = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Uploaded logos are stored as data URIs inside the brokerage JSON itself:
// data/brokerages/ already lives on the persistent volume, and snapshot creation
// passes data URIs through untouched, so frozen reports keep the logo bytes forever.
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const MAX_LOGO_BYTES = 1_000_000;

function field(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: location }
  });
}

function errorPage(status: number, message: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Brokerage not saved</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size:1.25rem;">Brokerage not saved</h1>
<p>${message}</p>
<p>Use your browser's <strong>Back</strong> button to return to the form — your entries are preserved there.</p>
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export const POST: APIRoute = async ({ request }) => {
  // Managing brokerages is team-only (self-guarded — middleware also gates /api).
  if (!isAdmin(request)) {
    return errorPage(401, "Admin sign-in required.");
  }

  const form = await request.formData();

  // Deleting removes the brokerage record and its intake link with it.
  // Requests and snapshots stay on disk, so existing work remains viewable.
  if (field(form, "mode") === "delete") {
    try {
      await deleteBrokerage(field(form, "slug"));
    } catch {
      return errorPage(404, "Brokerage not found.");
    }
    return redirect("/admin/brokerages");
  }

  const name = field(form, "name");
  const slug = slugify(field(form, "slug") || name);
  const isEdit = field(form, "mode") === "edit";

  if (!name || !slug) {
    return errorPage(400, "Brokerage name is required.");
  }

  // Creating must not silently overwrite an existing brokerage; edits declare themselves.
  if (!isEdit && (await brokerageExists(slug))) {
    return errorPage(409, `A brokerage with the slug "${slug}" already exists. Edit it from the brokerages page instead.`);
  }

  const existing = isEdit ? await readBrokerage(slug).catch(() => undefined) : undefined;
  if (isEdit && !existing) {
    return errorPage(404, "Brokerage not found — it may have been deleted.");
  }

  const contactName = field(form, "contact_name");
  if (!contactName) {
    return errorPage(400, "A point person is required — client emails greet them by name.");
  }

  const contactEmail = field(form, "contact_email");
  if (!contactEmail || !emailish.test(contactEmail)) {
    return errorPage(400, "A valid contact email is required — it receives confirmation, launch, and report emails.");
  }

  const website = field(form, "website");
  if (website && !isHttpUrl(website)) {
    return errorPage(400, "Website must be an http(s) URL.");
  }

  // Logo resolution order: uploaded file > pasted URL > (on edit) the existing logo.
  // Whatever the source, the logo is STORED as a data URI — the intake header, the
  // post-editor preview, and every frozen report must render it without a network
  // fetch (a pasted URL that later dies or hangs would break PDFs forever).
  let logoUrl = field(form, "logo_url");
  if (logoUrl && !isHttpUrl(logoUrl)) {
    return errorPage(400, "Logo URL must be an http(s) link — or upload the image file instead.");
  }
  const logoFile = form.get("logo_file");
  if (logoFile instanceof File && logoFile.size > 0) {
    if (!LOGO_TYPES.has(logoFile.type)) {
      return errorPage(400, "Logo must be a PNG, JPEG, SVG, or WebP image.");
    }
    if (logoFile.size > MAX_LOGO_BYTES) {
      return errorPage(400, "Logo file is too large — keep it under 1 MB.");
    }
    const bytes = Buffer.from(await logoFile.arrayBuffer());
    logoUrl = `data:${logoFile.type};base64,${bytes.toString("base64")}`;
  } else if (logoUrl) {
    try {
      const response = await fetch(logoUrl, { signal: AbortSignal.timeout(8000) });
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!response.ok || !LOGO_TYPES.has(contentType)) {
        return errorPage(400, "That logo URL did not return a PNG, JPEG, SVG, or WebP image — upload the file instead.");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOGO_BYTES) {
        return errorPage(400, "The logo at that URL is too large — keep it under 1 MB, or upload a smaller file.");
      }
      logoUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
    } catch {
      return errorPage(400, "Could not download the logo from that URL — upload the image file instead.");
    }
  }
  if (!logoUrl && existing) {
    logoUrl = existing.logo_url;
  }
  if (!logoUrl) {
    return errorPage(400, "A logo is required — upload an image file or paste an https link.");
  }

  // A malformed Meta ID must be rejected, not silently dropped — otherwise the
  // team believes the brokerage is configured and pulls later degrade unexplained.
  const metaPageId = field(form, "meta_page_id");
  if (metaPageId && !digits.test(metaPageId)) {
    return errorPage(400, "Facebook Page ID must be a numeric ID (up to 32 digits).");
  }
  // Ads Manager displays the account as "act_<digits>" — accept a paste and strip it.
  const metaAdAccountId = field(form, "meta_ad_account_id").replace(/^act_/, "");
  if (metaAdAccountId && !digits.test(metaAdAccountId)) {
    return errorPage(400, "Meta ad account ID must be digits only (an \"act_\" prefix is stripped automatically).");
  }

  // The intake token is the dedicated-link secret: minted once at creation and
  // preserved on edit unless the team explicitly regenerates a leaked link.
  const regenerate = field(form, "regenerate_token") === "1";
  const intakeToken = existing && !regenerate ? existing.intake_token : createSecretToken();

  const brokerage: Brokerage = {
    slug,
    name,
    logo_url: logoUrl,
    brand_primary: hex.test(field(form, "brand_primary")) ? field(form, "brand_primary") : "#111111",
    brand_accent: hex.test(field(form, "brand_accent")) ? field(form, "brand_accent") : "#c9a86a",
    website,
    contact_name: contactName,
    contact_email: contactEmail,
    contact_phone: field(form, "contact_phone"),
    address_street: field(form, "address_street"),
    address_city: field(form, "address_city"),
    address_province: field(form, "address_province"),
    address_postal: field(form, "address_postal"),
    address_country: field(form, "address_country") || "Canada",
    post_phone_line: field(form, "post_phone_line"),
    post_signoff: field(form, "post_signoff"),
    ...(metaPageId ? { meta_page_id: metaPageId } : {}),
    ...(metaAdAccountId ? { meta_ad_account_id: metaAdAccountId } : {}),
    intake_token: intakeToken
  };

  await writeBrokerage(brokerage);
  return redirect("/admin/brokerages");
};
