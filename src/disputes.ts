/**
 * disputes.ts - LNURL-Verify + NIP-85 Dispute Resolution (Scenario 22)
 *
 * NIPs: NIP-85 (trusted assertions, kind 30382)
 * Lightning: LNURL-Verify - proof of payment without wallet access
 *
 * How disputes are resolved without a trusted third party:
 *   1. Buyer claims non-delivery. Merchant claims payment received.
 *   2. Arbitrator calls verifyPaymentViaLnurl() - checks if payment_hash settled.
 *   3. If settled: LNURL server confirms. Arbitrator publishes a NIP-85 assertion.
 *   4. The assertion is permanent, signed, and verifiable by anyone on any relay.
 *   5. Neither party needed to share their wallet - only the payment hash.
 *
 * Why this matters:
 *   Traditional dispute resolution requires the platform to access both wallets.
 *   LNURL-Verify exposes only settlement status. The preimage stays private.
 *   NIP-85 makes the arbitrator's finding permanent and censorship-resistant.
 *
 * CAVEAT: LNURL-Verify is not universally supported. Some Lightning providers
 * (particularly custodial wallets) do not expose a verify URL. When the verify
 * URL is absent, fall back to NIP-85 attestation-only based on preimage evidence.
 */

import { finalizeEvent, verifyEvent, generateSecretKey } from "nostr-tools";
import { publishToRelays, fetchEvents } from "./relays.js";
import {
  type NostrEvent,
  type PublishResult,
  type PaymentAssertionData,
  type DisputeData,
  type DisputeResolution,
  type LnurlVerifyResult,
  KIND,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── LNURL-Verify ─────────────────────────────────────────────────────────────

/**
 * Verify a Lightning payment via the LNURL-verify endpoint.
 *
 * The verify URL comes from the original LNURL-pay response (`verify` field).
 * If the merchant stored this URL when creating the payment request, they can
 * prove settlement to any third party without exposing wallet credentials.
 *
 * Protocol: GET <verify_url> → { settled: bool, preimage?: string }
 *
 * @param lnurlVerifyUrl - The verify URL from the original LNURL-pay response
 * @param paymentHash    - The payment hash to verify (hex string)
 *
 * @example
 *   const result = await verifyPaymentViaLnurl(
 *     "https://getalby.com/lnurlp/verify/alice/abc123",
 *     "abc123...paymentHash..."
 *   );
 *   if (result.settled) console.log("Payment confirmed!");
 */
export async function verifyPaymentViaLnurl(
  lnurlVerifyUrl: string,
  paymentHash: string
): Promise<LnurlVerifyResult> {
  try {
    const res = await fetch(lnurlVerifyUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      throw new Error(`LNURL-verify returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();

    return {
      settled: data.settled === true,
      preimage: typeof data.preimage === "string" ? data.preimage : undefined,
      amount: typeof data.amount === "number" ? data.amount : undefined,
    };
  } catch (err) {
    throw new Error(
      `LNURL-verify failed for ${lnurlVerifyUrl}:\n` +
        `${err instanceof Error ? err.message : String(err)}\n\n` +
        `Note: Not all Lightning providers support LNURL-verify. ` +
        `If the URL is unavailable, use NIP-85 preimage-based verification instead.`
    );
  }
}

// ─── NIP-85 Payment Assertions ────────────────────────────────────────────────

/**
 * Publish a trusted NIP-85 assertion confirming (or denying) a payment.
 *
 * NIP-85 kind 30382 events are signed by an attestor (trusted third party).
 * The assertion is permanent, public, and verifiable by anyone.
 *
 * Who is the attestor?
 *   - An escrow service operator
 *   - A marketplace platform
 *   - A trusted mutual contact of buyer and seller
 *   - A professional arbitration service
 *
 * The key insight: the attestor's pubkey reputation is staked on the assertion.
 * If they lie, they can be NIP-56 reported and lose all future credibility.
 *
 * @param data         - Payment details and outcome
 * @param attestorKey  - Private key of the trusted attestor
 * @param relays       - Relays to publish to
 */
export async function publishPaymentAssertion(
  data: PaymentAssertionData,
  attestorKey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  if (!data.subjectPubkey || data.subjectPubkey.length !== 64) {
    throw new Error("subjectPubkey must be a valid 64-char hex pubkey.");
  }
  if (!data.paymentHash || data.paymentHash.length !== 64) {
    throw new Error("paymentHash must be a valid 64-char hex payment hash.");
  }

  const tags: string[][] = [
    // d-tag identifies this specific assertion (stable for updates)
    ["d", `payment:${data.paymentHash}`],
    // Subject: the pubkey this assertion is about
    ["p", data.subjectPubkey],
    // Payment claim details
    ["payment_hash", data.paymentHash],
    ["settled", data.settled ? "true" : "false"],
    ["amount", String(data.amountMsats)],
  ];

  if (data.settledAt) {
    tags.push(["settled_at", String(data.settledAt)]);
  }
  if (data.orderId) {
    tags.push(["order_id", data.orderId]);
  }

  const event = finalizeEvent(
    {
      kind: KIND.TRUSTED_ASSERTION, // 30382
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: data.note ?? (data.settled
        ? `Payment confirmed: ${Math.floor(data.amountMsats / 1000)} sats settled.`
        : `Payment NOT confirmed: hash ${data.paymentHash.slice(0, 16)}... not found settled.`
      ),
    },
    attestorKey
  );

  if (!verifyEvent(event)) {
    throw new Error("Generated assertion event has an invalid signature.");
  }

  return publishToRelays(event, relays);
}

/**
 * Fetch all NIP-85 assertions about a specific payment hash.
 * Returns assertions from any attestor - clients should weight
 * assertions by the attestor's known reputation/web-of-trust depth.
 */
export async function fetchAssertionsForPayment(
  paymentHash: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<{
  attestorPubkey: string;
  settled: boolean;
  amountMsats: number;
  settledAt?: number;
  orderId?: string;
  note: string;
  eventId: string;
  createdAt: number;
}[]> {
  const events = await fetchEvents(
    [
      {
        kinds: [KIND.TRUSTED_ASSERTION],
        "#d": [`payment:${paymentHash}`],
        limit: 50,
      },
    ],
    relays
  ) as NostrEvent[];

  return events.map((event) => {
    const getTag = (name: string) =>
      event.tags.find((t) => t[0] === name)?.[1];

    return {
      attestorPubkey: event.pubkey,
      settled: getTag("settled") === "true",
      amountMsats: Number(getTag("amount") ?? 0),
      settledAt: getTag("settled_at") ? Number(getTag("settled_at")) : undefined,
      orderId: getTag("order_id"),
      note: event.content,
      eventId: event.id,
      createdAt: event.created_at,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

// ─── Dispute Events ───────────────────────────────────────────────────────────

/**
 * Publish a dispute event to relays, requesting arbitration.
 *
 * The dispute event is a kind 1984 (same as NIP-56 reports) but with
 * dispute-specific tags. Arbitrators monitoring relays can subscribe
 * to these events and offer resolution services.
 *
 * Both buyer and merchant should publish their side to give arbitrators
 * the full picture before ruling.
 */

/**
 * Synchronous validation for dispute data.
 * Throws immediately so callers can catch without awaiting.
 */
export function validateDisputeData(data: DisputeData): void {
  if (!data?.orderId) throw new Error("orderId is required.");
  if (!data.paymentHash || data.paymentHash.length !== 64) {
    throw new Error("paymentHash must be a valid 64-char hex payment hash.");
  }
  if (!data.reason?.trim()) throw new Error("Dispute reason cannot be empty.");
}

export async function initiateDispute(
  data: DisputeData,
  disputerKey?: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  // Validate synchronously — throws before any await, so .toThrow() catches it
  if (!data?.orderId) throw new Error("orderId is required.");
  if (!data?.paymentHash || data.paymentHash.length !== 64) {
    throw new Error("paymentHash must be a valid 64-char hex payment hash.");
  }
  if (!data?.reason?.trim()) throw new Error("Dispute reason cannot be empty.");

  if (!data.merchantPubkey || data.merchantPubkey.length !== 64) {
    throw new Error("merchantPubkey must be a valid 64-char hex pubkey.");
  }
  if (!data.buyerPubkey || data.buyerPubkey.length !== 64) {
    throw new Error("buyerPubkey must be a valid 64-char hex pubkey.");
  }

  if (!disputerKey || !(disputerKey instanceof Uint8Array) || disputerKey.length !== 32) {
    throw new Error("disputerKey must be a valid 32-byte Uint8Array private key.");
  }

  const tags: string[][] = [
    // Tag both parties so they're notified
    ["p", data.merchantPubkey, "merchant"],
    ["p", data.buyerPubkey, "buyer"],
    // Dispute details
    ["d", `dispute:${data.orderId}`],
    ["order_id", data.orderId],
    ["payment_hash", data.paymentHash],
    ["dispute_type", "commerce"],
  ];

  // Link supporting evidence events
  if (Array.isArray(data.evidenceEventIds)) {
    for (const evidenceId of data.evidenceEventIds) {
    if (evidenceId.length === 64) {
      tags.push(["e", evidenceId, "", "evidence"]);
    }
  }
}

  const event = finalizeEvent(
    {
      kind: KIND.REPORT, // 1984 - reusing dispute-style
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: data.reason,
    },
    disputerKey
  );

  if (!verifyEvent(event)) {
    throw new Error("Generated dispute event has an invalid signature.");
  }

  return publishToRelays(event, relays);
}

/**
 * Publish a resolution to an open dispute.
 *
 * Called by an arbitrator after reviewing both sides.
 * The resolution is a NIP-85 assertion that also references the dispute event.
 *
 * @param disputeEventId  - The event ID of the original dispute
 * @param resolution      - The arbitrator's ruling
 * @param splitPercent    - If "split": buyer receives this % back (0-100)
 * @param note            - Explanation of the ruling
 * @param arbitratorKey   - Arbitrator's private key (their reputation is staked)
 */
export async function resolveDispute(
  data: {
    disputeEventId: string;
    resolution: DisputeResolution;
    splitPercent?: number;
    note: string;
    paymentHash: string;
    merchantPubkey: string;
    buyerPubkey: string;
  },
  arbitratorKey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  if (data.resolution === "split" && (
    data.splitPercent === undefined ||
    data.splitPercent < 0 ||
    data.splitPercent > 100
  )) {
    throw new Error("splitPercent must be 0-100 when resolution is 'split'.");
  }

  const tags: string[][] = [
    ["d", `resolution:${data.disputeEventId}`],
    ["e", data.disputeEventId, "", "dispute"],
    ["p", data.merchantPubkey, "merchant"],
    ["p", data.buyerPubkey, "buyer"],
    ["payment_hash", data.paymentHash],
    ["resolution", data.resolution],
  ];

  if (data.resolution === "split" && data.splitPercent !== undefined) {
    tags.push(["buyer_refund_percent", String(data.splitPercent)]);
    tags.push(["seller_receives_percent", String(100 - data.splitPercent)]);
  }

  const event = finalizeEvent(
    {
      kind: KIND.TRUSTED_ASSERTION,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: data.note,
    },
    arbitratorKey
  );

  if (!verifyEvent(event)) {
    throw new Error("Generated resolution event has an invalid signature.");
  }

  return publishToRelays(event, relays);
}

// ─── Verification Workflow ────────────────────────────────────────────────────

/**
 * Complete dispute verification workflow:
 *   1. Verify payment via LNURL (if URL available)
 *   2. Publish NIP-85 assertion with result
 *   3. Return the settlement status and assertion event ID
 *
 * This is the "one-call" arbitration helper for simple cases.
 *
 * @param lnurlVerifyUrl   - LNURL verify URL (from original payment response)
 * @param paymentHash      - Payment hash to verify
 * @param subjectPubkey    - Merchant's pubkey (subject of the assertion)
 * @param amountMsats      - Expected payment amount
 * @param attestorKey      - Attestor's private key
 * @param orderId          - Optional order reference
 */
export async function verifyAndAttest(
  lnurlVerifyUrl: string,
  paymentHash: string,
  subjectPubkey: string,
  amountMsats: number,
  attestorKey: Uint8Array,
  orderId?: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<{
  settled: boolean;
  preimage?: string;
  assertionEventId: string;
}> {
  // Step 1: Verify via LNURL
  let verification: LnurlVerifyResult;
  try {
    verification = await verifyPaymentViaLnurl(lnurlVerifyUrl, paymentHash);
  } catch {
    // LNURL-verify not supported - we can only note the hash, not verify it
    verification = { settled: false };
  }

  // Step 2: Publish NIP-85 assertion
  const result = await publishPaymentAssertion(
    {
      subjectPubkey,
      paymentHash,
      settled: verification.settled,
      amountMsats,
      settledAt: verification.settled ? Math.floor(Date.now() / 1000) : undefined,
      orderId,
      note: verification.settled
        ? `LNURL-verify confirmed: payment hash ${paymentHash.slice(0, 16)}... settled.`
        : `LNURL-verify: payment hash ${paymentHash.slice(0, 16)}... not found settled.`,
    },
    attestorKey,
    relays
  );

  return {
    settled: verification.settled,
    preimage: verification.preimage,
    assertionEventId: result.eventId,
  };
}
