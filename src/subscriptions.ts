/**
 * subscriptions.ts - Recurring Subscriptions (Scenario 15)
 *
 * NIPs: NIP-99 (kind 30402 with frequency tag), NIP-47 (NWC budget permissions)
 * Lightning: Recurring NWC payments with budget cap
 *
 * How subscriptions work on Nostr:
 *   1. Merchant publishes a kind 30402 listing with a price frequency tag
 *      e.g. ["price", "5000", "SATS", "month"]
 *   2. Buyer creates a BUDGETED NWC connection for this subscription.
 *      The budget cap = max sats per period. This is set in Alby Hub.
 *      The buyer controls the cap - they can revoke at any time.
 *   3. App holds the budgeted NWC URL and charges the buyer each period
 *      by calling makeInvoice + payInvoice automatically.
 *   4. The subscription state is a Nostr event (kind 30402 variant) that
 *      the app publishes to relays - visible, auditable, cancellable.
 *
 * Key insight: The NWC budget cap IS the subscription authorization.
 * No Stripe, no billing portal, no hidden charges. The buyer can see
 * exactly what is authorized in their wallet and revoke it instantly.
 *
 * IMPORTANT LIMITATION:
 *   NWC does not have a "charge on schedule" primitive. The app must
 *   hold the budgeted NWC URL and trigger payments on the interval.
 *   This requires a persistent server process. For serverless apps,
 *   use a cron job or scheduled function.
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { NostrWalletConnect } from "./nwc.js";
import { publishToRelays, fetchEvents } from "./relays.js";
import {
  type ListingData,
  type PublishResult,
  type NostrEvent,
  KIND,
  COMMERCE_RELAYS,
} from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SubscriptionFrequency = "hour" | "day" | "week" | "month" | "year";
export type SubscriptionStatus = "active" | "paused" | "cancelled" | "past_due";

export interface SubscriptionPlan {
  dTag: string;
  title: string;
  description: string;
  amountMsats: number;
  currency: string;
  frequency: SubscriptionFrequency;
  features?: string[];
}

export interface SubscriptionRecord {
  id: string;                    // unique subscription ID
  planDTag: string;
  buyerPubkey: string;
  merchantPubkey: string;
  /** Budgeted NWC URL from buyer - used to charge each period */
  buyerNwcUrl: string;
  status: SubscriptionStatus;
  amountMsats: number;
  frequency: SubscriptionFrequency;
  startedAt: number;             // unix timestamp
  nextChargeAt: number;          // unix timestamp
  lastChargedAt?: number;
  lastPaymentHash?: string;
  chargeCount: number;
}

// ─── In-memory store (replace with database in production) ───────────────────

const _subscriptions = new Map<string, SubscriptionRecord>();

export function storeSubscription(sub: SubscriptionRecord): void {
  _subscriptions.set(sub.id, sub);
}

export function getSubscription(id: string): SubscriptionRecord | undefined {
  return _subscriptions.get(id);
}

export function getSubscriptionsByBuyer(pubkey: string): SubscriptionRecord[] {
  return [..._subscriptions.values()].filter(s => s.buyerPubkey === pubkey);
}

export function getSubscriptionsByMerchant(pubkey: string): SubscriptionRecord[] {
  return [..._subscriptions.values()].filter(s => s.merchantPubkey === pubkey);
}

export function getDueSubscriptions(): SubscriptionRecord[] {
  const now = Math.floor(Date.now() / 1000);
  return [..._subscriptions.values()].filter(
    s => s.status === "active" && s.nextChargeAt <= now
  );
}

// ─── Publish Subscription Plan (Merchant) ─────────────────────────────────────

/**
 * Publish a subscription plan as a kind 30402 listing with frequency tag.
 * This is the merchant-side action - making the plan discoverable on relays.
 *
 * @example
 *   await publishSubscriptionPlan(
 *     { dTag: "premium-monthly", title: "Premium Access",
 *       description: "Unlimited API calls + priority support",
 *       amountMsats: 5_000_000, currency: "SATS", frequency: "month" },
 *     merchantPrivkey, relays
 *   );
 */
export async function publishSubscriptionPlan(
  plan: SubscriptionPlan,
  merchantPrivkey: Uint8Array,
  relays: string[] = COMMERCE_RELAYS
): Promise<PublishResult> {
  const tags: string[][] = [
    ["d", plan.dTag],
    ["title", plan.title],
    ["summary", plan.description],
    ["price", String(Math.floor(plan.amountMsats / 1000)), plan.currency, plan.frequency],
    ["type", "subscription"],
    ["published_at", String(Math.floor(Date.now() / 1000))],
  ];

  for (const feature of plan.features ?? []) {
    tags.push(["feature", feature]);
  }

  const event = finalizeEvent(
    { kind: KIND.LISTING_ACTIVE, created_at: Math.floor(Date.now() / 1000), tags, content: plan.description },
    merchantPrivkey
  );

  if (!verifyEvent(event)) throw new Error("Invalid subscription plan event.");
  return publishToRelays(event, relays);
}

// ─── Create Subscription (Buyer) ─────────────────────────────────────────────

/**
 * Create a subscription record when a buyer subscribes to a plan.
 *
 * The buyer provides a BUDGETED NWC URL - a connection to their wallet
 * with a spending cap matching the subscription amount. This URL must be:
 *   1. Created in Alby Hub: App Connections → New Connection
 *   2. Budget set to: plan.amountMsats per period
 *   3. Transmitted securely (encrypted, never logged)
 *
 * The merchant stores this URL and uses it to charge each period.
 *
 * SECURITY: The buyerNwcUrl is extremely sensitive. It grants payment
 * authority up to the budget cap. Store it encrypted, never in plaintext.
 */
export function createSubscription(params: {
  planDTag: string;
  buyerPubkey: string;
  merchantPubkey: string;
  buyerNwcUrl: string;
  amountMsats: number;
  frequency: SubscriptionFrequency;
}): SubscriptionRecord {
  const id = `sub_${params.buyerPubkey.slice(0, 8)}_${params.planDTag}_${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);

  const record: SubscriptionRecord = {
    id,
    planDTag: params.planDTag,
    buyerPubkey: params.buyerPubkey,
    merchantPubkey: params.merchantPubkey,
    buyerNwcUrl: params.buyerNwcUrl,
    status: "active",
    amountMsats: params.amountMsats,
    frequency: params.frequency,
    startedAt: now,
    nextChargeAt: now + frequencyToSeconds(params.frequency),
    chargeCount: 0,
  };

  storeSubscription(record);
  return record;
}

// ─── Charge Subscription ──────────────────────────────────────────────────────

/**
 * Charge a subscription for one period.
 * Called by the merchant's recurring billing process.
 *
 * Flow:
 *   1. Merchant creates an invoice for the subscription amount
 *   2. Buyer's budgeted NWC pays the invoice automatically
 *   3. Record is updated with charge timestamp and payment hash
 *   4. Next charge time is advanced by one period
 *
 * Run this function on a schedule for all due subscriptions.
 * See getDueSubscriptions() to find which ones are ready.
 */
export async function chargeSubscription(
  subscriptionId: string,
  merchantWallet: NostrWalletConnect
): Promise<{ preimage: string; paymentHash: string }> {
  const sub = getSubscription(subscriptionId);
  if (!sub) throw new Error(`Subscription ${subscriptionId} not found.`);
  if (sub.status !== "active") {
    throw new Error(`Cannot charge subscription with status: ${sub.status}`);
  }

  // Step 1: Merchant creates invoice
  const invoice = await merchantWallet.createInvoice({
    amountMsats: sub.amountMsats,
    description: `Subscription: ${sub.planDTag} - period ${sub.chargeCount + 1}`,
    expiry: 3600,
  });

  // Step 2: Buyer's budgeted NWC pays it
  const buyerWallet = new NostrWalletConnect(sub.buyerNwcUrl);
  await buyerWallet.connect();

  let preimage: string;
  let paymentHash: string;

  try {
    const result = await buyerWallet.payInvoice(invoice.invoice);
    preimage = result.preimage;
    paymentHash = result.paymentHash;
  } finally {
    await buyerWallet.disconnect();
  }

  // Step 3: Update subscription record
  const now = Math.floor(Date.now() / 1000);
  sub.lastChargedAt = now;
  sub.lastPaymentHash = paymentHash;
  sub.nextChargeAt = now + frequencyToSeconds(sub.frequency);
  sub.chargeCount++;
  storeSubscription(sub);

  return { preimage, paymentHash };
}

// ─── Manage Subscription ──────────────────────────────────────────────────────

/** Pause a subscription (buyer or merchant can call this). */
export function pauseSubscription(id: string): SubscriptionRecord {
  const sub = getSubscription(id);
  if (!sub) throw new Error(`Subscription ${id} not found.`);
  if (sub.status !== "active") throw new Error(`Cannot pause: status is "${sub.status}"`);
  sub.status = "paused";
  storeSubscription(sub);
  return sub;
}

/** Resume a paused subscription. Resets nextChargeAt to now + period. */
export function resumeSubscription(id: string): SubscriptionRecord {
  const sub = getSubscription(id);
  if (!sub) throw new Error(`Subscription ${id} not found.`);
  if (sub.status !== "paused") throw new Error(`Cannot resume: status is "${sub.status}"`);
  sub.status = "active";
  sub.nextChargeAt = Math.floor(Date.now() / 1000) + frequencyToSeconds(sub.frequency);
  storeSubscription(sub);
  return sub;
}

/** Cancel a subscription. Irreversible - buyer must re-subscribe. */
export function cancelSubscription(id: string): SubscriptionRecord {
  const sub = getSubscription(id);
  if (!sub) throw new Error(`Subscription ${id} not found.`);
  if (sub.status === "cancelled") throw new Error("Already cancelled.");
  sub.status = "cancelled";
  storeSubscription(sub);
  return sub;
}

// ─── Fetch Subscription Plans ─────────────────────────────────────────────────

/** Fetch subscription plan listings from a merchant. */
export async function fetchSubscriptionPlans(
  merchantPubkey: string,
  relays: string[] = COMMERCE_RELAYS
): Promise<NostrEvent[]> {
  const events = await fetchEvents(
    [{ authors: [merchantPubkey], kinds: [KIND.LISTING_ACTIVE], limit: 100 }],
    relays
  ) as NostrEvent[];

  // Filter for subscription listings (have a price tag with frequency)
  return events.filter(e =>
    e.tags.some(t => t[0] === "price" && t[3] !== undefined) ||
    e.tags.some(t => t[0] === "type" && t[1] === "subscription")
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function frequencyToSeconds(f: SubscriptionFrequency): number {
  const map: Record<SubscriptionFrequency, number> = {
    hour:   3_600,
    day:    86_400,
    week:   604_800,
    month:  2_592_000,   // 30 days
    year:   31_536_000,  // 365 days
  };
  return map[f];
}

export function describeSubscription(sub: SubscriptionRecord): string {
  const next = new Date(sub.nextChargeAt * 1000).toLocaleString();
  const statusLabels: Record<SubscriptionStatus, string> = {
    active:   `✅ Active - next charge: ${next}`,
    paused:   `⏸️  Paused - next charge paused`,
    cancelled:`❌ Cancelled`,
    past_due: `⚠️  Past due - last charge failed`,
  };
  return `${statusLabels[sub.status]} | ${Math.floor(sub.amountMsats/1000)} sats/${sub.frequency} | ${sub.chargeCount} charges`;
}
