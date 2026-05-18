/**
 * orders.ts - Encrypted Order Messaging (Scenario 6)
 *
 * Implements NIP-44 + NIP-59 gift-wrap for fully private order communication.
 * Relay operators see: "a message arrived for pubkey X." Nothing else.
 * Only the recipient can decrypt and read the order or payment request.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import { publishToRelays } from "./relays.js";
import {
  type OrderData,
  type PaymentRequest,
  type PublishResult,
  KIND,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── NIP-44 Encryption ────────────────────────────────────────────────────────

function encrypt44(senderPrivkey: Uint8Array, recipientPubkey: string, plaintext: string): string {
  const key = nip44.getConversationKey(senderPrivkey, recipientPubkey);
  return nip44.encrypt(plaintext, key);
}

function decrypt44(recipientPrivkey: Uint8Array, senderPubkey: string, ciphertext: string): string {
  const key = nip44.getConversationKey(recipientPrivkey, senderPubkey);
  return nip44.decrypt(ciphertext, key);
}

// ─── NIP-59 Gift Wrap ─────────────────────────────────────────────────────────

/**
 * Wrap a message so the sender's identity is hidden from relay operators.
 *
 * Three-layer structure (outside → inside):
 *   Wrap (kind 1059) - signed by a one-time random key
 *     └─ Seal (kind 13) - signed by the real sender, encrypted to recipient
 *         └─ Rumor - the unsigned inner event with the actual content
 *
 * The relay only sees the wrap's random pubkey. The sender's real identity
 * is inside the seal, encrypted with NIP-44. Even the relay operator cannot
 * link the message to a sender.
 */
function giftWrap(
  content: string,
  senderPrivkey: Uint8Array,
  recipientPubkey: string,
  relayHint?: string
): Event {
  const senderPubkey = getPublicKey(senderPrivkey);

  // Inner rumor: the real message (unsigned - no sig on purpose per NIP-59)
  const rumor = {
    kind: KIND.PRIVATE_MESSAGE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientPubkey]],
    content,
    pubkey: senderPubkey,
  };

  // Seal: encrypt the rumor, sign with sender's real key
  const seal = finalizeEvent(
    {
      kind: KIND.SEAL,
      created_at: jitteredTimestamp(),
      tags: [],
      content: encrypt44(senderPrivkey, recipientPubkey, JSON.stringify(rumor)),
    },
    senderPrivkey
  );

  // Wrap: encrypt the seal with a one-time random key, sign with that key
  const wrapKey = generateSecretKey();
  const wrapTags: string[][] = [["p", recipientPubkey]];
  if (relayHint) wrapTags.push(["relay", relayHint]);

  return finalizeEvent(
    {
      kind: KIND.GIFT_WRAP,
      created_at: jitteredTimestamp(),
      tags: wrapTags,
      content: encrypt44(wrapKey, recipientPubkey, JSON.stringify(seal)),
    },
    wrapKey
  ) as Event;
}

/**
 * Slightly randomized timestamp (±2 days) to prevent timing correlation attacks.
 * Per NIP-59 recommendation.
 */
function jitteredTimestamp(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172_800);
}

// ─── Unwrap ───────────────────────────────────────────────────────────────────

/**
 * Unwrap a gift-wrapped message addressed to the recipient.
 * Returns the inner content and the real sender's pubkey.
 *
 * @throws if the event is not addressed to the recipient
 * @throws if the seal signature is invalid (tampering detected)
 */
export function unwrapGiftWrap(
  wrapEvent: Event,
  recipientPrivkey: Uint8Array
): { senderPubkey: string; content: string; createdAt: number } {
  const recipientPubkey = getPublicKey(recipientPrivkey);

  // Verify this wrap is addressed to us
  const pTag = wrapEvent.tags.find((t) => t[0] === "p");
  if (pTag?.[1] !== recipientPubkey) {
    throw new Error("Gift wrap is not addressed to this recipient.");
  }

  // Decrypt wrap → seal
  const sealJson = decrypt44(recipientPrivkey, wrapEvent.pubkey, wrapEvent.content);
  const seal: Event = JSON.parse(sealJson);

  if (!verifyEvent(seal)) {
    throw new Error(
      "Seal signature is invalid. The message may have been tampered with by the relay."
    );
  }

  // Decrypt seal → rumor
  const rumorJson = decrypt44(recipientPrivkey, seal.pubkey, seal.content);
  const rumor = JSON.parse(rumorJson);

  return {
    senderPubkey: seal.pubkey,   // real sender identity - from the seal, not the wrap
    content: rumor.content,
    createdAt: rumor.created_at,
  };
}

// ─── Order Messaging ──────────────────────────────────────────────────────────

/** Send an encrypted order from buyer to merchant. */
export async function sendEncryptedOrder(
  order: OrderData,
  buyerPrivkey: Uint8Array,
  merchantPubkey: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  const wrapped = giftWrap(JSON.stringify(order), buyerPrivkey, merchantPubkey);
  return publishToRelays(wrapped, relays);
}

/** Send an encrypted payment request from merchant to buyer. */
export async function sendPaymentRequest(
  paymentRequest: PaymentRequest,
  merchantPrivkey: Uint8Array,
  buyerPubkey: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  const wrapped = giftWrap(JSON.stringify(paymentRequest), merchantPrivkey, buyerPubkey);
  return publishToRelays(wrapped, relays);
}

/** Decrypt an incoming order (merchant-side). */
export function decryptIncomingOrder(
  wrapEvent: Event,
  merchantPrivkey: Uint8Array
): { order: OrderData; buyerPubkey: string } {
  const { senderPubkey, content } = unwrapGiftWrap(wrapEvent, merchantPrivkey);
  let order: OrderData;
  try {
    order = JSON.parse(content);
  } catch {
    throw new Error("Decrypted content is not valid JSON order data.");
  }
  if (order.type !== 0) {
    throw new Error(`Expected order type 0, received type ${order.type}`);
  }
  return { order, buyerPubkey: senderPubkey };
}

/** Decrypt an incoming payment request (buyer-side). */
export function decryptPaymentRequest(
  wrapEvent: Event,
  buyerPrivkey: Uint8Array
): { paymentRequest: PaymentRequest; merchantPubkey: string } {
  const { senderPubkey, content } = unwrapGiftWrap(wrapEvent, buyerPrivkey);
  let paymentRequest: PaymentRequest;
  try {
    paymentRequest = JSON.parse(content);
  } catch {
    throw new Error("Decrypted content is not valid JSON payment request.");
  }
  return { paymentRequest, merchantPubkey: senderPubkey };
}
