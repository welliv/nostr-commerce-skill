/**
 * listing.ts - NIP-99 Product Listings + Battle Hardening
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { publishToRelays } from "./relays.js";
import { NostrEvent, KIND, DEFAULT_RELAYS } from "./types.js";

export interface ParsedListing {
  dTag: string;
  title: string;
  summary: string;
  content: string;
  price?: { amount: string; currency: string };
  type?: "physical" | "digital" | "service" | "subscription";
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

const EMPTY_LISTING: ParsedListing = {
  dTag: "",
  title: "",
  summary: "",
  content: "",
  price: undefined,
  type: undefined,
  images: [],
  location: undefined,
  categories: [],
  expiresAt: undefined,
  publishedAt: 0,
  merchantPubkey: "",
  eventId: "",
  isExpired: false,
  shareableLink: "",
};

export function parseListing(event: NostrEvent): ParsedListing {
  try {
    if (!event || typeof event !== "object") return { ...EMPTY_LISTING };
    const tags = event.tags || [];
    if (!Array.isArray(tags)) return { ...EMPTY_LISTING };

    const getTag = (name: string): string | undefined => {
      const tag = tags.find((t) => Array.isArray(t) && t[0] === name);
      return tag?.[1];
    };

    const dTag = getTag("d") || "";
    const title = getTag("title") || "";
    const summary = getTag("summary") || "";
    const priceAmount = getTag("price");
    const priceCurrency = getTag("currency") || "SATS";
    const type = getTag("type") as any || "digital";
    const images = getTag("image") ? [getTag("image")!] : [];
    const location = getTag("location");
    const categories = getTag("t") ? [getTag("t")!] : [];
    const expiresAtStr = getTag("expiration");
    const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : undefined;
    const publishedAt = event.created_at || 0;
    const now = Math.floor(Date.now() / 1000);

    return {
      dTag,
      title,
      summary,
      content: event.content ?? "",
      price: priceAmount ? { amount: priceAmount, currency: priceCurrency } : undefined,
      type,
      images,
      location,
      categories,
      expiresAt,
      publishedAt,
      merchantPubkey: event.pubkey ?? "",
      eventId: event.id ?? "",
      isExpired: expiresAt != null && expiresAt < now,
      shareableLink: event.pubkey ? `https://njump.me/${event.id}` : "",
    };
  } catch {
    return { ...EMPTY_LISTING };
  }
}

export function buildListingTemplate(data: any) {
  if (!data.price?.currency) throw new Error("price.currency is required.");
  if (data.price?.amount == null || data.price.amount === "") throw new Error("price.amount is required.");

  const tags: string[][] = [
    ["d", data.dTag || "listing-" + Date.now()],
    ["title", data.title || ""],
    ["summary", data.summary || ""],
    ["price", String(data.price.amount)],
    ["currency", data.price.currency],
  ];

  if (data.type) tags.push(["type", data.type]);
  if (data.image) tags.push(["image", data.image]);

  return {
    kind: KIND.APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: data.content || "",
  };
}

/**
 * Filter a list of listing events to only those that have not expired.
 * Events without an expires_at tag are considered active.
 */
export function filterActiveListings(events: NostrEvent[]): NostrEvent[] {
  if (!Array.isArray(events)) return [];
  const now = Math.floor(Date.now() / 1000);
  return events.filter(event => {
    if (!event || !Array.isArray(event.tags)) return false;
    const expiresTag = event.tags.find(t => t[0] === "expires_at");
    if (!expiresTag?.[1]) return true; // no expiration = active
    const expiresAt = parseInt(expiresTag[1], 10);
    return !isNaN(expiresAt) && expiresAt > now;
  });
}
