/**
 * Scenario 22: Dispute Resolution (NIP-85 + kind 1984)
 * Tests initiateDispute input validation and verifyPaymentViaLnurl
 * with mocked fetch — no live network calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initiateDispute, verifyPaymentViaLnurl } from '../src/disputes';

const MERCHANT_PK = 'a'.repeat(64);
const BUYER_PK    = 'b'.repeat(64);
const PAY_HASH    = 'c'.repeat(64);
const VALID_DISPUTE = {
  orderId: 'order-001',
  merchantPubkey: MERCHANT_PK,
  buyerPubkey: BUYER_PK,
  paymentHash: PAY_HASH,
  reason: 'Item never arrived after 30 days.',
  evidenceEventIds: [],
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
beforeEach(() => vi.clearAllMocks());

// ── initiateDispute validation ────────────────────────────────────────────────

describe('Scenario 22: Dispute Resolution', () => {
  describe('initiateDispute — input validation', () => {
    it('throws synchronously when orderId is missing', async () => {
      await expect(
        initiateDispute({ ...VALID_DISPUTE, orderId: '' } as any, new Uint8Array(32))
      ).rejects.toThrow('orderId is required');
    });

    it('throws when paymentHash is not 64 chars', async () => {
      await expect(
        initiateDispute({ ...VALID_DISPUTE, paymentHash: 'tooshort' }, new Uint8Array(32))
      ).rejects.toThrow(/paymentHash/);
    });

    it('throws when reason is empty string', async () => {
      await expect(
        initiateDispute({ ...VALID_DISPUTE, reason: '' }, new Uint8Array(32))
      ).rejects.toThrow(/reason/i);
    });

    it('throws when reason is whitespace only', async () => {
      await expect(
        initiateDispute({ ...VALID_DISPUTE, reason: '   ' }, new Uint8Array(32))
      ).rejects.toThrow(/reason/i);
    });

    it('throws when called with completely empty object', async () => {
      await expect(
        initiateDispute({} as any, new Uint8Array(32))
      ).rejects.toThrow();
    });

    it('throws when paymentHash is missing entirely', async () => {
      const { paymentHash: _, ...noHash } = VALID_DISPUTE;
      await expect(
        initiateDispute(noHash as any, new Uint8Array(32))
      ).rejects.toThrow(/paymentHash/);
    });
  });

  // ── verifyPaymentViaLnurl ────────────────────────────────────────────────────

  describe('verifyPaymentViaLnurl — with mocked fetch', () => {
    it('returns settled=true and preimage when server confirms payment', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ settled: true, preimage: 'd'.repeat(64), amount: 1000 }),
        text: async () => '',
      });

      const result = await verifyPaymentViaLnurl(
        'https://example.com/lnurl-verify/abc',
        PAY_HASH
      );

      expect(result.settled).toBe(true);
      expect(result.preimage).toBe('d'.repeat(64));
      expect(result.amount).toBe(1000);
    });

    it('returns settled=false when server reports unpaid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ settled: false }),
        text: async () => '',
      });

      const result = await verifyPaymentViaLnurl('https://example.com/verify', PAY_HASH);
      expect(result.settled).toBe(false);
      expect(result.preimage).toBeUndefined();
    });

    it('throws on non-200 response with informative message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      await expect(
        verifyPaymentViaLnurl('https://example.com/verify', PAY_HASH)
      ).rejects.toThrow(/404|LNURL/);
    });

    it('throws on network failure with informative message', async () => {
      mockFetch.mockRejectedValueOnce(new Error('DNS resolution failed'));

      await expect(
        verifyPaymentViaLnurl('https://offline.example.com/verify', PAY_HASH)
      ).rejects.toThrow(/LNURL-verify failed/);
    });

    it('omits preimage from result when server does not include it', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ settled: true }),
        text: async () => '',
      });

      const result = await verifyPaymentViaLnurl('https://example.com/verify', PAY_HASH);
      expect(result.settled).toBe(true);
      expect(result.preimage).toBeUndefined();
    });
  });
});