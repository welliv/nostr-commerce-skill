/**
 * reviews.ts - preimage-Gated Reviews (Scenario 10)
 *
 * AUDIT FIXES APPLIED:
 *   BUG-08: Reviews now bind the preimage to a specific listing + paymentHash.
 *           Previous version accepted any preimage for any review - allowing
 *           replay attacks and merchant self-reviews. Now:
 *             • paymentHash is required (proves a specific payment happened)
 *             • listingEventId is required (binds review to specific listing)
 *             • Verification checks SHA256(preimage) === paymentHash
 *   BUG-11: crypto.subtle availability fixed for Node.js < 19
 *
 * WHY THE preimage GATE MATTERS:
 *   Without it: fake reviews cost $0 and take 10 seconds.
 *   With it: each fake review requires a real Lightning payment.
 *   SHA256(preimage) === paymentHash is verifiable by any client, permanently.
 *   The reviewer's pubkey signs the claim - they stake their reputation on it.
 *
 *   REMAINING LIMITATION (documented honestly):
 *   A merchant can still self-review by sending sats from one key to another.
 *   Cost per fake review = payment amount. For small amounts, this is cheap.
 *   Mitigation: clients should check if reviewer.pubkey === listing.pubkey
 *   and apply lower weight or a warning to such reviews.
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { publishToRelays, fetchEvents } from "./relays.js";
import {
  type ReviewData,
  type NostrEvent,
  type PublishResult,
  KIND,
  COMMERCE_RELAYS,
} from "./types.js";

// ─── Crypto: SHA-256 preimage Verification ────────────────────────────────────

/**
 * Get SubtleCrypto - works in browsers and Node.js 18+.
 *
 * BUG-11 FIX: In Node.js 18.x, globalThis.crypto may not be available in all
 * contexts. We try globalThis.crypto first, then fall back to node:crypto.
 */
async function getSubtle(): Promise<SubtleCrypto> {
  if (typeof globalThis.crypto?.subtle !== "undefined") {
    return globalThis.crypto.subtle;
  }
  // Node.js 18+ fallback
  const { webcrypto } = await import("node:crypto");
  return webcrypto.subtle as SubtleCrypto;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("Invalid hex string.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify that SHA256(preimage) === paymentHash.
 *
 * This is the cryptographic proof that the reviewer actually made the payment.
 * SHA-256 is a one-way function - computing a preimage that hashes to a
 * specific paymentHash is computationally infeasible.
 *
 * @param preimage     - 64-char hex string (32 bytes), the Lightning payment preimage
 * @param paymentHash  - 64-char hex string (32 bytes), the BOLT-11 invoice payment hash
 */
export async function verifyPreimage(
  preimage: string,
  paymentHash: string
): Promise<boolean> {
  try {
    const subtle = await getSubtle();
    const preimageBytes = hexToBytes(preimage);
    const hashBuffer = await subtle.digest("SHA-256", preimageBytes as BufferSource);
    const computedHash = bytesToHex(new Uint8Array(hashBuffer));
    return computedHash === paymentHash.toLowerCase();
  } catch {
    return false;
  }
}

// ─── Publish Review ────────────────────────────────────────────────────────────

/**
 * Publish a preimage-gated review (kind 31990 community convention).
 *
 * BUG-08 FIX: The preimage is now bound to a specific payment hash AND listing.
 * Clients verifying reviews must check:
 *   1. SHA256(preimage) === payment_hash tag on the review
 *   2. payment_hash corresponds to a payment for the listingEventId
 *
 * Without step 2, any preimage holder can verify any review for any listing.
 *
 * @param data         - Review content (preimage + paymentHash + listingEventId required)
 * @param reviewerKey  - Buyer's private key
 * @param relays       - Target relays
 */
export async function publishReview(
  data: ReviewData,
  reviewerKey: Uint8Array,
  relays: string[] = COMMERCE_RELAYS
): Promise<PublishResult> {
  // Input validation
  if (data.rating < 1 || data.rating > 5) {
    throw new Error("Rating must be an integer between 1 and 5.");
  }
  if (!data.content.trim()) {
    throw new Error("Review content cannot be empty.");
  }
  if (!data.preimage || data.preimage.length !== 64) {
    throw new Error(
      "Invalid preimage. Must be exactly 64 hex characters (32 bytes).\n" +
        "This is the preimage returned by your Lightning wallet after payment."
    );
  }
  if (!data.paymentHash || data.paymentHash.length !== 64) {
    throw new Error(
      "Invalid paymentHash. Must be exactly 64 hex characters (32 bytes).\n" +
        "This is the payment_hash from the BOLT-11 invoice you paid."
    );
  }
  if (!data.listingEventId || data.listingEventId.length !== 64) {
    throw new Error(
      "listingEventId is required and must be a valid 64-char event ID.\n" +
        "Reviews must be bound to a specific listing event."
    );
  }

  // Verify preimage before publishing - don't let reviewers post with bad proof
  const valid = await verifyPreimage(data.preimage, data.paymentHash);
  if (!valid) {
    throw new Error(
      "Preimage verification failed: SHA256(preimage) !== paymentHash.\n" +
        "The preimage does not correspond to this payment hash.\n" +
        "Verify you are using the correct preimage from the correct payment."
    );
  }

  const tags: string[][] = [
    // Unique stable ID for this review
    ["d", `review:${data.subject}:${data.listingEventId}`],
    // Rating
    ["rating", String(data.rating)],
    // BUG-08 FIX: Bind preimage to the specific payment hash
    ["preimage", data.preimage],
    ["payment_hash", data.paymentHash],
    // BUG-08 FIX: listingEventId now required and tagged
    ["e", data.listingEventId, "", "listing"],
  ];

  // Reference the subject (merchant pubkey or listing event)
  if (data.subjectType === "pubkey") {
    tags.push(["p", data.subject]);
  } else {
    tags.push(["e", data.subject, "", "subject"]);
  }

  const event = finalizeEvent(
    {
      kind: KIND.REVIEW,  // BUG-06 FIX: renamed from HANDLER_INFO
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: data.content,
    },
    reviewerKey
  );

  if (!verifyEvent(event)) {
    throw new Error("Generated review event has an invalid signature.");
  }

  return publishToRelays(event, relays);
}

// ─── Fetch Reviews ────────────────────────────────────────────────────────────

/** Fetch all reviews for a merchant pubkey or listing event. */
export async function fetchReviews(
  subject: string,
  subjectType: "pubkey" | "event",
  relays: string[] = COMMERCE_RELAYS
): Promise<NostrEvent[]> {
  const filter =
    subjectType === "pubkey"
      ? { kinds: [KIND.REVIEW], "#p": [subject], limit: 200 }
      : { kinds: [KIND.REVIEW], "#e": [subject], limit: 200 };

  return fetchEvents([filter], relays) as Promise<NostrEvent[]>;
}

// ─── Parse and Verify Review ──────────────────────────────────────────────────

export interface ParsedReview {
  reviewer: string;
  rating: number;
  content: string;
  preimage: string;
  paymentHash: string;
  listingEventId?: string;
  /** false by default - call verifyPreimage() or use fetchVerifiedReviews() */
  isVerified: boolean;
  /** true if reviewer pubkey === listing pubkey (possible self-review - lower trust) */
  isSuspect: boolean;
  createdAt: number;
  eventId: string;
}

/**
 * Parse a raw kind 31990 event into a structured review.
 * isVerified is false by default - use fetchVerifiedReviews() for batch verification.
 */
export function parseReview(
  event: NostrEvent,
  listingAuthorPubkey?: string
): ParsedReview {
  const getTag = (name: string, marker?: string): string | undefined => {
    if (marker) {
      return event.tags.find((t) => t[0] === name && t[3] === marker)?.[1];
    }
    return event.tags.find((t) => t[0] === name)?.[1];
  };

  return {
    reviewer: event.pubkey,
    rating: Number(getTag("rating") ?? 0),
    content: event.content,
    preimage: getTag("preimage") ?? "",
    paymentHash: getTag("payment_hash") ?? "",
    listingEventId: getTag("e", "listing"),
    isVerified: false,
    // Self-review detection: reviewer is the listing author
    isSuspect: !!listingAuthorPubkey && event.pubkey === listingAuthorPubkey,
    createdAt: event.created_at,
    eventId: event.id,
  };
}

/**
 * Fetch, parse, and cryptographically verify reviews.
 * Returns reviews sorted: verified first, then by rating.
 *
 * @param subject              - pubkey or event ID being reviewed
 * @param subjectType          - "pubkey" or "event"
 * @param listingAuthorPubkey  - used to flag potential self-reviews
 */
export async function fetchVerifiedReviews(
  subject: string,
  subjectType: "pubkey" | "event",
  listingAuthorPubkey?: string,
  relays: string[] = COMMERCE_RELAYS
): Promise<ParsedReview[]> {
  const rawEvents = await fetchReviews(subject, subjectType, relays);
  const parsed = rawEvents.map((e) => parseReview(e, listingAuthorPubkey));

  // Verify each preimage - run in parallel
  const verified = await Promise.all(
    parsed.map(async (review) => {
      if (review.preimage && review.paymentHash) {
        review.isVerified = await verifyPreimage(
          review.preimage,
          review.paymentHash
        );
      }
      return review;
    })
  );

  // Sort: verified + not-suspect first, then by rating descending
  return verified.sort((a, b) => {
    if (a.isVerified !== b.isVerified) return a.isVerified ? -1 : 1;
    if (a.isSuspect !== b.isSuspect) return a.isSuspect ? 1 : -1;
    return b.rating - a.rating;
  });
}

// ─── Rating Summary ───────────────────────────────────────────────────────────

export interface RatingSummary {
  average: number;
  total: number;
  verifiedCount: number;
  suspectCount: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

export function summarizeRatings(reviews: ParsedReview[] = []): RatingSummary {
  if (!Array.isArray(reviews)) reviews = [];

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
  let total = 0;
  let verifiedCount = 0;
  let suspectCount = 0;

  for (const r of reviews) {
    if (!r || typeof r.rating !== "number") continue;
    const rating = r.rating as 1 | 2 | 3 | 4 | 5;
    if (rating >= 1 && rating <= 5) {
      distribution[rating]++;
      total += rating;
    }
    if (r.isVerified) verifiedCount++;
    if (r.isSuspect) suspectCount++;
  }

  return {
    average: reviews.length > 0 ? total / reviews.length : 0,
    total: reviews.length,
    verifiedCount,
    suspectCount,
    distribution,
  };
}
