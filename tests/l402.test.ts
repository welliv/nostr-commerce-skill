/**
 * Scenario 20: L402 / Paid APIs (NIP-98 + BOLT-11)
 * Tests parseL402Challenge header parsing, buildNip98AuthHeader format,
 * and verifyL402Credentials rejection logic — no real wallets or invoices.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey } from 'nostr-tools';
import { parseL402Challenge, buildNip98AuthHeader, verifyL402Credentials } from '../src/l402';
import { NostrWalletConnect } from '../src/nwc';

const VALID_NWC_URL =
  'nostr+walletconnect://' + 'a'.repeat(64) +
  '?relay=wss%3A%2F%2Frelay.getalby.com&secret=' + 'b'.repeat(64);

// Construct a minimal valid L402 header
const VALID_MACAROON = 'abc123def456';
const VALID_INVOICE  = 'lnbc1000n1pjqy0pp5' + 'a'.repeat(52);
const VALID_L402_HEADER = `L402 macaroon="${VALID_MACAROON}", invoice="${VALID_INVOICE}"`;

describe('Scenario 20: L402 Paid APIs', () => {
  describe('parseL402Challenge', () => {
    it('extracts macaroon and invoice from a valid WWW-Authenticate header', () => {
      const challenge = parseL402Challenge(VALID_L402_HEADER);
      expect(challenge.macaroon).toBe(VALID_MACAROON);
      expect(challenge.invoice).toBe(VALID_INVOICE);
    });

    it('throws on header missing macaroon field', () => {
      expect(() => parseL402Challenge(`L402 invoice="${VALID_INVOICE}"`))
        .toThrow(/L402|macaroon/i);
    });

    it('throws on header missing invoice field', () => {
      expect(() => parseL402Challenge(`L402 macaroon="${VALID_MACAROON}"`))
        .toThrow(/L402|invoice/i);
    });

    it('throws on empty string', () => {
      expect(() => parseL402Challenge('')).toThrow();
    });

    it('throws on Bearer token instead of L402', () => {
      expect(() => parseL402Challenge('Bearer sometoken')).toThrow();
    });

    it('paymentHash field is populated', () => {
      const challenge = parseL402Challenge(VALID_L402_HEADER);
      expect(typeof challenge.paymentHash).toBe('string');
      expect(challenge.paymentHash.length).toBeGreaterThan(0);
    });
  });

  describe('buildNip98AuthHeader', () => {
    it('returns a string starting with "Nostr "', () => {
      const sk = generateSecretKey();
      const header = buildNip98AuthHeader('https://api.example.com/catalog', 'GET', sk);
      expect(header).toMatch(/^Nostr /);
    });

    it('base64 payload decodes to a valid Nostr event JSON', () => {
      const sk = generateSecretKey();
      const header = buildNip98AuthHeader('https://api.example.com/catalog', 'GET', sk);
      const b64 = header.replace('Nostr ', '');
      const event = JSON.parse(atob(b64));
      expect(event.kind).toBe(27235);
      expect(event.tags).toEqual(expect.arrayContaining([
        expect.arrayContaining(['u', 'https://api.example.com/catalog']),
        expect.arrayContaining(['method', 'GET']),
      ]));
    });

    it('works for POST method', () => {
      const sk = generateSecretKey();
      const header = buildNip98AuthHeader('https://api.example.com/upload', 'POST', sk);
      const event = JSON.parse(atob(header.replace('Nostr ', '')));
      const methodTag = event.tags.find((t: string[]) => t[0] === 'method');
      expect(methodTag?.[1]).toBe('POST');
    });

    it('includes payload tag when body is provided', () => {
      const sk = generateSecretKey();
      const header = buildNip98AuthHeader(
        'https://api.example.com/data', 'POST', sk, { key: 'value' }
      );
      const event = JSON.parse(atob(header.replace('Nostr ', '')));
      const payloadTag = event.tags.find((t: string[]) => t[0] === 'payload');
      expect(payloadTag).toBeDefined();
    });
  });

  describe('verifyL402Credentials', () => {
    it('returns false for headers not starting with "L402 "', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      const result = await verifyL402Credentials('Bearer abc:xyz', wallet);
      expect(result).toBe(false);
    });

    it('returns false when credential has wrong format (no colon separator)', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      const result = await verifyL402Credentials('L402 invalidformat', wallet);
      expect(result).toBe(false);
    });

    it('returns false when either macaroon or preimage is empty', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      const result = await verifyL402Credentials('L402 :', wallet);
      expect(result).toBe(false);
    });

    it('returns false for empty authorization header', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      const result = await verifyL402Credentials('', wallet);
      expect(result).toBe(false);
    });
  });
});