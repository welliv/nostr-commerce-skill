/**
 * Scenarios 9 & 10: Proof of Payment + Preimage-Gated Reviews
 * verifyPreimage: SHA-256(preimage) must equal the paymentHash.
 * Only buyers who paid can leave a review — the preimage proves payment.
 */
import { describe, it, expect } from 'vitest';
import { verifyPreimage } from '../src/reviews';
import { generateSecretKey } from 'nostr-tools';
import crypto from 'node:crypto';

/** Derive a valid (preimage, paymentHash) pair for testing */
function makeValidPair(): { preimage: string; paymentHash: string } {
  const preimage = crypto.randomBytes(32).toString('hex');
  const hashBytes = crypto.createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest();
  return { preimage, paymentHash: hashBytes.toString('hex') };
}

describe('Scenarios 9 & 10: Proof of Payment', () => {
  describe('verifyPreimage', () => {
    it('returns true when SHA256(preimage) === paymentHash', async () => {
      const { preimage, paymentHash } = makeValidPair();
      expect(await verifyPreimage(preimage, paymentHash)).toBe(true);
    });

    it('returns false when preimage does not match paymentHash', async () => {
      const { paymentHash } = makeValidPair();
      const wrongPreimage = 'a'.repeat(64); // different bytes
      expect(await verifyPreimage(wrongPreimage, paymentHash)).toBe(false);
    });

    it('returns false for empty preimage', async () => {
      const { paymentHash } = makeValidPair();
      expect(await verifyPreimage('', paymentHash)).toBe(false);
    });

    it('returns false for empty paymentHash', async () => {
      const { preimage } = makeValidPair();
      expect(await verifyPreimage(preimage, '')).toBe(false);
    });

    it('returns false when both strings are empty', async () => {
      expect(await verifyPreimage('', '')).toBe(false);
    });

    it('is case-insensitive on paymentHash', async () => {
      const { preimage, paymentHash } = makeValidPair();
      expect(await verifyPreimage(preimage, paymentHash.toUpperCase())).toBe(true);
    });

    it('returns false for non-hex preimage', async () => {
      const { paymentHash } = makeValidPair();
      expect(await verifyPreimage('not-hex-zzzzz', paymentHash)).toBe(false);
    });

    it('10 independent pairs all verify correctly', async () => {
      for (let i = 0; i < 10; i++) {
        const { preimage, paymentHash } = makeValidPair();
        expect(await verifyPreimage(preimage, paymentHash)).toBe(true);
      }
    });

    it('using a preimage from a different payment always fails', async () => {
      const pair1 = makeValidPair();
      const pair2 = makeValidPair();
      // Swap preimage and hash from different payments
      expect(await verifyPreimage(pair1.preimage, pair2.paymentHash)).toBe(false);
      expect(await verifyPreimage(pair2.preimage, pair1.paymentHash)).toBe(false);
    });
  });
});