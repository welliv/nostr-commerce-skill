/**
 * Scenario 14: Payment Prisms (NIP-57 Splits)
 * Tests buildPrism split validation: percentages must sum to 100,
 * rounding is handled correctly, and output weights match inputs.
 */
import { describe, it, expect } from 'vitest';
import { buildPrism } from '../src/zaps';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);
const PK_D = 'd'.repeat(64);

describe('Scenario 14: Payment Prisms', () => {
  describe('buildPrism — valid splits', () => {
    it('2-way split sums to 100 returns two recipients', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 70 },
        { pubkey: PK_B, percentage: 30 },
      );
      expect(result).toHaveLength(2);
    });

    it('weights match the input percentages exactly', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 97 },
        { pubkey: PK_B, percentage: 3 },
      );
      expect(result.find(r => r.pubkey === PK_A)!.weight).toBe(97);
      expect(result.find(r => r.pubkey === PK_B)!.weight).toBe(3);
    });

    it('3-way split works correctly', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 60 },
        { pubkey: PK_B, percentage: 30 },
        { pubkey: PK_C, percentage: 10 },
      );
      expect(result).toHaveLength(3);
      const total = result.reduce((s, r) => s + (r.weight ?? 0), 0);
      expect(total).toBe(100);
    });

    it('4-way split with floating point percentages (e.g. 33.33+33.33+33.33+0.01)', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 33.34 },
        { pubkey: PK_B, percentage: 33.33 },
        { pubkey: PK_C, percentage: 33.33 },
      );
      // Total should be within tolerance (0.01)
      const total = result.reduce((s, r) => s + (r.weight ?? 0), 0);
      expect(Math.abs(total - 100)).toBeLessThanOrEqual(0.01);
    });

    it('equal 50/50 split', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 50 },
        { pubkey: PK_B, percentage: 50 },
      );
      expect(result[0].weight).toBe(50);
      expect(result[1].weight).toBe(50);
    });

    it('preserves relayHint when provided', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 60, relayHint: 'wss://relay.example.com' },
        { pubkey: PK_B, percentage: 40 },
      );
      expect(result.find(r => r.pubkey === PK_A)!.relayHint).toBe('wss://relay.example.com');
      expect(result.find(r => r.pubkey === PK_B)!.relayHint).toBeUndefined();
    });

    it('preserves pubkey order in output', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 40 },
        { pubkey: PK_B, percentage: 35 },
        { pubkey: PK_C, percentage: 25 },
      );
      expect(result[0].pubkey).toBe(PK_A);
      expect(result[1].pubkey).toBe(PK_B);
      expect(result[2].pubkey).toBe(PK_C);
    });
  });

  describe('buildPrism — invalid splits', () => {
    it('throws when fewer than 2 recipients', () => {
      expect(() => buildPrism({ pubkey: PK_A, percentage: 100 }))
        .toThrow(/2 recipients/);
    });

    it('throws when percentages sum to more than 100', () => {
      expect(() => buildPrism(
        { pubkey: PK_A, percentage: 60 },
        { pubkey: PK_B, percentage: 60 },
      )).toThrow(/100/);
    });

    it('throws when percentages sum to less than 100', () => {
      expect(() => buildPrism(
        { pubkey: PK_A, percentage: 30 },
        { pubkey: PK_B, percentage: 30 },
      )).toThrow(/100/);
    });

    it('throws when percentages sum to 0', () => {
      expect(() => buildPrism(
        { pubkey: PK_A, percentage: 0 },
        { pubkey: PK_B, percentage: 0 },
      )).toThrow(/100/);
    });

    it('error message includes actual total received', () => {
      try {
        buildPrism(
          { pubkey: PK_A, percentage: 60 },
          { pubkey: PK_B, percentage: 20 },
        );
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('80');
      }
    });
  });

  describe('split arithmetic correctness', () => {
    it('platform fee scenario: 97% seller + 3% platform', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 97 },
        { pubkey: PK_B, percentage: 3 },
      );
      const sellerWeight = result.find(r => r.pubkey === PK_A)!.weight ?? 0;
      const platformWeight = result.find(r => r.pubkey === PK_B)!.weight ?? 0;
      // With 100_000 msats zap: seller gets ~97_000, platform gets ~3_000
      const zapMsats = 100_000;
      const sellerSats = Math.round(zapMsats * sellerWeight / 100);
      const platformSats = Math.round(zapMsats * platformWeight / 100);
      expect(sellerSats).toBe(97_000);
      expect(platformSats).toBe(3_000);
      expect(sellerSats + platformSats).toBe(zapMsats);
    });

    it('multi-creator scenario: no value is lost in split', () => {
      const result = buildPrism(
        { pubkey: PK_A, percentage: 40 },
        { pubkey: PK_B, percentage: 35 },
        { pubkey: PK_C, percentage: 15 },
        { pubkey: PK_D, percentage: 10 },
      );
      const zapMsats = 1_000_000;
      const distributed = result.reduce((s, r) => {
        return s + Math.round(zapMsats * (r.weight ?? 0) / 100);
      }, 0);
      // Allow 1 msat rounding error per recipient
      expect(Math.abs(distributed - zapMsats)).toBeLessThanOrEqual(result.length);
    });
  });
});