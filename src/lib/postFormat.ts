import type { AdRequest, Brokerage } from "./types";

/**
 * Assemble the Facebook post caption. Single source of truth for the post
 * editor preview, the "Regenerate from fields" button (mirrored client-side),
 * and the text that gets published to the Graph API.
 *
 * Target output (exact line structure from the spec example):
 *
 *   🚨 PRICE REDUCED!🚨 268 Keno Way, Whitehorse
 *   https://nowforsale.co/mls17354
 *   💲 Now Offered at $809,900
 *   🛏️ 3 Bedrooms | 🛁 3 Bathrooms
 *   📍 Whistle Bend
 *
 *   {body paragraphs}
 *
 *   🔗 https://nowforsale.co/mls17354
 *   📞867-333-HOME (4663)
 *   Felix & Rachel - Yukon's Real Estate Connection
 *
 * Lines whose field is empty are omitted entirely — never a dangling emoji.
 */
export function assembleCaption(request: AdRequest, brokerage: Brokerage): string {
  const draft = request.post;
  const shortLink = request.short_link?.url ?? "";

  const head: string[] = [];
  const flag = draft.headline_flag.trim();
  head.push(flag ? `🚨 ${flag}!🚨 ${request.listing_address}` : request.listing_address);
  if (shortLink) head.push(shortLink);

  const price = draft.price.trim().replace(/^\$/, "");
  if (price) head.push(`💲 ${draft.price_prefix.trim() || "Offered at"} $${price}`);

  const beds = draft.beds.trim();
  const baths = draft.baths.trim();
  if (beds && baths) head.push(`🛏️ ${beds} Bedrooms | 🛁 ${baths} Bathrooms`);
  else if (beds) head.push(`🛏️ ${beds} Bedrooms`);
  else if (baths) head.push(`🛁 ${baths} Bathrooms`);

  const neighborhood = draft.neighborhood.trim();
  if (neighborhood) head.push(`📍 ${neighborhood}`);

  const tail: string[] = [];
  if (shortLink) tail.push(`🔗 ${shortLink}`);
  const phoneLine = brokerage.post_phone_line.trim();
  if (phoneLine) tail.push(`📞${phoneLine}`);
  const signoff = brokerage.post_signoff.trim();
  if (signoff) tail.push(signoff);

  const body = draft.body.trim();
  return [head.join("\n"), body, tail.join("\n")].filter(Boolean).join("\n\n");
}
