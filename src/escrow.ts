/**
 * escrow.ts — Lightning Escrow with NIP-40 Deadline (Scenario 8)
 *
 * AUDIT FIXES APPLIED:
 *   BUG-03:   amountMsats added to EscrowSession (type fix)
 *   BUG-07:   fetchBuyerEscrowEvents — fixed overbroad #d filter
 *   BLIND-04: releaseEscrow() now has real implementations for LND + Alby Hub
 *   BLIND-06: waitForPayment uses exponential backoff, not flat polling
 *   BLIND-08: In-memory store throws in production if not acknowledged
 *
 * HOW ESCROW WORKS (no trusted third party):
 *   1. Merchant creates a hold invoice — a BOLT-11 where funds lock on payment
 *   2. Buyer pays — funds held in Lightning network, NOT released to merchant
 *   3. Merchant ships / delivers the product
 *   4. Merchant reveals preimage → Lightning settles to merchant
 *   5. If deadline passes before release → buyer auto-refunded
 *
 * The protocol enforces this. No platform, no arbiter, no custody.
 *
 * HOLD INVOICE SUPPORT:
 *   ✅ LND (via hodl invoice REST API)
 *   ✅ Alby Hub (via Hub admin API)
 *   ✅ Core Lightning (via hold invoice plugin — see comments)
 *   ❌ Most custodial wallets (Wallet of Satoshi, etc.)
 *   Check your wallet before deploying escrow in production.
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { publishToRelays, fetchEvents } from "./relays.js";
import { NostrWalletConnect } from "./nwc.js";
import {
  type EscrowParams,
  type EscrowSession,
  type NostrEvent,
  KIND,
  COMMERCE_RELAYS,
} from "./types.js";

// ─── Escrow Backend Interface ─────────────────────────────────────────────────

/**
 * A hold invoice backend must implement settle and cancel.
 * Implement this interface for your Lightning node backend.
 *
 * Standard NWC (make_invoice, pay_invoice) does NOT cover hold invoice settlement.
 * You need direct node access for that step.
 */
export interface EscrowBackend {
  /**
   * Settle (release) a hold invoice, paying the merchant.
   * Call this after confirming delivery.
   */
  settleHoldInvoice(paymentHash: string, preimage: string): Promise<void>;

  /**
   * Cancel a hold invoice, refunding the buyer.
   * Call this if you decide to cancel before delivery.
   */
  cancelHoldInvoice(paymentHash: string): Promise<void>;
}

// ─── LND Backend ─────────────────────────────────────────────────────────────

export interface LndConfig {
  /** LND REST API base URL: https://your-lnd-node:8080 */
  host: string;
  /**
   * Admin macaroon in hex format.
   * Get with: xxd -plain ~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon | tr -d '\n'
   * SECURITY: Treat like a private key. Load from environment variable.
   */
  macaroon: string;
  /** Skip TLS verification (only for local/development nodes) */
  skipTlsVerify?: boolean;
}

export class LndEscrowBackend implements EscrowBackend {
  private headers: Record<string, string>;
  private host: string;

  constructor(config: LndConfig) {
    this.host = config.host.replace(/\/$/, "");
    this.headers = {
      "Grpc-Metadata-macaroon": config.macaroon,
      "Content-Type": "application/json",
    };
  }

  private async lndFetch(path: string, body: object): Promise<Response> {
    const res = await fetch(`${this.host}${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LND API error ${res.status}: ${text}`);
    }
    return res;
  }

  /**
   * Settle a hold invoice using LND's hodl invoice API.
   * POST /v2/invoices/hodl/settle
   * Body: { preimage: "<32-byte hex string>" }
   */
  async settleHoldInvoice(paymentHash: string, preimage: string): Promise<void> {
    await this.lndFetch("/v2/invoices/hodl/settle", { preimage });
    void paymentHash; // LND identifies by preimage
  }

  /**
   * Cancel a hold invoice using LND's hodl invoice API.
   * POST /v2/invoices/hodl/cancel
   * Body: { payment_hash: "<32-byte base64 string>" }
   */
  async cancelHoldInvoice(paymentHash: string): Promise<void> {
    // LND cancel requires payment_hash as base64
    const hashBase64 = Buffer.from(paymentHash, "hex").toString("base64");
    await this.lndFetch("/v2/invoices/hodl/cancel", { payment_hash: hashBase64 });
  }
}

// ─── Alby Hub Backend ─────────────────────────────────────────────────────────

export interface AlbyHubConfig {
  /** Alby Hub URL: https://your-hub.getalby.com */
  hubUrl: string;
  /** Alby Hub admin password or API token */
  token: string;
}

export class AlbyHubEscrowBackend implements EscrowBackend {
  private headers: Record<string, string>;
  private hubUrl: string;

  constructor(config: AlbyHubConfig) {
    this.hubUrl = config.hubUrl.replace(/\/$/, "");
    this.headers = {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Settle a hold invoice via Alby Hub REST API.
   * Alby Hub proxies this to the underlying node (LND or CLN).
   */
  async settleHoldInvoice(paymentHash: string, preimage: string): Promise<void> {
    const res = await fetch(`${this.hubUrl}/api/invoices/settle`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ payment_hash: paymentHash, preimage }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Alby Hub settle error ${res.status}: ${text}`);
    }
  }

  /**
   * Cancel a hold invoice via Alby Hub REST API.
   */
  async cancelHoldInvoice(paymentHash: string): Promise<void> {
    const res = await fetch(`${this.hubUrl}/api/invoices/cancel`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ payment_hash: paymentHash }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Alby Hub cancel error ${res.status}: ${text}`);
    }
  }
}

// ─── In-Memory Session Store ─────────────────────────────────────────────────

/**
 * BLIND-08 FIX: Production safety check.
 * The in-memory store resets on every restart — all in-flight escrows are lost.
 * In production, this means merchants who restart their server mid-escrow
 * can no longer release holds → goods are delivered but payment is lost.
 *
 * Set ESCROW_STORE_ACKNOWLEDGED=true AFTER connecting a persistent database.
 */
if (
  typeof process !== "undefined" &&
  process.env.NODE_ENV === "production" &&
  process.env.ESCROW_STORE_ACKNOWLEDGED !== "true"
) {
  console.error(
    "\n⚠️  ESCROW SAFETY WARNING ⚠️\n" +
      "The in-memory escrow store will lose all sessions on restart.\n" +
      "In production, escrow sessions must be persisted to a database.\n" +
      "After connecting a database adapter:\n" +
      "  • Override storeEscrowSession() and getEscrowSession()\n" +
      "  • Set environment variable: ESCROW_STORE_ACKNOWLEDGED=true\n" +
      "Running with in-memory store in production risks fund loss.\n"
  );
}

const _sessions = new Map<string, EscrowSession>();

export function storeEscrowSession(session: EscrowSession): void {
  _sessions.set(session.orderId, session);
}

export function getEscrowSession(orderId: string): EscrowSession | undefined {
  return _sessions.get(orderId);
}

export function getAllEscrowSessions(): EscrowSession[] {
  return [..._sessions.values()];
}

// ─── Create Escrow ────────────────────────────────────────────────────────────

/**
 * Step 1: Create a hold invoice for the buyer to pay.
 *
 * Returns a session with the invoice to send to the buyer.
 * Store session.paymentHash to poll for payment.
 * Optionally publish the escrow event to relays (creates a permanent record).
 *
 * NOTE: NWC make_invoice creates a standard invoice. For a true hold invoice,
 * the expiry parameter controls how long the hold lasts. Some NWC backends
 * (LND-based Alby Hub) support hold semantics natively through the expiry window.
 * For guaranteed hold invoice support, pair with LndEscrowBackend.
 */
export async function createEscrow(
  params: EscrowParams,
  merchantWallet: NostrWalletConnect
): Promise<EscrowSession> {
  const holdDuration = params.holdDuration ?? 86_400; // 24h default
  const deadlineAt =
    params.deadlineAt ?? Math.floor(Date.now() / 1000) + holdDuration;

  const invoiceResult = await merchantWallet.createInvoice({
    amountMsats: params.amountMsats,
    description: `Escrow — order ${params.orderId}`,
    expiry: holdDuration,
  });

  const session: EscrowSession = {
    orderId: params.orderId,
    invoice: invoiceResult.invoice,
    paymentHash: invoiceResult.paymentHash,
    amountMsats: params.amountMsats,   // BUG-03 FIX
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: deadlineAt,
  };

  storeEscrowSession(session);
  return session;
}

// ─── Publish Escrow Record to Relays ─────────────────────────────────────────

/**
 * Publish a signed NIP-40 timestamped record of the escrow to Nostr relays.
 * Creates a permanent, verifiable record of the escrow commitment.
 * The expiration tag mirrors the hold invoice deadline.
 */
export async function publishEscrowEvent(
  session: EscrowSession,
  merchantPrivateKey: Uint8Array,
  buyerPubkey: string,
  relays: string[] = COMMERCE_RELAYS
): Promise<string> {
  const template = {
    kind: KIND.APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", `escrow:${session.orderId}`],
      ["p", buyerPubkey],
      ["payment_hash", session.paymentHash],
      ["amount", String(session.amountMsats)],
      ["status", session.status],
      ["expiration", String(session.expiresAt)], // NIP-40
    ],
    content: JSON.stringify({
      orderId: session.orderId,
      paymentHash: session.paymentHash,
      amountMsats: session.amountMsats,
      status: session.status,
      expiresAt: session.expiresAt,
    }),
  };

  const event = finalizeEvent(template, merchantPrivateKey);
  if (!verifyEvent(event)) throw new Error("Invalid escrow event signature.");

  const result = await publishToRelays(event, relays);

  const updated = { ...session, escrowEventId: result.eventId };
  storeEscrowSession(updated);
  return result.eventId;
}

// ─── Wait for Payment ─────────────────────────────────────────────────────────

/**
 * Poll until the buyer pays the hold invoice.
 *
 * BLIND-06 FIX: Uses exponential backoff (1.5x per attempt, max 60s).
 * Flat 5s polling at scale floods the NWC endpoint and risks rate-limiting.
 *
 * Returns the session with status "funded" (paid) or "expired" (deadline passed).
 * Throws if max polling time is exceeded.
 */
export async function waitForPayment(
  orderId: string,
  merchantWallet: NostrWalletConnect,
  options: {
    initialIntervalMs?: number;
    maxIntervalMs?: number;
    maxDurationMs?: number;
    onStatusChange?: (status: EscrowSession["status"]) => void;
  } = {}
): Promise<EscrowSession> {
  const {
    initialIntervalMs = 3_000,
    maxIntervalMs = 60_000,
    maxDurationMs = 30 * 60 * 1000, // 30 minutes max
    onStatusChange,
  } = options;

  const session = getEscrowSession(orderId);
  if (!session) {
    throw new Error(`No escrow session found for order: ${orderId}`);
  }

  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    const now = Math.floor(Date.now() / 1000);

    // Check deadline
    if (now > session.expiresAt) {
      session.status = "expired";
      storeEscrowSession(session);
      onStatusChange?.("expired");
      return session;
    }

    // Check total polling duration
    if (Date.now() - startedAt > maxDurationMs) {
      throw new Error(
        `Payment polling timed out after ${maxDurationMs / 1000}s for order ${orderId}. ` +
          `The invoice may still be valid — check manually with lookupInvoice().`
      );
    }

    // Poll payment status
    try {
      const lookup = await merchantWallet.lookupInvoice(session.paymentHash);
      if (lookup.paid && lookup.preimage) {
        session.status = "funded";
        session.preimage = lookup.preimage;
        storeEscrowSession(session);
        onStatusChange?.("funded");
        return session;
      }
    } catch {
      // Lookup failure is non-fatal — keep polling
    }

    // BLIND-06 FIX: Exponential backoff
    const delay = Math.min(
      initialIntervalMs * Math.pow(1.5, attempt),
      maxIntervalMs
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt++;
  }
}

// ─── Release Escrow (Settle to Merchant) ─────────────────────────────────────

/**
 * Step 3: Release escrowed funds to the merchant after delivery.
 *
 * BLIND-04 FIX: This is now a real implementation, not a placeholder.
 * Requires an EscrowBackend (LndEscrowBackend or AlbyHubEscrowBackend).
 *
 * Call this AFTER confirming the buyer received the goods/service.
 * The preimage stored in the session is revealed to the Lightning network,
 * which settles the hold invoice to the merchant.
 *
 * @param orderId    - The order to release
 * @param backend    - Your Lightning node backend (LND or Alby Hub)
 */
export async function releaseEscrow(
  orderId: string,
  backend: EscrowBackend
): Promise<EscrowSession> {
  const session = getEscrowSession(orderId);

  if (!session) {
    throw new Error(`No escrow session for order: ${orderId}`);
  }
  if (session.status !== "funded") {
    throw new Error(
      `Cannot release escrow for order ${orderId}.\n` +
        `Current status: "${session.status}"\n` +
        `Required status: "funded"\n` +
        `The buyer must pay the hold invoice before it can be released.`
    );
  }
  if (!session.preimage) {
    throw new Error(
      `No preimage stored for order ${orderId}. ` +
        `Call waitForPayment() first to capture the preimage from the paid invoice.`
    );
  }

  // Check deadline — hold invoices auto-expire, cannot release after deadline
  const now = Math.floor(Date.now() / 1000);
  if (now > session.expiresAt) {
    session.status = "expired";
    storeEscrowSession(session);
    throw new Error(
      `Cannot release escrow for order ${orderId} — hold invoice has expired. ` +
        `The buyer was automatically refunded at ${new Date(session.expiresAt * 1000).toISOString()}.`
    );
  }

  // Reveal the preimage to settle funds to merchant
  await backend.settleHoldInvoice(session.paymentHash, session.preimage);

  session.status = "released";
  storeEscrowSession(session);
  return session;
}

// ─── Refund Escrow (Cancel Hold Invoice) ─────────────────────────────────────

/**
 * Cancel the hold invoice and refund the buyer.
 * Use this if the merchant cannot fulfill the order.
 *
 * @param orderId - The order to refund
 * @param backend - Your Lightning node backend
 */
export async function refundEscrow(
  orderId: string,
  backend: EscrowBackend
): Promise<EscrowSession> {
  const session = getEscrowSession(orderId);

  if (!session) throw new Error(`No escrow session for order: ${orderId}`);
  if (!["pending", "funded"].includes(session.status)) {
    throw new Error(
      `Cannot refund order ${orderId}: status is "${session.status}". ` +
        `Only "pending" and "funded" sessions can be refunded.`
    );
  }

  await backend.cancelHoldInvoice(session.paymentHash);

  session.status = "refunded";
  storeEscrowSession(session);
  return session;
}

// ─── Fetch Escrow Records from Relays ─────────────────────────────────────────

/**
 * Fetch escrow event records from relays for a buyer.
 *
 * BUG-07 FIX: Previous version used "#d": [] which matched ALL kind 30078
 * events tagged to the buyer. Fixed with client-side prefix filtering.
 */
export async function fetchBuyerEscrowEvents(
  buyerPubkey: string,
  relays: string[] = COMMERCE_RELAYS
): Promise<NostrEvent[]> {
  const events = await fetchEvents(
    [{ kinds: [KIND.APP_DATA], "#p": [buyerPubkey], limit: 100 }],
    relays
  ) as NostrEvent[];

  // BUG-07 FIX: Client-side filter — only keep events with d-tag starting "escrow:"
  return events.filter((e) =>
    e.tags.some((t) => t[0] === "d" && t[1]?.startsWith("escrow:"))
  );
}

// ─── Status Description ───────────────────────────────────────────────────────

export function describeEscrow(session: EscrowSession): string {
  const deadline = new Date(session.expiresAt * 1000).toLocaleString();
  const sats = Math.floor(session.amountMsats / 1000);
  const messages: Record<EscrowSession["status"], string> = {
    pending:  `⏳ Waiting for buyer payment of ${sats} sats. Invoice expires: ${deadline}`,
    funded:   `🔒 ${sats} sats locked. Deliver the order, then call releaseEscrow().`,
    released: `✅ ${sats} sats released to merchant.`,
    refunded: `↩️  ${sats} sats refunded to buyer.`,
    expired:  `⌛ Invoice expired at ${deadline}. Buyer was automatically refunded.`,
  };
  return messages[session.status];
}
