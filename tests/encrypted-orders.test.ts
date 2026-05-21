/**
 * Scenario 6: Encrypted Orders (NIP-44 + NIP-59)
 * Three-layer gift wrap: Wrap (kind 1059) → Seal (kind 13) → Rumor.
 * Relay operators see only the ephemeral wrap pubkey — not the real sender.
 */
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { giftWrap, unwrapGiftWrap, decryptIncomingOrder } from '../src/orders';

function makeKeyPair() {
  const privateKey = generateSecretKey();
  return { privateKey, publicKey: getPublicKey(privateKey) };
}

describe('Scenario 6: Encrypted Orders', () => {
  describe('giftWrap', () => {
    it('produces a kind 1059 event', () => {
      const sender = makeKeyPair();
      const recipient = makeKeyPair();
      const wrap = giftWrap('hello', sender.privateKey, recipient.publicKey);
      expect(wrap.kind).toBe(1059);
    });

    it('wrap pubkey is NOT the real sender (sender is anonymous to relay)', () => {
      const sender = makeKeyPair();
      const recipient = makeKeyPair();
      const wrap = giftWrap('hello', sender.privateKey, recipient.publicKey);
      expect(wrap.pubkey).not.toBe(sender.publicKey);
    });

    it('wrap is addressed to recipient via p-tag', () => {
      const sender = makeKeyPair();
      const recipient = makeKeyPair();
      const wrap = giftWrap('hello', sender.privateKey, recipient.publicKey);
      const pTag = wrap.tags.find(t => t[0] === 'p');
      expect(pTag?.[1]).toBe(recipient.publicKey);
    });

    it('timestamp jitter: five wraps have varied timestamps', () => {
      const sender = makeKeyPair();
      const recipient = makeKeyPair();
      const now = Math.floor(Date.now() / 1000);
      const timestamps = Array.from({ length: 5 }, () =>
        giftWrap('test', sender.privateKey, recipient.publicKey).created_at
      );
      const allSame = timestamps.every(t => t === timestamps[0]);
      expect(allSame).toBe(false); // at least some variance
      timestamps.forEach(t => {
        expect(t).toBeLessThanOrEqual(now + 1);
        expect(t).toBeGreaterThan(now - 3 * 24 * 60 * 60); // within 3 days
      });
    });
  });

  describe('unwrapGiftWrap', () => {
    it('full roundtrip: recipient recovers original content', () => {
      const sender = makeKeyPair();
      const recipient = makeKeyPair();
      const wrap = giftWrap('Order #001 — 2x Candles', sender.privateKey, recipient.publicKey);
      const result = unwrapGiftWrap(wrap, recipient.privateKey);
      expect(result.content).toBe('Order #001 — 2x Candles');
    });

    it('reveals real sender pubkey (not the ephemeral wrap pubkey)', () => {
      const sender = makeKeyPair();
      const recipient = makeKeyPair();
      const wrap = giftWrap('msg', sender.privateKey, recipient.publicKey);
      const result = unwrapGiftWrap(wrap, recipient.privateKey);
      expect(result.senderPubkey).toBe(sender.publicKey);
      expect(result.senderPubkey).not.toBe(wrap.pubkey);
    });

    it('throws when opened by the wrong recipient', () => {
      const sender = makeKeyPair();
      const intended = makeKeyPair();
      const eavesdropper = makeKeyPair();
      const wrap = giftWrap('secret', sender.privateKey, intended.publicKey);
      expect(() => unwrapGiftWrap(wrap, eavesdropper.privateKey)).toThrow();
    });
  });

  describe('decryptIncomingOrder', () => {
    it('merchant decrypts a buyer order and gets OrderData + buyerPubkey', () => {
      const buyer = makeKeyPair();
      const merchant = makeKeyPair();
      const order = { type: 0, id: 'order-001', items: [{ product_id: 'candle-001', quantity: 2 }] };
      const wrap = giftWrap(JSON.stringify(order), buyer.privateKey, merchant.publicKey);
      const result = decryptIncomingOrder(wrap, merchant.privateKey);
      expect(result.order.type).toBe(0);
      expect(result.buyerPubkey).toBe(buyer.publicKey);
    });

    it('throws when content is not a type-0 order', () => {
      const buyer = makeKeyPair();
      const merchant = makeKeyPair();
      const wrap = giftWrap(JSON.stringify({ type: 99 }), buyer.privateKey, merchant.publicKey);
      expect(() => decryptIncomingOrder(wrap, merchant.privateKey)).toThrow(/type/);
    });

    it('throws when content is not JSON', () => {
      const buyer = makeKeyPair();
      const merchant = makeKeyPair();
      const wrap = giftWrap('not json!!!', buyer.privateKey, merchant.publicKey);
      expect(() => decryptIncomingOrder(wrap, merchant.privateKey)).toThrow();
    });
  });
});