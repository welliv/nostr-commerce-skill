import { describe, it, expect } from 'vitest';
import {
  buildPrism,
  summarizeZaps,
} from '../src/zaps.js';

describe('Zaps & Prisms (Scenarios 13, 14)', () => {
  it('summarizeZaps is callable', () => {
    expect(typeof summarizeZaps).toBe('function');
  });

  it('buildPrism throws when given insufficient recipients', () => {
    expect(() => buildPrism([{ pubkey: 'a'.repeat(64), percentage: 100 }])).toThrow();
  });
});