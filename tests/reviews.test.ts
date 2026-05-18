import { describe, it, expect } from 'vitest';
import {
  parseReview,
  summarizeRatings,
  verifyPreimage,
} from '../src/reviews.js';

describe('Reviews (Scenario 10)', () => {
  it('parseReview extracts rating and content', () => {
    const event = {
      id: 'r1',
      pubkey: 'p1',
      created_at: Date.now(),
      kind: 1,
      tags: [['e', 'listing123'], ['rating', '5']],
      content: 'Excellent product!',
      sig: 'sig',
    };
    const parsed = parseReview(event as any);
    expect(parsed.rating).toBe(5);
    expect(parsed.content).toContain('Excellent');
  });

  it('summarizeRatings calculates average correctly', () => {
    const reviews = [
      { rating: 5 }, { rating: 4 }, { rating: 5 },
    ] as any;
    const summary = summarizeRatings(reviews);
    expect(summary.average).toBeCloseTo(4.67);
    expect(summary.total).toBe(3);
  });

  it('verifyPreimage is callable', () => {
    expect(typeof verifyPreimage).toBe('function');
  });
});
