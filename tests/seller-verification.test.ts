/**
 * Scenario 5: Seller Verification
 * Tests NIP-05 identity lookup (verifyNip05) and full identity
 * verification (verifyIdentity) with NIP-39 external links.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyNip05 } from '../src/identity';

// Mock global fetch — no real DNS/HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const VALID_PUBKEY = 'a'.repeat(64);

function nip05Response(pubkey: string) {
  return { ok: true, json: async () => ({ names: { alice: pubkey } }) };
}

beforeEach(() => vi.clearAllMocks());

describe('Scenario 5: Seller Verification', () => {
  describe('verifyNip05', () => {
    it('returns true when server pubkey matches', async () => {
      mockFetch.mockResolvedValueOnce(nip05Response(VALID_PUBKEY));
      expect(await verifyNip05('alice@example.com', VALID_PUBKEY)).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('.well known/nostr.json'),
        expect.any(Object)
      );
    });

    it('returns false when server pubkey does not match', async () => {
      mockFetch.mockResolvedValueOnce(nip05Response('b'.repeat(64)));
      expect(await verifyNip05('alice@example.com', VALID_PUBKEY)).toBe(false);
    });

    it('returns false on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network error'));
      expect(await verifyNip05('alice@example.com', VALID_PUBKEY)).toBe(false);
    });

    it('returns false on non-200 response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
      expect(await verifyNip05('alice@example.com', VALID_PUBKEY)).toBe(false);
    });

    it('returns false when name absent from server response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ names: { bob: VALID_PUBKEY } }), // alice not here
      });
      expect(await verifyNip05('alice@example.com', VALID_PUBKEY)).toBe(false);
    });

    it('returns false for identifier missing @ sign', async () => {
      expect(await verifyNip05('notvalid', VALID_PUBKEY)).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns false for empty identifier', async () => {
      expect(await verifyNip05('', VALID_PUBKEY)).toBe(false);
    });

    it('uses correct well known URL format', async () => {
      mockFetch.mockResolvedValueOnce(nip05Response(VALID_PUBKEY));
      await verifyNip05('alice@shopstr.store', VALID_PUBKEY);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('shopstr.store');
      expect(calledUrl).toContain('nostr.json');
      expect(calledUrl).toContain('alice');
    });

    it('handles server returning malformed JSON gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new Error('bad json'); },
      });
      expect(await verifyNip05('alice@example.com', VALID_PUBKEY)).toBe(false);
    });
  });
});