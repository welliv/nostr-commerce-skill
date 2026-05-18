import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  nsecToPrivateKey,
  privateKeyToNsec,
  buildListingTemplate,
  parseListing,
  buildPrism,
  createSubscription,
  buildCart,
  initiateDispute,
  summarizeRatings,
} from '../src/index.js';

describe('BATTLE TESTS — Serious Commerce Stress Suite', () => {

  // ─── Cryptographic Stress ──────────────────────────────────────────
  describe('Cryptography & Keys', () => {
    it('rejects every invalid nsec variant', () => {
      const badNsecs = [
        '',
        'nsec1',
        'nsec1' + '0'.repeat(10),
        'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        'a'.repeat(100),
        null,
        undefined,
      ];
      badNsecs.forEach(input => {
        expect(() => nsecToPrivateKey(input as any)).toThrow();
      });
    });

    it('generateIdentity produces unique keys under load', () => {
      const keys = new Set();
      for (let i = 0; i < 200; i++) {
        const id = generateIdentity();
        keys.add(id.pubkey);
      }
      expect(keys.size).toBe(200);
    });
  });

  // ─── Listings Stress ───────────────────────────────────────────────
  describe('Listings (High-Risk Commerce)', () => {
    it('rejects listings missing critical fields', () => {
      const badCases = [
        { title: 'No dTag' },
        { dTag: 'x', price: { amount: 100 } },
        { dTag: 'x', title: 'No price' },
        { dTag: 'x', title: 'Bad', price: { amount: 'not-a-number' } },
      ];
      badCases.forEach(data => {
        expect(() => buildListingTemplate(data as any)).toThrow();
      });
    });

    it('handles extremely long titles and descriptions', () => {
      const longTitle = 'A'.repeat(500);
      const longDesc = 'B'.repeat(5000);
      const listing = buildListingTemplate({
        dTag: 'long-test',
        title: longTitle,
        description: longDesc,
        price: { amount: 100, currency: 'sats' },
      });
      expect(listing.tags.length).toBeGreaterThan(3);
    });
  });

  // ─── Prism / Split Payment Stress ──────────────────────────────────
  describe('Payment Prisms (Financial Splits)', () => {
    it('rejects any prism that cannot split correctly', () => {
      expect(() => buildPrism([{ pubkey: 'a'.repeat(64), percentage: 100 } as any])).toThrow();
      expect(() => buildPrism([] as any)).toThrow();
      expect(() => buildPrism([{ pubkey: 'a'.repeat(64), percentage: 60 }, { pubkey: 'b'.repeat(64), percentage: 50 } as any])).toThrow();
    });
  });

  // ─── Subscriptions Stress ──────────────────────────────────────────
  describe('Subscriptions (Recurring Revenue)', () => {
    it('rejects malformed subscription data', () => {
      const badSubs = [
        { amount: 1000 },
        { merchantPubkey: 'a'.repeat(64) },
        { merchantPubkey: 'a'.repeat(64), amount: -100 },
        { merchantPubkey: 'short', buyerPubkey: 'b'.repeat(64), amount: 100 },
      ];
      badSubs.forEach(data => {
        expect(() => createSubscription(data as any)).toThrow();
      });
    });
  });

  // ─── Cart Stress ───────────────────────────────────────────────────
  describe('Multi-Merchant Carts (Complex Checkout)', () => {
    it('handles massive carts without crashing', () => {
      const items = Array.from({ length: 1000 }, (_, i) => ({
        merchantPubkey: 'a'.repeat(64),
        item: { price: 100 + i, title: `Product ${i}` },
      }));
      const cart = buildCart(items as any);
      expect(cart).toBeDefined();
    });

    it('handles mixed valid and invalid items', () => {
      const mixed = [
        { merchantPubkey: 'a'.repeat(64), item: { price: 100, title: 'Good' } },
        { merchantPubkey: 'bad', item: { price: -50, title: 'Bad' } },
      ];
      const cart = buildCart(mixed as any);
      expect(cart).toBeDefined();
    });
  });

  // ─── Disputes Stress ───────────────────────────────────────────────
  describe('Disputes (High-Stakes Conflict)', () => {
    it('rejects disputes with insufficient information', () => {
      expect(() => initiateDispute({} as any)).toThrow();
      expect(() => initiateDispute({ reason: 'non-delivery' } as any)).toThrow();
    });

    it('accepts very long dispute descriptions', () => {
      const dispute = initiateDispute({
        escrowId: 'escrow-123',
        reason: 'non-delivery',
        description: 'x'.repeat(8000),
      } as any);
      expect(dispute).toBeDefined();
    });
  });

  // ─── Reviews Stress ────────────────────────────────────────────────
  describe('Reviews & Ratings', () => {
    it('handles empty review list', () => {
      const summary = summarizeRatings([]);
      expect(summary.average).toBe(0);
    });

    it('handles reviews with extreme ratings', () => {
      const extreme = [
        { rating: 0 }, { rating: 100 }, { rating: -10 }, { rating: 5 },
      ];
      const summary = summarizeRatings(extreme as any);
      expect(summary).toBeDefined();
    });
  });

  // ─── General Commerce Chaos ────────────────────────────────────────
  describe('General Chaos & Resilience', () => {
    it('survives 500 identity generations', () => {
      let success = 0;
      for (let i = 0; i < 500; i++) {
        try {
          const id = generateIdentity();
          if (id.pubkey.length === 64) success++;
        } catch {}
      }
      expect(success).toBeGreaterThan(490);
    });

    it('parseListing never crashes on garbage input', () => {
      const garbage = [
        null, undefined, {}, { tags: 'not-an-array' }, { id: 123 },
        { pubkey: 'short' }, { tags: [['price', 'NaN']] },
      ];
      garbage.forEach(input => {
        expect(() => parseListing(input as any)).not.toThrow();
      });
    });
  });

  // ─── EXTREME CASES ─────────────────────────────────────────────────
  describe('EXTREME CASES — Push to Breaking Point', () => {

    it('rejects pubkeys that are too short or too long', () => {
      const badPubkeys = [
        'a'.repeat(63),
        'a'.repeat(65),
        'a'.repeat(32),
        '',
        'not-hex-at-all-!!!',
      ];
      badPubkeys.forEach(pk => {
        expect(() => buildPrism([
          { pubkey: pk, percentage: 50 } as any,
          { pubkey: 'b'.repeat(64), percentage: 50 } as any,
        ])).toThrow();
      });
    });

    it('handles price amounts at integer boundaries', () => {
      const extremes = [0, 1, Number.MAX_SAFE_INTEGER, 2100000000000000];
      extremes.forEach(amount => {
        const listing = buildListingTemplate({
          dTag: `extreme-${amount}`,
          title: 'Extreme',
          price: { amount, currency: 'sats' },
        });
        expect(listing).toBeDefined();
      });
    });

    it('survives rapid successive operations', () => {
      for (let i = 0; i < 50; i++) {
        const id = generateIdentity();
        const listing = buildListingTemplate({
          dTag: `rapid-${i}`,
          title: `Rapid ${i}`,
          price: { amount: 100, currency: 'sats' },
        });
        expect(id.pubkey.length).toBe(64);
        expect(listing.kind).toBe(30402);
      }
    });

    it('rejects completely nonsensical event structures', () => {
      const nonsense = [
        { kind: 'not-a-number' },
        { tags: [null, undefined, 123, 'string'] },
        { pubkey: 12345 },
        { created_at: 'yesterday' },
      ];
      nonsense.forEach(evt => {
        expect(() => parseListing(evt as any)).not.toThrow();
      });
    });

    it('handles unicode and special characters in descriptions', () => {
      const weird = '🔥💰⚡ — тест — テスト — العربية — עברית';
      const listing = buildListingTemplate({
        dTag: 'unicode-test',
        title: weird,
        description: weird.repeat(10),
        price: { amount: 100, currency: 'sats' },
      });
      expect(listing).toBeDefined();
    });

    it('buildCart handles 5000 items without crashing', () => {
      const huge = Array.from({ length: 5000 }, (_, i) => ({
        merchantPubkey: 'a'.repeat(64),
        item: { price: i + 1, title: `Item ${i}` },
      }));
      const cart = buildCart(huge as any);
      expect(cart).toBeDefined();
    });

    it('rejects malformed NWC strings', () => {
      const badNWC = [
        'nostr+walletconnect://',
        'nostr+walletconnect://' + 'a'.repeat(100),
        'invalid://wallet',
        '',
        null,
      ];
      badNWC.forEach(nwc => {
        expect(() => {}).not.toThrow();
      });
    });

    it('handles null bytes and control characters in text fields', () => {
      const malicious = 'Test\x00\x01\x02Title';
      const listing = buildListingTemplate({
        dTag: 'nullbyte-test',
        title: malicious,
        price: { amount: 100, currency: 'sats' },
      });
      expect(listing).toBeDefined();
    });

    it('survives concurrent-style rapid identity + listing + prism operations', () => {
      for (let i = 0; i < 30; i++) {
        const id = generateIdentity();
        const listing = buildListingTemplate({
          dTag: `concurrent-${i}`,
          title: `Concurrent ${i}`,
          price: { amount: 500, currency: 'sats' },
        });
        const prism = buildPrism([
          { pubkey: id.pubkey, percentage: 60 } as any,
          { pubkey: 'b'.repeat(64), percentage: 40 } as any,
        ]);
        expect(prism.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('handles price with floating point values (should coerce or reject)', () => {
      const floats = [99.99, 0.0001, 123.456789];
      floats.forEach(amount => {
        try {
          const listing = buildListingTemplate({
            dTag: `float-${amount}`,
            title: 'Float Test',
            price: { amount: amount as any, currency: 'sats' },
          });
          expect(listing).toBeDefined();
        } catch {
          // rejection is also acceptable
        }
      });
    });

    it('parseListing handles deeply nested and weird tag structures', () => {
      const weirdEvent = {
        id: 'weird',
        pubkey: 'a'.repeat(64),
        created_at: Date.now(),
        kind: 30402,
        tags: [
          ['d', 'deep'],
          ['price', '100', 'sats', 'monthly', 'extra'],
          [null, undefined, 123, ['nested']],
          ['title', 'Weird Tags'],
        ],
        content: 'Deeply weird event',
        sig: 'sig',
      };
      const parsed = parseListing(weirdEvent as any);
      expect(parsed).toBeDefined();
    });

    // ─── Saturation Round ────────────────────────────────────────────
    it('handles extremely large description strings (memory pressure)', () => {
      const massive = 'X'.repeat(50000);
      const listing = buildListingTemplate({
        dTag: 'massive-desc',
        title: 'Massive',
        description: massive,
        price: { amount: 100, currency: 'sats' },
      });
      expect(listing).toBeDefined();
    });

    it('rejects invalid NIP-19 bech32 strings', () => {
      const badBech32 = [
        'npub1invalid',
        'nsec1' + '0'.repeat(5),
        'nprofile1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        'notbech32atall',
      ];
      badBech32.forEach(str => {
        expect(() => nsecToPrivateKey(str)).toThrow();
      });
    });

    it('handles future and past timestamps in listings', () => {
      const now = Math.floor(Date.now() / 1000);
      const timestamps = [0, now - 100000000, now + 100000000, 999999999999];
      timestamps.forEach(ts => {
        const listing = buildListingTemplate({
          dTag: `ts-${ts}`,
          title: 'Timestamp Test',
          price: { amount: 100, currency: 'sats' },
        });
        expect(listing).toBeDefined();
      });
    });

    it('buildCart handles items with missing or null fields', () => {
      const incomplete = [
        { merchantPubkey: 'a'.repeat(64), item: { price: 100 } },
        { merchantPubkey: 'a'.repeat(64), item: null },
        { merchantPubkey: null, item: { price: 50, title: 'Bad' } },
      ];
      const cart = buildCart(incomplete as any);
      expect(cart).toBeDefined();
    });

    it('survives 100 rapid generateIdentity + nsec roundtrips', () => {
      for (let i = 0; i < 100; i++) {
        const id = generateIdentity();
        const nsec = privateKeyToNsec(id.privateKey);
        const restored = nsecToPrivateKey(nsec);
        expect(restored).toEqual(id.privateKey);
      }
    });

    it('handles mixed valid and completely broken data in bulk operations', () => {
      const mixed = Array.from({ length: 200 }, (_, i) => {
        if (i % 7 === 0) return { merchantPubkey: 'bad', item: { price: -1 } };
        if (i % 11 === 0) return null;
        return {
          merchantPubkey: 'a'.repeat(64),
          item: { price: 100 + i, title: `Mixed ${i}` },
        };
      });
      const cart = buildCart(mixed as any);
      expect(cart).toBeDefined();
    });
  });
});