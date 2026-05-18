/**
 * cart.ts - Multi-Merchant Cart & Payment Forwarding (Scenario 16)
 *
 * NIPs: NIP-99 (listings), NIP-57 (zap splits for routing)
 * Lightning: Multi-route payments via zap prisms or sequential invoices
 *
 * How multi-merchant carts work:
 *   Traditional: 3 sellers = 3 separate checkouts. Friction kills conversion.
 *   Nostr: 1 cart event referencing listings from multiple merchants.
 *
 * Two payment strategies:
 *
 *   Strategy A - PRISM (preferred when all sellers have LNURL):
 *     Build a zap prism with weighted splits matching each seller's price.
 *     One payment splits atomically. Zero custody. No coordination.
 *     Works when all sellers have a Lightning address in their kind 0 profile.
 *
 *   Strategy B - SEQUENTIAL (fallback):
 *     Generate one invoice per seller, pay them sequentially.
 *     Works universally but creates multiple payment steps.
 *     Wrap in a cart event so the buyer sees it as a single checkout.
 *
 * The cart itself is a Nostr-native construct: a signed event listing
 * references to product events from any pubkey on any relay. No platform
 * owns the cart. It expires with NIP-40.
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { publishToRelays, fetchEventById } from "./relays.js";
import { NostrWalletConnect } from "./nwc.js";
import { resolveLnurlFromProfile } from "./zaps.js";
import {
  type PublishResult,
  type NostrEvent,
  KIND,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CartItem {
  /** Event ID of the kind 30402 product listing */
  listingEventId: string;
  /** Merchant's pubkey */
  merchantPubkey: string;
  quantity: number;
  /** Price at time of adding to cart (msats) */
  amountMsats: number;
  /** Relay where listing was found */
  relayHint?: string;
}

export interface Cart {
  id: string;
  buyerPubkey: string;
  items: CartItem[];
  createdAt: number;
  /** NIP-40: cart auto-expires (24h default) */
  expiresAt: number;
  note?: string;
}

export type CartPaymentStrategy = "prism" | "sequential";

export interface CartPaymentResult {
  strategy: CartPaymentStrategy;
  totalMsats: number;
  payments: {
    merchantPubkey: string;
    amountMsats: number;
    paymentHash?: string;
    preimage?: string;
    status: "paid" | "failed";
    error?: string;
  }[];
  successCount: number;
  failureCount: number;
}

// ─── Build Cart ───────────────────────────────────────────────────────────────

/**
 * Create a cart from a list of items.
 * Validates quantities and calculates total.
 */
export function buildCart(
  buyerPubkey: string,
  items: CartItem[],
  note?: string,
  ttlSeconds = 86_400
): Cart {
  if (items.length === 0) throw new Error("Cart must contain at least one item.");

  const totalItems = items.reduce((s, i) => s + i.quantity, 0);
  if (totalItems === 0) throw new Error("Total quantity must be > 0.");

  return {
    id: `cart_${buyerPubkey.slice(0, 8)}_${Date.now()}`,
    buyerPubkey,
    items,
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    note,
  };
}

// ─── Publish Cart Event ───────────────────────────────────────────────────────

/**
 * Publish a cart as a Nostr event.
 * This makes the cart visible to merchants and creates a permanent record.
 *
 * The cart event references each listing via "e" tags.
 * Merchants subscribe to events tagged with their pubkey to see orders.
 */
export async function publishCartEvent(
  cart: Cart,
  buyerPrivkey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  const tags: string[][] = [
    ["d", cart.id],
    ["expiration", String(cart.expiresAt)], // NIP-40
  ];

  // Reference each listing and tag each merchant
  for (const item of cart.items) {
    tags.push(["e", item.listingEventId, item.relayHint ?? "", "listing"]);
    tags.push(["p", item.merchantPubkey]);
    tags.push(["quantity", item.listingEventId, String(item.quantity)]);
  }

  const event = finalizeEvent(
    {
      kind: KIND.APP_DATA, // kind 30078
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify({
        cartId: cart.id,
        items: cart.items.map(i => ({ listingEventId: i.listingEventId, quantity: i.quantity, amountMsats: i.amountMsats })),
        totalMsats: cart.items.reduce((s, i) => s + i.amountMsats * i.quantity, 0),
        note: cart.note,
        expiresAt: cart.expiresAt,
      }),
    },
    buyerPrivkey
  );

  if (!verifyEvent(event)) throw new Error("Invalid cart event signature.");
  return publishToRelays(event, relays);
}

// ─── Resolve Payment Strategy ─────────────────────────────────────────────────

/**
 * Determine the best payment strategy for a cart.
 * Prism is preferred (atomic, zero custody) but requires all sellers
 * to have a Lightning address in their profile.
 */
export async function resolvePaymentStrategy(
  cart: Cart,
  relays: string[] = DEFAULT_RELAYS
): Promise<CartPaymentStrategy> {
  const lnurlChecks = await Promise.all(
    cart.items.map(item => resolveLnurlFromProfile(item.merchantPubkey, relays))
  );
  const allHaveLnurl = lnurlChecks.every(url => url !== null);
  return allHaveLnurl ? "prism" : "sequential";
}

// ─── Pay Cart - Sequential (Universal Fallback) ───────────────────────────────

/**
 * Pay a cart by generating and paying one invoice per merchant sequentially.
 * Works universally - no LNURL required.
 *
 * The buyer's wallet is charged once per seller.
 * This is the correct fallback when prism is not possible.
 */
export async function payCartSequential(
  cart: Cart,
  merchantWallets: Map<string, NostrWalletConnect>,
  buyerWallet: NostrWalletConnect
): Promise<CartPaymentResult> {
  const payments: CartPaymentResult["payments"] = [];
  let successCount = 0, failureCount = 0;

  // Group items by merchant
  const byMerchant = new Map<string, CartItem[]>();
  for (const item of cart.items) {
    if (!byMerchant.has(item.merchantPubkey)) byMerchant.set(item.merchantPubkey, []);
    byMerchant.get(item.merchantPubkey)!.push(item);
  }

  for (const [merchantPubkey, items] of byMerchant) {
    const totalMsats = items.reduce((s, i) => s + i.amountMsats * i.quantity, 0);
    const merchantWallet = merchantWallets.get(merchantPubkey);

    if (!merchantWallet) {
      payments.push({ merchantPubkey, amountMsats: totalMsats, status: "failed", error: "No wallet configured for merchant" });
      failureCount++;
      continue;
    }

    try {
      // Merchant creates invoice
      const invoice = await merchantWallet.createInvoice({
        amountMsats: totalMsats,
        description: `Cart payment - ${cart.id}`,
        expiry: 600,
      });

      // Buyer pays it
      const result = await buyerWallet.payInvoice(invoice.invoice);
      payments.push({ merchantPubkey, amountMsats: totalMsats, paymentHash: result.paymentHash, preimage: result.preimage, status: "paid" });
      successCount++;
    } catch (err) {
      payments.push({ merchantPubkey, amountMsats: totalMsats, status: "failed", error: err instanceof Error ? err.message : String(err) });
      failureCount++;
    }
  }

  const totalMsats = cart.items.reduce((s, i) => s + i.amountMsats * i.quantity, 0);
  return { strategy: "sequential", totalMsats, payments, successCount, failureCount };
}

// ─── Pay Cart - Prism (Atomic Split) ──────────────────────────────────────────

/**
 * Pay a cart via a zap prism - one payment splits atomically to all sellers.
 *
 * Requires all sellers to have a Lightning address (lud16) in their profile.
 * Use resolvePaymentStrategy() first to confirm prism is viable.
 *
 * The zap request includes all merchant pubkeys with weights proportional
 * to their cart total. The LNURL provider routes payments atomically.
 */
export async function payCartPrism(
  cart: Cart,
  buyerWallet: NostrWalletConnect,
  buyerPrivkey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<CartPaymentResult> {
  const { requestZapInvoice, buildPrism } = await import("./zaps.js");

  // Calculate per-merchant totals
  const merchantTotals = new Map<string, number>();
  let grandTotal = 0;
  for (const item of cart.items) {
    const amount = item.amountMsats * item.quantity;
    merchantTotals.set(item.merchantPubkey, (merchantTotals.get(item.merchantPubkey) ?? 0) + amount);
    grandTotal += amount;
  }

  // Resolve LNURL endpoints for all merchants
  const merchantEndpoints = new Map<string, string>();
  for (const pubkey of merchantTotals.keys()) {
    const endpoint = await resolveLnurlFromProfile(pubkey, relays);
    if (!endpoint) throw new Error(`Merchant ${pubkey.slice(0, 8)}... has no Lightning address. Use sequential payment.`);
    merchantEndpoints.set(pubkey, endpoint);
  }

  // Build prism splits (percentage-based)
  const splits = [...merchantTotals.entries()].map(([pubkey, amount]) => ({
    pubkey,
    percentage: (amount / grandTotal) * 100,
  }));

  const recipients = buildPrism(...splits);

  // Use first merchant's LNURL endpoint for the zap request
  const firstEndpoint = [...merchantEndpoints.values()][0];
  const { invoice } = await requestZapInvoice(
    { recipients, amountMsats: grandTotal, relays, comment: `Cart: ${cart.id}` },
    buyerPrivkey,
    firstEndpoint
  );

  const result = await buyerWallet.payInvoice(invoice);

  const payments: CartPaymentResult["payments"] = [...merchantTotals.entries()].map(([pubkey, amount]) => ({
    merchantPubkey: pubkey,
    amountMsats: amount,
    paymentHash: result.paymentHash,
    preimage: result.preimage,
    status: "paid" as const,
  }));

  return { strategy: "prism", totalMsats: grandTotal, payments, successCount: payments.length, failureCount: 0 };
}

// ─── Cart Summary ─────────────────────────────────────────────────────────────

export function summarizeCart(cart: Cart): {
  totalMsats: number;
  totalSats: number;
  itemCount: number;
  merchantCount: number;
  isExpired: boolean;
} {
  const totalMsats = cart.items.reduce((s, i) => s + i.amountMsats * i.quantity, 0);
  const merchants = new Set(cart.items.map(i => i.merchantPubkey));
  const now = Math.floor(Date.now() / 1000);

  return {
    totalMsats,
    totalSats: Math.floor(totalMsats / 1000),
    itemCount: cart.items.reduce((s, i) => s + i.quantity, 0),
    merchantCount: merchants.size,
    isExpired: cart.expiresAt < now,
  };
}
