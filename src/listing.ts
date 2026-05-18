/**
 * listing.ts - Product Listings (Scenarios 2, 3, 4, 19)
 *
 * Covers:
 *   NIP-99  - kind 30402 (active listing) / 30403 (draft)
 *   NIP-40  - expiration tag for time-limited listings
 *   NIP-50  - search-capable relay queries
 *   NIP-19  - naddr encoding for shareable product links
 *
 * AUDIT FIX APPLIED:
 *   BLIND-07: Added getListingShareableLink() → returns naddr string.
 *             Without this, there was no way to generate a shareable link
 *             to a product listing.
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { naddrEncode } from "nostr-tools/nip19";
import { publishToRelays, fetchEvents } from "./relays.js";
import {
  type ListingData,
  type PublishResult,
  type NostrEvent,
  KIND,
  COMMERCE_RELAYS,
  SEARCH_RELAYS,
} from "./types.js";

// ─── Build Listing Event Template ─────────────────────────────────────────────

/**
 * Build a kind 30402/30403 listing event template.
 * Does NOT sign or publish - call signAndPublishListing() for the full flow.
 *
 * To UPDATE a listing: call again with the same dTag. Replaceable events
 * (kind 30402) are identified by author pubkey + dTag - the relay replaces
 * the old version with the new one automatically.
 */
export function buildListingTemplate(data: ListingData): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  if (!data.dTag) throw new Error("dTag is required - it is the listing's stable identifier.");
  if (!data.title) throw new Error("title is required.");
  if (!data.price?.amount) throw new Error("price.amount is required.");
  if (!data.price?.currency) throw new Error("price.currency is required.");

  const kind = data.isDraft ? KIND.LISTING_DRAFT : KIND.LISTING_ACTIVE;

  const tags: string[][] = [
    ["d", data.dTag],
    ["title", data.title],
    ["summary", data.summary],
    ["published_at", String(Math.floor(Date.now() / 1000))],
    ["type", data.type],
  ];

  // Price: ["price", amount, currency] or ["price", amount, currency, frequency]
  if (data.price.frequency) {
    tags.push(["price", data.price.amount, data.price.currency, data.price.frequency]);
  } else {
    tags.push(["price", data.price.amount, data.price.currency]);
  }

  for (const img of data.images ?? []) {
    tags.push(["image", img]);
  }

  if (data.location) {
    tags.push(["location", data.location]);
  }

  for (const cat of data.categories ?? []) {
    // Lowercase and remove spaces per NIP convention
    tags.push(["t", cat.toLowerCase().replace(/\s+/g, "-")]);
  }

  // NIP-40: expiration - relay auto-purges event after this timestamp
  if (data.expiresAt != null) {
    const now = Math.floor(Date.now() / 1000);
    if (data.expiresAt <= now) {
      throw new Error(
        `expiresAt (${data.expiresAt}) must be in the future. ` +
          `Current time: ${now}. ` +
          `Tip: use Math.floor(Date.now() / 1000) + <seconds>.`
      );
    }
    tags.push(["expiration", String(data.expiresAt)]);
  }

  return { kind, created_at: Math.floor(Date.now() / 1000), tags, content: data.content };
}

// ─── Sign and Publish ─────────────────────────────────────────────────────────

/**
 * Sign and publish a product listing to commerce relays.
 *
 * @param data       - Listing content
 * @param privateKey - Merchant's private key (Uint8Array from identity module)
 * @param relays     - Target relays (defaults to COMMERCE_RELAYS)
 *
 * @returns PublishResult containing the event ID and per-relay success status
 *
 * To UPDATE: call again with the same dTag - relays replace the old version.
 * To DELETE: call deleteListing() with the event ID.
 */
export async function signAndPublishListing(
  data: ListingData,
  privateKey: Uint8Array,
  relays: string[] = COMMERCE_RELAYS
): Promise<PublishResult & { eventId: string; shareableLink: string }> {
  const template = buildListingTemplate(data);
  const event = finalizeEvent(template, privateKey);

  if (!verifyEvent(event)) {
    throw new Error(
      "Generated listing event has an invalid signature. " +
        "Verify your private key is a valid 32-byte Uint8Array."
    );
  }

  const result = await publishToRelays(event, relays);

  // BLIND-07 FIX: generate shareable naddr link
  const shareableLink = getListingShareableLink(
    data.dTag,
    event.pubkey,
    relays
  );

  return { ...result, shareableLink };
}

// ─── Shareable Link ────────────────────────────────────────────────────────────

/**
 * Generate a shareable naddr link for a listing.
 *
 * BLIND-07 FIX: Without this, there was no way to share a listing URL.
 * naddr is stable - it identifies the listing by author + dTag, not by
 * event ID. So the link remains valid even after the listing is updated.
 *
 * @example
 *   const link = getListingShareableLink("candle-001", merchantPubkey, relays);
 *   // → "naddr1qqq..."
 *   // Share this link - any Nostr client that supports NIP-99 can open it.
 */
export function getListingShareableLink(
  dTag: string,
  merchantPubkey: string,
  relays: string[] = []
): string {
  return naddrEncode({
    kind: KIND.LISTING_ACTIVE,
    pubkey: merchantPubkey,
    identifier: dTag,
    relays,
  });
}

// ─── Delete Listing ───────────────────────────────────────────────────────────

/**
 * Publish a kind 5 deletion event.
 * Compliant relays will stop serving the targeted event.
 * NOTE: Deletion is advisory - non-compliant relays may ignore it.
 */
export async function deleteListing(
  listingEventId: string,
  privateKey: Uint8Array,
  reason = "Listing removed by merchant",
  relays: string[] = COMMERCE_RELAYS
): Promise<PublishResult> {
  const event = finalizeEvent(
    {
      kind: KIND.DELETION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["e", listingEventId],
        ["k", String(KIND.LISTING_ACTIVE)],
      ],
      content: reason,
    },
    privateKey
  );
  return publishToRelays(event, relays);
}

// ─── Fetch Listings ───────────────────────────────────────────────────────────

/**
 * Fetch all active listings from a merchant.
 */
export async function fetchMerchantListings(
  merchantPubkey: string,
  relays: string[] = COMMERCE_RELAYS
): Promise<NostrEvent[]> {
  return fetchEvents(
    [{ authors: [merchantPubkey], kinds: [KIND.LISTING_ACTIVE], limit: 200 }],
    relays
  ) as Promise<NostrEvent[]>;
}

/**
 * NIP-50: Full-text search for listings across search-capable relays.
 *
 * NOTE: Not all relays support NIP-50. SEARCH_RELAYS (nostr.band, primal.net)
 * do. Using DEFAULT_RELAYS with a search filter will silently return no results
 * on non-search relays.
 */
export async function searchListings(
  query: string,
  relays: string[] = SEARCH_RELAYS,
  limit = 20
): Promise<NostrEvent[]> {
  return fetchEvents(
    [{ kinds: [KIND.LISTING_ACTIVE], search: query, limit }],
    relays
  ) as Promise<NostrEvent[]>;
}

// ─── Parse Listing ────────────────────────────────────────────────────────────

export interface ParsedListing {
  dTag: string;
  title: string;
  summary: string;
  content: string;
  price?: { amount: string; currency: string; frequency?: string };
  type?: string;
  images: string[];
  location?: string;
  categories: string[];
  expiresAt?: number;
  publishedAt: number;
  merchantPubkey: string;
  eventId: string;
  isExpired: boolean;
  shareableLink: string;
}

/**
 * Parse a raw kind 30402 Nostr event into a structured listing.
 * Checks expiration and generates a shareable naddr link.
 */
export function parseListing(event: NostrEvent): ParsedListing {
  const getTag = (name: string): string | undefined =>
    event.tags.find((t) => t[0] === name)?.[1];
  const getAllTags = (name: string): string[][] =>
    event.tags.filter((t) => t[0] === name);

  const expiresAt = getTag("expiration") ? Number(getTag("expiration")) : undefined;
  const now = Math.floor(Date.now() / 1000);

  const priceTag = getAllTags("price")[0];
  const price = priceTag
    ? {
        amount: priceTag[1] ?? "0",
        currency: priceTag[2] ?? "SATS",
        frequency: priceTag[3],
      }
    : undefined;

  const dTag = getTag("d") ?? "";

  return {
    dTag,
    title: getTag("title") ?? "",
    summary: getTag("summary") ?? "",
    content: event.content,
    price,
    type: getTag("type"),
    images: getAllTags("image").map((t) => t[1]).filter(Boolean) as string[],
    location: getTag("location"),
    categories: getAllTags("t").map((t) => t[1]).filter(Boolean) as string[],
    expiresAt,
    publishedAt: getTag("published_at")
      ? Number(getTag("published_at"))
      : event.created_at,
    merchantPubkey: event.pubkey,
    eventId: event.id,
    isExpired: expiresAt != null && expiresAt < now,
    shareableLink: getListingShareableLink(dTag, event.pubkey),
  };
}

/** Filter out expired listings client-side. */
export function filterActiveListings(listings: ParsedListing[]): ParsedListing[] {
  return listings.filter((l) => !l.isExpired);
}
