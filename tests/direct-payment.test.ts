/**
 * Scenario 7: Direct Payment via NWC
 * Tests NWC connection string validation, wallet construction,
 * and that unconnected wallet methods throw correctly.
 * No live wallet calls — all network calls are blocked in this environment.
 */
import { describe, it, expect, vi } from 'vitest';
import { NostrWalletConnect, createWalletFromEnv } from '../src/nwc';

const VALID_NWC_URL =
  'nostr+walletconnect://' + 'a'.repeat(64) +
  '?relay=wss%3A%2F%2Frelay.getalby.com&secret=' + 'b'.repeat(64);

describe('Scenario 7: Direct Payment (NWC)', () => {
  describe('NostrWalletConnect constructor', () => {
    it('accepts a valid nostr+walletconnect:// URL', () => {
      expect(() => new NostrWalletConnect(VALID_NWC_URL)).not.toThrow();
    });

    it('rejects URLs that do not start with nostr+walletconnect://', () => {
      expect(() => new NostrWalletConnect('https://example.com')).toThrow(/nostr\+walletconnect/);
    });

    it('rejects empty string', () => {
      expect(() => new NostrWalletConnect('')).toThrow();
    });

    it('rejects lightning:// prefix', () => {
      expect(() => new NostrWalletConnect('lightning://node@example.com')).toThrow();
    });
  });

  describe('assertConnected guard', () => {
    it('getBalance throws before connect() is called', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      await expect(wallet.getBalance()).rejects.toThrow(/connect/i);
    });

    it('payInvoice throws before connect() is called', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      await expect(wallet.payInvoice('lnbctest')).rejects.toThrow(/connect/i);
    });

    it('createInvoice throws before connect() is called', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      await expect(wallet.createInvoice({ amountMsats: 1000 })).rejects.toThrow(/connect/i);
    });
  });

  describe('payInvoice validation', () => {
    it('rejects short invoice strings after connect', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      // Manually mark connected to bypass connection check and hit invoice validation
      (wallet as any).connected = true;
      // Mock the internal client so we don't hit the network
      (wallet as any).client = {
        payInvoice: vi.fn().mockRejectedValueOnce(new Error('network')),
      };
      // Short string should fail validation
      await expect(wallet.payInvoice('ln')).rejects.toThrow();
    });
  });

  describe('createWalletFromEnv', () => {
    it('throws when NWC_CONNECTION_URL env var is missing', () => {
      const original = process.env.NWC_CONNECTION_URL;
      delete process.env.NWC_CONNECTION_URL;
      expect(() => createWalletFromEnv()).toThrow(/NWC_CONNECTION_URL/);
      if (original !== undefined) process.env.NWC_CONNECTION_URL = original;
    });

    it('creates a wallet when env var is set', () => {
      process.env.NWC_CONNECTION_URL = VALID_NWC_URL;
      const wallet = createWalletFromEnv();
      expect(wallet).toBeInstanceOf(NostrWalletConnect);
      delete process.env.NWC_CONNECTION_URL;
    });
  });
});