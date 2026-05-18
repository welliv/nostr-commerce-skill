/**
 * notifications.ts — Real-Time Payment Notifications (Scenario 21)
 *
 * NIPs: NIP-44 (encryption), NIP-59 (gift-wrap), kind 1059
 * Lightning: NWC subscribeNotifications (replaces all polling)
 *
 * CRITICAL: Do NOT poll lookupInvoice or listTransactions on a timer.
 * subscribeNotifications() opens one persistent WebSocket connection
 * and fires callbacks in real time when payments settle.
 * This is the Alby-recommended pattern from their builder skill.
 *
 * Two-layer notification system:
 *
 * Layer 1 — NWC Notifications (merchant's own wallet):
 *   The merchant subscribes to their own wallet via NWC.
 *   When a buyer pays, the merchant's wallet fires immediately.
 *   Zero latency. No Nostr relay involved.
 *
 * Layer 2 — Nostr Gift-Wrap Notifications (cross-client alerts):
 *   After a payment settles, publish an encrypted NIP-59 notification
 *   to the buyer's preferred relays with the preimage and order details.
 *   The buyer's Nostr client receives this — even if they've closed
 *   the checkout page. Persistent, relay-delivered, encrypted.
 */

import type { NotificationPayment } from "./types.js";
import { NostrWalletConnect } from "./nwc.js";
import { sendPaymentRequest } from "./orders.js";
import { getRelaysForUser } from "./relay-discovery.js";
import { DEFAULT_RELAYS } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaymentAlert {
  orderId?: string;
  paymentHash: string;
  preimage: string;
  amountMsats: number;
  type: "incoming" | "outgoing";
  settledAt: number;
  message?: string;
}

export interface NotificationSession {
  close(): void;
  isActive: boolean;
}

// ─── Layer 1: NWC Real-Time Subscription ──────────────────────────────────────

/**
 * Subscribe to real-time payment notifications from a wallet.
 *
 * This is the primary notification mechanism for merchants.
 * Call this once on server startup — it stays open indefinitely.
 *
 * When a buyer pays an invoice:
 *   → onPayment fires within milliseconds
 *   → You get the preimage, amount, and payment hash
 *   → Update order status, release escrow, send gift-wrap notification
 *
 * @example
 *   const session = await subscribeToWalletPayments(wallet, async (payment: any) => {
 *     if (payment.type === "incoming") {
 *       const order = await findOrderByPaymentHash(payment.paymentHash);
 *       if (order) {
 *         await fulfillOrder(order.id, payment.preimage);
 *         await sendBuyerNotification(order, payment, merchantPrivkey);
 *       }
 *     }
 *   });
 *
 *   // Later (server shutdown):
 *   session.close();
 */
export async function subscribeToWalletPayments(
  wallet: NostrWalletConnect,
  onPayment: (payment: NotificationPayment) => void | Promise<void>,
  onError?: (err: Error) => void
): Promise<NotificationSession> {
  let active = true;

  const subscription = await (wallet as any).subscribeNotifications(
    async (payment: any) => {
      try {
        await onPayment(payment);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
    onError
  );

  return {
    close(): void {
      subscription.close();
      active = false;
    },
    get isActive() { return active; },
  };
}

// ─── Layer 2: Nostr Gift-Wrap Payment Confirmation ────────────────────────────

/**
 * Send an encrypted payment confirmation to a buyer via NIP-59 gift-wrap.
 *
 * Call this after a payment settles (from subscribeToWalletPayments callback).
 * The buyer's Nostr client receives the encrypted message with:
 *   - Payment confirmation and preimage
 *   - Order summary
 *   - Next steps (delivery tracking, download link, etc.)
 *
 * The relay sees only: "an event was addressed to this pubkey."
 * Content is fully encrypted — only the buyer can read it.
 *
 * @example
 *   await subscribeToWalletPayments(wallet, async (payment: any) => {
 *     if (payment.type === "incoming") {
 *       await sendBuyerPaymentConfirmation(
 *         { orderId: "order-123", paymentHash: payment.paymentHash,
 *           preimage: payment.preimage, amountMsats: payment.amountMsats,
 *           message: "Your candle ships tomorrow! Tracking: ABC123" },
 *         merchantPrivkey,
 *         buyerPubkey
 *       );
 *     }
 *   });
 */
export async function sendBuyerPaymentConfirmation(
  alert: PaymentAlert,
  merchantPrivkey: Uint8Array,
  buyerPubkey: string,
  relays?: string[]
): Promise<void> {
  // Resolve buyer's preferred relays via NIP-65
  const targetRelays = relays ?? await getRelaysForUser(buyerPubkey).catch(() => DEFAULT_RELAYS);

  // Build the confirmation payload
  const confirmation = {
    type: "payment_confirmation",
    orderId: alert.orderId,
    paymentHash: alert.paymentHash,
    preimage: alert.preimage,         // IMPORTANT: this is proof-of-payment
    amountMsats: alert.amountMsats,
    amountSats: Math.floor(alert.amountMsats / 1000),
    settledAt: alert.settledAt,
    message: alert.message ?? "Payment confirmed! Thank you for your order.",
  };

  // Reuse the gift-wrap infrastructure from orders.ts
  // PaymentRequest type 1 carries the confirmation
  await sendPaymentRequest(
    {
      id: alert.orderId ?? `conf_${Date.now()}`,
      type: 1,
      message: JSON.stringify(confirmation),
      contact: { nostr: buyerPubkey },
      items: [],
      paymentOptions: [],
    },
    merchantPrivkey,
    buyerPubkey,
    targetRelays
  );
}

// ─── Multi-Order Tracking ─────────────────────────────────────────────────────

/**
 * Create a payment tracker that maps payment hashes to order IDs.
 * Use this to correlate incoming payments with specific orders.
 *
 * @example
 *   const tracker = createPaymentTracker();
 *
 *   // When creating an invoice for an order:
 *   const invoice = await wallet.createInvoice({ amountMsats: 25000 });
 *   tracker.register(invoice.paymentHash, "order-123");
 *
 *   // In your subscription:
 *   await subscribeToWalletPayments(wallet, async (payment: any) => {
 *     const orderId = tracker.lookup(payment.paymentHash);
 *     if (orderId) await fulfillOrder(orderId, payment.preimage);
 *   });
 */
export interface PaymentTracker {
  register(paymentHash: string, orderId: string, metadata?: Record<string, unknown>): void;
  lookup(paymentHash: string): string | undefined;
  getMetadata(paymentHash: string): Record<string, unknown> | undefined;
  remove(paymentHash: string): void;
  pendingCount: number;
}

export function createPaymentTracker(): PaymentTracker {
  const _map = new Map<string, { orderId: string; metadata?: Record<string, unknown> }>();

  return {
    register(paymentHash, orderId, metadata) {
      _map.set(paymentHash, { orderId, metadata });
    },
    lookup(paymentHash) {
      return _map.get(paymentHash)?.orderId;
    },
    getMetadata(paymentHash) {
      return _map.get(paymentHash)?.metadata;
    },
    remove(paymentHash) {
      _map.delete(paymentHash);
    },
    get pendingCount() { return _map.size; },
  };
}

// ─── Reconnection Wrapper ─────────────────────────────────────────────────────

/**
 * Subscribe to wallet notifications with automatic reconnection.
 * Network interruptions will re-establish the subscription automatically.
 *
 * Use this for production merchant servers that need guaranteed delivery.
 */
export async function subscribeWithReconnect(
  wallet: NostrWalletConnect,
  onPayment: (payment: NotificationPayment) => void | Promise<void>,
  options: {
    maxRetries?: number;
    retryIntervalMs?: number;
    onReconnect?: () => void;
    onGiveUp?: () => void;
  } = {}
): Promise<NotificationSession> {
  const { maxRetries = 10, retryIntervalMs = 5000, onReconnect, onGiveUp } = options;
  let retries = 0;
  let active = true;
  let currentSub: any = null;

  const connect = async () => {
    currentSub = await (wallet as any).subscribeNotifications(
      onPayment,
      async (err: any) => {
        if (!active) return;
        console.warn("Notification subscription error:", err.message);
        currentSub = null;

        if (retries >= maxRetries) {
          onGiveUp?.();
          return;
        }

        retries++;
        console.log(`Reconnecting (${retries}/${maxRetries}) in ${retryIntervalMs}ms...`);
        await new Promise(r => setTimeout(r, retryIntervalMs));
        if (active) {
          onReconnect?.();
          await connect();
        }
      }
    );
    retries = 0; // reset on successful connection
  };

  await connect();

  return {
    close() {
      active = false;
      currentSub?.close();
    },
    get isActive() { return active; },
  };
}
