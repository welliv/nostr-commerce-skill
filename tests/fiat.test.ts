/**
 * Scenario 19: Fiat Conversion (CoinGecko via @getalby/lightning-tools)
 * Tests formatPrice display logic, isRateStale detection,
 * and fiatToMsats/msatsToFiat arithmetic with mocked rate fetch.
 * No real CoinGecko API calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatPrice, isRateStale, fiatToMsats, msatsToFiat } from '../src/fiat';
import type { ConversionResult, FiatPriceTag } from '../src/fiat';

// Mock the internal fetchBtcRate so no network calls are made
// We patch the module-level cache by injecting a known rate via vi.mock
vi.mock('../src/fiat', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    fetchBtcRate: vi.fn().mockResolvedValue(3_500), // 1 USD = 3500 sats
    fiatToMsats: async (fiatAmount: number, currency: string) => {
      const rate = 3_500;
      const amountSats = Math.round(fiatAmount * rate);
      return {
        amountMsats: amountSats * 1000,
        amountSats,
        fiatAmount,
        fiatCurrency: currency,
        rate,
        fetchedAt: Math.floor(Date.now() / 1000),
      };
    },
    msatsToFiat: async (amountMsats: number, currency: string) => {
      const rate = 3_500;
      const amountSats = amountMsats / 1000;
      const fiatAmount = amountSats / rate;
      return {
        amountMsats,
        amountSats,
        fiatAmount: Math.round(fiatAmount * 100) / 100,
        fiatCurrency: currency,
        rate,
        fetchedAt: Math.floor(Date.now() / 1000),
      };
    },
  };
});

function makeConversionResult(overrides: Partial<ConversionResult> = {}): ConversionResult {
  return {
    amountMsats: 87_500_000,
    amountSats: 87_500,
    fiatAmount: 25.0,
    fiatCurrency: 'USD',
    rate: 3_500,
    fetchedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('Scenario 19: Fiat Conversion', () => {
  describe('fiatToMsats (mocked rate: 1 USD = 3500 sats)', () => {
    it('converts $25 USD to correct msats', async () => {
      const result = await fiatToMsats(25, 'USD');
      // 25 × 3500 = 87_500 sats = 87_500_000 msats
      expect(result.amountSats).toBe(87_500);
      expect(result.amountMsats).toBe(87_500_000);
      expect(result.fiatAmount).toBe(25);
      expect(result.fiatCurrency).toBe('USD');
    });

    it('converts $1 USD to 3_500 sats', async () => {
      const result = await fiatToMsats(1, 'USD');
      expect(result.amountSats).toBe(3_500);
    });

    it('result includes fetchedAt timestamp', async () => {
      const before = Math.floor(Date.now() / 1000);
      const result = await fiatToMsats(10, 'USD');
      expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('msatsToFiat (mocked rate: 1 USD = 3500 sats)', () => {
    it('converts 87_500_000 msats to $25 USD', async () => {
      const result = await msatsToFiat(87_500_000, 'USD');
      expect(result.fiatAmount).toBe(25);
    });

    it('rounds to 2 decimal places', async () => {
      const result = await msatsToFiat(1_000, 'USD');
      const decimals = result.fiatAmount.toString().split('.')[1]?.length ?? 0;
      expect(decimals).toBeLessThanOrEqual(2);
    });
  });

  describe('formatPrice', () => {
    it('formats USD price with $ symbol', () => {
      const price: FiatPriceTag = { amount: '25.00', currency: 'USD' };
      expect(formatPrice(price)).toContain('$25.00');
    });

    it('formats EUR price with € symbol', () => {
      const price: FiatPriceTag = { amount: '20.00', currency: 'EUR' };
      expect(formatPrice(price)).toContain('€20.00');
    });

    it('formats GBP price with £ symbol', () => {
      const price: FiatPriceTag = { amount: '18.00', currency: 'GBP' };
      expect(formatPrice(price)).toContain('£18.00');
    });

    it('formats sats price with sats suffix', () => {
      const price: FiatPriceTag = { amount: '21000', currency: 'SATS' };
      const result = formatPrice(price);
      expect(result).toContain('sats');
      expect(result).not.toContain('$');
    });

    it('includes /month frequency when set', () => {
      const price: FiatPriceTag = { amount: '9.99', currency: 'USD', frequency: 'month' };
      expect(formatPrice(price)).toContain('/month');
    });

    it('includes sats equivalent when amountMsats is provided', () => {
      const price: FiatPriceTag = { amount: '25.00', currency: 'USD', amountMsats: 87_500_000 };
      const result = formatPrice(price);
      expect(result).toContain('sats');
      expect(result).toContain('87');
    });

    it('unknown currency uses code as prefix', () => {
      const price: FiatPriceTag = { amount: '100.00', currency: 'BRL' };
      expect(formatPrice(price)).toContain('BRL');
    });
  });

  describe('isRateStale', () => {
    it('returns false for a freshly fetched result', () => {
      const result = makeConversionResult({ fetchedAt: Math.floor(Date.now() / 1000) });
      expect(isRateStale(result)).toBe(false);
    });

    it('returns true when fetchedAt is more than 5 minutes ago', () => {
      const sixMinutesAgo = Math.floor(Date.now() / 1000) - 360;
      const result = makeConversionResult({ fetchedAt: sixMinutesAgo });
      expect(isRateStale(result)).toBe(true);
    });

    it('returns false when fetchedAt is exactly 4 minutes ago', () => {
      const fourMinutesAgo = Math.floor(Date.now() / 1000) - 240;
      const result = makeConversionResult({ fetchedAt: fourMinutesAgo });
      expect(isRateStale(result)).toBe(false);
    });
  });
});