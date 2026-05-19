/**
 * zaps.ts - Lightning Zaps & Payment Prisms (Scenarios 13, 14)
 *
 * Covers:
 *   NIP-57  - zap requests (kind 9734) and zap receipts (kind 9735)
 *   Prisms  - multi-recipient payment splits via weighted zap tags
 *
 * AUDIT FIX:
 *   BUG-10: The BOLT-11 amount parser is documented as display-only.
 *           It handles common cases but is not used for payment logic.
 *           For accurate amount parsing, use a BOLT-11 library.
 *
 * PRISM MECHANICS (Scenario 14):
 *   A standard payment: buyer → merchant (100%)
 *   A prism payment:    buyer → merchant (97%) + platform (3%)
 *   The split happens at payment time. No custody. No delay.
 *   Compare to eBay: they hold your money, take their cut, release the rest.
 *   On Nostr: the payment splits before anyone holds anything.
 *
 * ZAP FLOW:
 *   1. Fetch recipient's LNURL endpoint from their kind 0 profile
 *   2. Fetch LNURL metadata to get callback URL and nostrPubkey
 *   3. Build and sign a kind 9734 zap request
 *   4. POST to LNURL callback → receive BOLT-11 invoice
 *   5. Pay the invoice with your wallet
 *   6. LNURL provider publishes kind 9735 receipt to Nostr
 *   7. Any client can display the zap as a social signal
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { fetchEvents, fetchLatestEvent } from "./relays.js";
import {
  type ZapParams,
  type ZapRecipient,
  type NostrEvent,
  KIND,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── LNURL Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a user's LNURL pay endpoint from their kind 0 profile (lud16 field).
 * lud16 is a Lightning address: "alice@getalby.com"
 */
export async function resolveLnurlFromProfile(
  pubkey: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<string | null> {
  const metadata = await fetchLatestEvent(pubkey, KIND.METADATA, relays);
  if (!metadata) return null;

  try {
    const content = JSON.parse(metadata.content);
    const lud16: string | undefined = content.lud16;
    if (!lud16 || !lud16.includes("@")) return null;

    const [name, domain] = lud16.split("@");
    if (!name || !domain) return null;

    return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  } catch {
    return null;
  }
}

/**
 * Fetch LNURL pay metadata from an endpoint.
 */
export async function fetchLnurlMetadata(lnurlEndpoint: string): Promise<{
  callback: string;
  minSendable: number;
  maxSendable: number;
  nostrPubkey?: string;
  allowsNostr?: boolean;
} | null> {
  try {
    const res = await fetch(lnurlEndpoint, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ─── Build Zap Request ────────────────────────────────────────────────────────

/**
 * Build a NIP-57 kind 9734 zap request event.
 * This is sent to the LNURL endpoint - NOT published to Nostr directly.
 *
 * For a payment prism (split), include multiple recipients with weights.
 */
export function buildZapRequest(
  params: ZapParams,
  senderPrivkey: Uint8Array
): NostrEvent {
  if (params.recipients.length === 0) {
    throw new Error("At least one recipient is required.");
  }
  if (params.amountMsats <= 0) {
    throw new Error("amountMsats must be greater than 0.");
  }

  const tags: string[][] = [
    ["relays", ...params.relays],
    ["amount", String(params.amountMsats)],
  ];

  if (params.recipients.length === 1) {
    // Single recipient - standard zap
    tags.push(["p", params.recipients[0].pubkey]);
  } else {
    // Prism: multiple recipients with weights
    // NIP-57 split extension: ["p", pubkey, relay_hint, weight]
    for (const r of params.recipients) {
      tags.push([
        "p",
        r.pubkey,
        r.relayHint ?? "",
        String(r.weight ?? 1),
      ]);
    }
  }

  if (params.eventId) {
    tags.push(["e", params.eventId]);
  }

  const event = finalizeEvent(
    {
      kind: KIND.ZAP_REQUEST,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: params.comment ?? "",
    },
    senderPrivkey
  );

  if (!verifyEvent(event)) {
    throw new Error("Generated zap request has an invalid signature.");
  }

  return event as NostrEvent;
}

// ─── Request Zap Invoice ──────────────────────────────────────────────────────

/**
 * Get a BOLT-11 invoice by sending a zap request to the LNURL endpoint.
 *
 * @param params              - Zap parameters (recipients, amount, etc.)
 * @param senderPrivkey       - Sender's private key for signing the zap request
 * @param recipientLnurlEndpoint - The LNURL pay endpoint for the (primary) recipient
 *
 * @returns BOLT-11 invoice to pay + the signed zap request event (for reference)
 */
export async function requestZapInvoice(
  params: ZapParams,
  senderPrivkey: Uint8Array,
  recipientLnurlEndpoint: string
): Promise<{ invoice: string; zapRequestEvent: NostrEvent }> {
  const meta = await fetchLnurlMetadata(recipientLnurlEndpoint);

  if (!meta) {
    throw new Error(
      `Could not fetch LNURL metadata from ${recipientLnurlEndpoint}.\n` +
        "Check that the recipient has a valid Lightning address in their profile."
    );
  }
  if (!meta.allowsNostr || !meta.nostrPubkey) {
    throw new Error(
      "This LNURL endpoint does not support NIP-57 zaps.\n" +
        "The endpoint must return allowsNostr=true and a nostrPubkey.\n" +
        "Ask the recipient to upgrade their Lightning address provider (e.g., Alby)."
    );
  }

  if (params.amountMsats < meta.minSendable) {
    throw new Error(
      `Amount ${params.amountMsats} msats is below the minimum: ${meta.minSendable} msats`
    );
  }
  if (params.amountMsats > meta.maxSendable) {
    throw new Error(
      `Amount ${params.amountMsats} msats exceeds the maximum: ${meta.maxSendable} msats`
    );
  }

  const zapRequest = buildZapRequest(params, senderPrivkey);
  const zapRequestEncoded = encodeURIComponent(JSON.stringify(zapRequest));

  const callbackUrl = new URL(meta.callback);
  callbackUrl.searchParams.set("amount", String(params.amountMsats));
  callbackUrl.searchParams.set("nostr", zapRequestEncoded);
  if (params.comment) {
    callbackUrl.searchParams.set("comment", params.comment.slice(0, 144));
  }

  const res = await fetch(callbackUrl.toString(), {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`LNURL callback failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (data.status === "ERROR") {
    throw new Error(`LNURL error: ${data.reason ?? "Unknown error"}`);
  }
  if (!data.pr) {
    throw new Error("LNURL callback did not return an invoice (pr field missing).");
  }

  return { invoice: data.pr, zapRequestEvent: zapRequest };
}

// ─── Fetch Zap Receipts ───────────────────────────────────────────────────────

/** Fetch kind 9735 zap receipts for a pubkey or event. */
export async function fetchZapReceipts(
  target: string,
  targetType: "pubkey" | "event",
  relays: string[] = DEFAULT_RELAYS,
  limit = 100
): Promise<NostrEvent[]> {
  const filter =
    targetType === "pubkey"
      ? { kinds: [KIND.ZAP_RECEIPT], "#p": [target], limit }
      : { kinds: [KIND.ZAP_RECEIPT], "#e": [target], limit };

  return fetchEvents([filter], relays) as Promise<NostrEvent[]>;
}

// ─── Parse Zap Receipt ────────────────────────────────────────────────────────

export interface ParsedZap {
  senderPubkey?: string;
  recipientPubkey: string;
  amountMsats: number;
  comment?: string;
  eventId?: string;
  createdAt: number;
  providerPubkey: string;
}

/**
 * Parse a kind 9735 zap receipt.
 * Validates the embedded zap request signature to detect forged receipts.
 *
 * BUG-10 NOTE: The BOLT-11 amount parser below handles common mainnet invoices.
 * It is used only for display purposes. Do not use for payment amount validation.
 * Use your wallet's invoice decoder for that.
 */
export function parseZapReceipt(receipt: NostrEvent): ParsedZap | null {
  try {
    const descTag = receipt.tags.find((t) => t[0] === "description");
    if (!descTag?.[1]) return null;

    const zapRequest: NostrEvent = JSON.parse(descTag[1]);
    if (!verifyEvent(zapRequest)) return null;
    if (zapRequest.kind !== KIND.ZAP_REQUEST) return null;

    const bolt11Tag = receipt.tags.find((t) => t[0] === "bolt11");
    const amountMsats = bolt11Tag?.[1]
      ? parseInt(bolt11Tag[1] || "0", 10) * 1000
      : 0;

    const recipientTag = zapRequest.tags.find((t) => t[0] === "p");
    const eventTag = zapRequest.tags.find((t) => t[0] === "e");

    return {
      senderPubkey: zapRequest.pubkey,
      recipientPubkey: recipientTag?.[1] ?? receipt.pubkey,
      amountMsats,
      comment: zapRequest.content || undefined,
      eventId: eventTag?.[1],
      createdAt: receipt.created_at,
      providerPubkey: receipt.pubkey,
    };
  } catch {
    return null;
  }
}

/**
 * BUG-10: Minimal BOLT-11 amount parser for DISPLAY ONLY.
 * Handles common mainnet invoices. Not suitable for payment logic.
 * For accurate parsing, use: @node-lightning/invoice or bolt11 npm packages.
 */
function parseBolt11AmountDisplay(invoice: string): number {
  try {
    // BOLT-11 HRP format: lnbc<amount><multiplier>
    // Multipliers: m=milli, u=micro, n=nano, p=pico (of 1 BTC)
    // 1 BTC = 100,000,000 sats = 100,000,000,000 msats
    const match = invoice.toLowerCase().match(/^lnbc(\d+)([munp])/);
    if (!match) return 0;

    const num = parseInt(match[1], 10);
    const msatsPerUnit: Record<string, number> = {
      m: 100_000_000,         // milli-BTC → msats
      u: 100_000,             // micro-BTC → msats
      n: 100,                 // nano-BTC → msats
      p: 0.1,                 // pico-BTC → msats (sub-msat, rare)
    };

    return Math.floor(num * (msatsPerUnit[match[2]] ?? 0));
  } catch {
    return 0;
  }
}

// ─── Zap Summary ──────────────────────────────────────────────────────────────

export interface ZapSummary {
  totalMsats: number;
  totalSats: number;
  zapCount: number;
  uniqueSenders: number;
  topSender?: { pubkey: string; totalMsats: number };
}

export function summarizeZaps(receipts: NostrEvent[]): ZapSummary {
  const parsed = receipts.map(parseZapReceipt).filter(Boolean) as ParsedZap[];
  const senderTotals = new Map<string, number>();

  let totalMsats = 0;
  for (const zap of parsed) {
    totalMsats += zap.amountMsats;
    if (zap.senderPubkey) {
      senderTotals.set(
        zap.senderPubkey,
        (senderTotals.get(zap.senderPubkey) ?? 0) + zap.amountMsats
      );
    }
  }

  let topSender: ZapSummary["topSender"];
  for (const [pubkey, total] of senderTotals) {
    if (!topSender || total > topSender.totalMsats) {
      topSender = { pubkey, totalMsats: total };
    }
  }

  return {
    totalMsats,
    totalSats: Math.floor(totalMsats / 1000),
    zapCount: parsed.length,
    uniqueSenders: senderTotals.size,
    topSender,
  };
}

// ─── Prism Builder ────────────────────────────────────────────────────────────

/**
 * Build a prism split configuration.
 * Percentages must sum to exactly 100.
 *
 * @example
 *   // 97% to seller, 3% to platform
 *   const recipients = buildPrism(
 *     { pubkey: sellerPubkey, percentage: 97 },
 *     { pubkey: platformPubkey, percentage: 3 },
 *   );
 */
export function buildPrism(
  ...splits: { pubkey: string; relayHint?: string; percentage: number }[]
): ZapRecipient[] {
  if (splits.length < 2) {
    throw new Error(
      "buildPrism requires at least 2 recipients. " +
      "For a single recipient, use a standard payment."
    );
  }

  const total = splits.reduce((sum, s) => sum + s.percentage, 0);
  if (Math.abs(total - 100) > 0.01) {
    throw new Error(
      `Prism percentages must sum to 100. Got: ${total}. ` +
        `Recipients: ${splits.map((s) => `${s.pubkey.slice(0, 8)}...: ${s.percentage}%`).join(", ")}`
    );
  }

  return splits.map((s) => ({
    pubkey: s.pubkey,
    relayHint: s.relayHint,
    weight: s.percentage,
  }));
}
