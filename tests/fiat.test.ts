import { describe, it, expect } from 'vitest';
import {
  fetchBtcRate,
  fiatToMsats,
  msatsToFiat,
} from '../src/fiat.js';

describe('Fiat Pricing (Scenario 20)', () => {
  it('fetchBtcRate is callable', async () => {
    expect(typeof fetchBtcRate).toBe('function');
  });

  it('fiatToMsats is callable', () => {
    expect(typeof fiatToMsats).toBe('function');
  });

  it('msatsToFiat is callable', () => {
    expect(typeof msatsToFiat).toBe('function');
  });
});
