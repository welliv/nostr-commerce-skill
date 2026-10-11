/**
 * Scenario 20: L402 / Paid APIs (NIP-98 + BOLT-11)
 * Tests parseL402Challenge header parsing, buildNip98AuthHeader format,
 * and verifyL402Credentials rejection logic — no real wallets or invoices.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey } from 'nostr-tools';
import { parseL402Challenge, buildNip98AuthHeader, verifyL402Credentials } from '../src/l402';
import { NostrWalletConnect } from '../src/nwc';
import { createHash, randomBytes } from 'node:crypto';
import {
  mintL402Token, decodeL402Token, extractPaymentHashFromInvoice,
  InMemoryUsedTokenStore, createL402Challenge,
} from '../src/l402';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
function payPair() {
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  return { preimage, paymentHash };
}

const VALID_NWC_URL =
  'nostr+walletconnect://' + 'a'.repeat(64) +
  '?relay=wss%3A%2F%2Frelay.getalby.com&secret=' + 'b'.repeat(64);

// Construct a minimal valid L402 header
const VALID_MACAROON = 'abc123def456';
// BOLT-11 spec test vector; payment hash 0001020304...0102
const VALID_INVOICE  = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
const VECTOR_HASH = '0001020304050607080900010203040506070809000102030405060708090102';
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
      expect(challenge.paymentHash).toBe(VECTOR_HASH);
    });
  });

  describe('buildNip98AuthHeader', () => {
    it('returns a string starting with "Nostr "', () => {
      const sk = generateSecretKey();
      const header = buildNip98AuthHeader('https://api.example.com/catalogue', 'GET', sk);
      expect(header).toMatch(/^Nostr /);
    });

    it('base64 payload decodes to a valid Nostr event JSON', () => {
      const sk = generateSecretKey();
      const header = buildNip98AuthHeader('https://api.example.com/catalogue', 'GET', sk);
      const b64 = header.replace('Nostr ', '');
      const event = JSON.parse(atob(b64));
      expect(event.kind).toBe(27235);
      expect(event.tags).toEqual(expect.arrayContaining([
        expect.arrayContaining(['u', 'https://api.example.com/catalogue']),
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
      const result = await verifyL402Credentials('Bearer abc:xyz', { resource: '/x', secret: SECRET });
      expect(result).toBe(false);
    });

    it('returns false when credential has wrong format (no colon separator)', async () => {
      const result = await verifyL402Credentials('L402 invalidformat', { resource: '/x', secret: SECRET });
      expect(result).toBe(false);
    });

    it('returns false when either macaroon or preimage is empty', async () => {
      const result = await verifyL402Credentials('L402 :', { resource: '/x', secret: SECRET });
      expect(result).toBe(false);
    });

    it('returns false for empty authorization header', async () => {
      const result = await verifyL402Credentials('', { resource: '/x', secret: SECRET });
      expect(result).toBe(false);
    });
  });

  describe('extractPaymentHashFromInvoice (BOLT-11 decode)', () => {
    it('decodes the payment hash from the spec vector', () => {
      expect(extractPaymentHashFromInvoice(VALID_INVOICE)).toBe(VECTOR_HASH);
    });
    it('does not just return the last 64 chars', () => {
      expect(extractPaymentHashFromInvoice(VALID_INVOICE)).not.toBe(VALID_INVOICE.slice(-64));
    });
    it('throws on garbage invoices', () => {
      expect(() => extractPaymentHashFromInvoice('lnbc1000n1pjqy0pp5' + 'a'.repeat(52))).toThrow(/BOLT-11/);
    });
  });

  describe('HMAC L402 tokens', () => {
    const exp = () => Math.floor(Date.now() / 1000) + 300;

    it('mints a token that decodes with caveats for resource + expiry', () => {
      const { paymentHash } = payPair();
      const e = exp();
      const t = mintL402Token({ paymentHash, resource: '/api/a', expiresAt: e, secret: SECRET });
      const p = decodeL402Token(t, SECRET)!;
      expect(p.id).toEqual({ ph: paymentHash, res: '/api/a', exp: e });
      expect(p.caveats).toEqual(['resource=/api/a', `expires=${e}`]);
      expect(t).not.toBe(paymentHash);
    });

    it('rejects a token signed with another secret', () => {
      const { paymentHash } = payPair();
      const t = mintL402Token({ paymentHash, resource: '/a', expiresAt: exp(), secret: SECRET });
      expect(decodeL402Token(t, 'x'.repeat(40))).toBeNull();
    });

    it('throws without a secret (env unset)', () => {
      const old = process.env.L402_SECRET; delete process.env.L402_SECRET;
      expect(() => mintL402Token({ paymentHash: 'a'.repeat(64), resource: '/a', expiresAt: 1 })).toThrow(/L402_SECRET/);
      if (old) process.env.L402_SECRET = old;
    });

    it('uses L402_SECRET from env', () => {
      process.env.L402_SECRET = SECRET;
      const t = mintL402Token({ paymentHash: 'a'.repeat(64), resource: '/a', expiresAt: 1 });
      expect(decodeL402Token(t, SECRET)).not.toBeNull();
      delete process.env.L402_SECRET;
    });

    it('accepts a valid token + preimage once, then rejects replay', async () => {
      const { preimage, paymentHash } = payPair();
      const t = mintL402Token({ paymentHash, resource: '/a', expiresAt: exp(), secret: SECRET });
      const store = new InMemoryUsedTokenStore();
      const opts = { resource: '/a', secret: SECRET, usedTokenStore: store };
      expect(await verifyL402Credentials(`L402 ${t}:${preimage}`, opts)).toBe(true);
      expect(await verifyL402Credentials(`L402 ${t}:${preimage}`, opts)).toBe(false);
    });

    it('rejects a wrong preimage', async () => {
      const { paymentHash } = payPair();
      const t = mintL402Token({ paymentHash, resource: '/a', expiresAt: exp(), secret: SECRET });
      const bad = randomBytes(32).toString('hex');
      expect(await verifyL402Credentials(`L402 ${t}:${bad}`, { resource: '/a', secret: SECRET, usedTokenStore: new InMemoryUsedTokenStore() })).toBe(false);
    });

    it('rejects a different resource', async () => {
      const { preimage, paymentHash } = payPair();
      const t = mintL402Token({ paymentHash, resource: '/a', expiresAt: exp(), secret: SECRET });
      expect(await verifyL402Credentials(`L402 ${t}:${preimage}`, { resource: '/b', secret: SECRET, usedTokenStore: new InMemoryUsedTokenStore() })).toBe(false);
    });

    it('rejects an expired token', async () => {
      const { preimage, paymentHash } = payPair();
      const t = mintL402Token({ paymentHash, resource: '/a', expiresAt: 1000, secret: SECRET });
      expect(await verifyL402Credentials(`L402 ${t}:${preimage}`, { resource: '/a', secret: SECRET, now: 1001, usedTokenStore: new InMemoryUsedTokenStore() })).toBe(false);
    });

    it('rejects the legacy "macaroon = payment hash" credential', async () => {
      const { preimage, paymentHash } = payPair();
      expect(await verifyL402Credentials(`L402 ${paymentHash}:${preimage}`, { resource: '/a', secret: SECRET })).toBe(false);
    });

    it('rejects a tampered payload', async () => {
      const { preimage, paymentHash } = payPair();
      const t = mintL402Token({ paymentHash, resource: '/a', expiresAt: exp(), secret: SECRET });
      const [, sig] = t.split('.');
      const forged = Buffer.from(JSON.stringify({ v: 1, id: { ph: paymentHash, res: '*', exp: exp() }, caveats: [] })).toString('base64url');
      expect(await verifyL402Credentials(`L402 ${forged}.${sig}:${preimage}`, { resource: '/a', secret: SECRET })).toBe(false);
    });

    it('createL402Challenge embeds an HMAC token, not the bare payment hash', async () => {
      const { paymentHash } = payPair();
      const wallet = { createInvoice: vi.fn().mockResolvedValue({ invoice: VALID_INVOICE, paymentHash }) } as unknown as NostrWalletConnect;
      const r = await createL402Challenge(wallet, 1000, 'call', { resource: '/a', secret: SECRET });
      expect(r.challenge).toContain(`macaroon="${r.token}"`);
      expect(r.token).not.toBe(paymentHash);
      expect(decodeL402Token(r.token, SECRET)!.id.ph).toBe(paymentHash);
    });
  });
});
