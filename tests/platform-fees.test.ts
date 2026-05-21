/**
 * Scenarios 16 & 17: Platform Fees (NIP-57 Prisms)
 * Tests calculateFee arithmetic and parseFeeTag parsing.
 * No network calls needed — pure function tests.
 */
import { describe, it, expect } from 'vitest';
import { calculateFee, parseFeeTag } from '../src/platform-fees';
import type { FeeConfig, NostrEvent } from '../src/types';

const BASE_CONFIG: FeeConfig = {
  platformPubkey: 'a'.repeat(64),
  platformLnurl: 'platform@shopstr.store',
  feePercent: 3,
};

function makeEvent(tags: string[][]): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1_700_000_000,
    kind: 30402,
    tags,
    content: '',
    sig: 's'.repeat(128),
  };
}

describe('Scenarios 16 & 17: Platform Fees', () => {
  describe('calculateFee', () => {
    it('3% fee on 100_000 msats gives 3_000 fee, 103_000 total', () => {
      const result = calculateFee(100_000, BASE_CONFIG);
      expect(result.feeMsats).toBe(3_000);
      expect(result.merchantMsats).toBe(100_000);
      expect(result.totalMsats).toBe(103_000);
    });

    it('5% fee on 1_000_000 msats', () => {
      const result = calculateFee(1_000_000, { ...BASE_CONFIG, feePercent: 5 });
      expect(result.feeMsats).toBe(50_000);
      expect(result.totalMsats).toBe(1_050_000);
    });

    it('minFeeMsats is applied when percentage falls below minimum', () => {
      // 3% of 100 msats = 3 msats, but minFeeMsats = 1_000
      const result = calculateFee(100, { ...BASE_CONFIG, minFeeMsats: 1_000 });
      expect(result.feeMsats).toBe(1_000);
      expect(result.totalMsats).toBe(1_100);
    });

    it('percentage fee is used when it exceeds minFeeMsats', () => {
      const result = calculateFee(1_000_000, { ...BASE_CONFIG, minFeeMsats: 100 });
      expect(result.feeMsats).toBe(30_000); // 3% of 1M
    });

    it('0% fee returns zero feeMsats and total equals amount', () => {
      const result = calculateFee(500_000, { ...BASE_CONFIG, feePercent: 0 });
      expect(result.feeMsats).toBe(0);
      expect(result.totalMsats).toBe(500_000);
    });

    it('fee is floored to whole msats (no fractional msats)', () => {
      // 3% of 33_333 = 999.99 → floor to 999
      const result = calculateFee(33_333, BASE_CONFIG);
      expect(Number.isInteger(result.feeMsats)).toBe(true);
    });

    it('no value lost: merchantMsats + feeMsats = totalMsats', () => {
      const amounts = [1_000, 50_000, 100_000, 1_000_000, 21_000_000_000];
      amounts.forEach(amount => {
        const r = calculateFee(amount, BASE_CONFIG);
        expect(r.merchantMsats + r.feeMsats).toBe(r.totalMsats);
      });
    });

    it('1% fee on typical 50k sat order (5_000_000 msats)', () => {
      const result = calculateFee(5_000_000, { ...BASE_CONFIG, feePercent: 1 });
      expect(result.feeMsats).toBe(50_000);
      expect(result.totalMsats).toBe(5_050_000);
    });
  });

  describe('parseFeeTag', () => {
    it('returns null when event has no fee tag', () => {
      const event = makeEvent([['p', 'a'.repeat(64)]]);
      expect(parseFeeTag(event)).toBeNull();
    });

    it('parses feePercent and platformPubkey from fee tag', () => {
      const event = makeEvent([
        ['fee', '3', 'wss://relay.test', 'a'.repeat(64)],
      ]);
      const parsed = parseFeeTag(event);
      expect(parsed).not.toBeNull();
      expect(parsed!.feePercent).toBe(3);
      expect(parsed!.platformPubkey).toBe('a'.repeat(64));
    });

    it('parses totalMsats from total tag when present', () => {
      const event = makeEvent([
        ['fee', '3', 'wss://relay.test', 'a'.repeat(64)],
        ['total', '103'], // 103 sats = 103_000 msats
      ]);
      const parsed = parseFeeTag(event);
      expect(parsed!.totalMsats).toBe(103_000);
    });

    it('totalMsats is undefined when no total tag present', () => {
      const event = makeEvent([
        ['fee', '3', '', 'a'.repeat(64)],
      ]);
      const parsed = parseFeeTag(event);
      expect(parsed!.totalMsats).toBeUndefined();
    });
  });
});