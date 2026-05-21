/**
 * Scenarios 13 & 14: Zaps + Prisms (NIP-57)
 * Tests buildZapRequest validation, summarizeZaps aggregation,
 * and buildPrism split logic — no network calls.
 */
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { buildZapRequest, summarizeZaps, buildPrism } from '../src/zaps';
import type { ZapParams, NostrEvent } from '../src/types';

function makeKey() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
}

const RELAY = 'wss://relay.damus.io';

// ── buildZapRequest ───────────────────────────────────────────────────────────

describe('Scenarios 13 & 14: Zaps + Prisms', () => {
  describe('buildZapRequest', () => {
    it('produces a kind 9734 event', () => {
      const sender = makeKey();
      const recipient = makeKey();
      const params: ZapParams = {
        recipients: [{ pubkey: recipient.pk }],
        amountMsats: 21_000,
        relays: [RELAY],
      };
      const event = buildZapRequest(params, sender.sk);
      expect(event.kind).toBe(9734);
    });

    it('includes amount tag matching amountMsats', () => {
      const sender = makeKey();
      const params: ZapParams = {
        recipients: [{ pubkey: makeKey().pk }],
        amountMsats: 50_000,
        relays: [RELAY],
      };
      const event = buildZapRequest(params, sender.sk);
      const amountTag = event.tags.find(t => t[0] === 'amount');
      expect(amountTag?.[1]).toBe('50000');
    });

    it('single recipient: produces standard p-tag (not split)', () => {
      const sender = makeKey();
      const recipient = makeKey();
      const params: ZapParams = {
        recipients: [{ pubkey: recipient.pk }],
        amountMsats: 1_000,
        relays: [RELAY],
      };
      const event = buildZapRequest(params, sender.sk);
      const pTags = event.tags.filter(t => t[0] === 'p');
      expect(pTags).toHaveLength(1);
      expect(pTags[0][1]).toBe(recipient.pk);
    });

    it('multi-recipient prism: produces one p-tag per recipient with weight', () => {
      const sender = makeKey();
      const r1 = makeKey();
      const r2 = makeKey();
      const params: ZapParams = {
        recipients: [
          { pubkey: r1.pk, weight: 70 },
          { pubkey: r2.pk, weight: 30 },
        ],
        amountMsats: 100_000,
        relays: [RELAY],
      };
      const event = buildZapRequest(params, sender.sk);
      const pTags = event.tags.filter(t => t[0] === 'p');
      expect(pTags).toHaveLength(2);
      expect(pTags[0][3]).toBe('70');
      expect(pTags[1][3]).toBe('30');
    });

    it('includes e-tag when eventId is provided', () => {
      const sender = makeKey();
      const eventId = 'f'.repeat(64);
      const params: ZapParams = {
        recipients: [{ pubkey: makeKey().pk }],
        amountMsats: 1_000,
        relays: [RELAY],
        eventId,
      };
      const event = buildZapRequest(params, sender.sk);
      const eTag = event.tags.find(t => t[0] === 'e');
      expect(eTag?.[1]).toBe(eventId);
    });

    it('throws when recipients list is empty', () => {
      const sender = makeKey();
      expect(() => buildZapRequest(
        { recipients: [], amountMsats: 1_000, relays: [RELAY] },
        sender.sk
      )).toThrow(/recipient/i);
    });

    it('throws when amountMsats is zero', () => {
      const sender = makeKey();
      expect(() => buildZapRequest(
        { recipients: [{ pubkey: makeKey().pk }], amountMsats: 0, relays: [RELAY] },
        sender.sk
      )).toThrow(/amountMsats/);
    });

    it('throws when amountMsats is negative', () => {
      const sender = makeKey();
      expect(() => buildZapRequest(
        { recipients: [{ pubkey: makeKey().pk }], amountMsats: -1, relays: [RELAY] },
        sender.sk
      )).toThrow(/amountMsats/);
    });

    it('comment is stored in event content', () => {
      const sender = makeKey();
      const params: ZapParams = {
        recipients: [{ pubkey: makeKey().pk }],
        amountMsats: 1_000,
        relays: [RELAY],
        comment: 'Great product! ⚡',
      };
      const event = buildZapRequest(params, sender.sk);
      expect(event.content).toBe('Great product! ⚡');
    });
  });

  // ── summarizeZaps ─────────────────────────────────────────────────────────

  describe('summarizeZaps', () => {
    it('returns zeroed summary for empty array', () => {
      const summary = summarizeZaps([]);
      expect(summary.totalMsats).toBe(0);
      expect(summary.zapCount).toBe(0);
      expect(summary.uniqueSenders).toBe(0);
      expect(summary.topSender).toBeUndefined();
    });

    it('returns zeroed summary for events that fail parseZapReceipt', () => {
      // Events without description tag will return null from parseZapReceipt
      const bogus: NostrEvent = {
        id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 0,
        kind: 9735, tags: [], content: '', sig: 's'.repeat(128),
      };
      const summary = summarizeZaps([bogus]);
      expect(summary.zapCount).toBe(0);
    });

    it('totalSats is floor of totalMsats / 1000', () => {
      const summary = summarizeZaps([]);
      expect(summary.totalSats).toBe(Math.floor(summary.totalMsats / 1000));
    });
  });

  // ── buildPrism ─────────────────────────────────────────────────────────────

  describe('buildPrism', () => {
    it('returns ZapRecipient array with correct weights', () => {
      const pk1 = makeKey().pk;
      const pk2 = makeKey().pk;
      const result = buildPrism(
        { pubkey: pk1, percentage: 80 },
        { pubkey: pk2, percentage: 20 },
      );
      expect(result.find(r => r.pubkey === pk1)?.weight).toBe(80);
      expect(result.find(r => r.pubkey === pk2)?.weight).toBe(20);
    });

    it('throws for a single recipient', () => {
      expect(() => buildPrism({ pubkey: makeKey().pk, percentage: 100 }))
        .toThrow(/2 recipients/);
    });

    it('throws when percentages do not sum to 100', () => {
      expect(() => buildPrism(
        { pubkey: makeKey().pk, percentage: 40 },
        { pubkey: makeKey().pk, percentage: 40 },
      )).toThrow(/100/);
    });
  });
});