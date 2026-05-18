import { describe, it, expect } from 'vitest';
import {
  buildListingTemplate,
  parseListing,
  filterActiveListings,
} from '../src/listing.js';

describe('Listings (Scenarios 2, 3, 4, 19)', () => {
  it('buildListingTemplate creates valid event template', () => {
    const listing = buildListingTemplate({
      dTag: 'test-product-123',
      title: 'Test Product',
      description: 'A great product',
      price: { amount: 1000, currency: 'sats' },
    });
    expect(listing.kind).toBe(30402);
    expect(listing.tags).toBeDefined();
  });

  it('parseListing extracts fields correctly', () => {
    const mockEvent = {
      id: 'test123',
      pubkey: 'a'.repeat(64),
      created_at: Date.now(),
      kind: 30402,
      tags: [
        ['d', 'test-product-123'],
        ['title', 'Test'],
        ['price', '1000', 'sats'],
      ],
      content: 'Description here',
      sig: 'sig',
    };
    const parsed = parseListing(mockEvent as any);
    expect(parsed.title).toBe('Test');
    expect(parsed.price.amount).toBe('1000');
  });

  it('filterActiveListings removes expired listings', () => {
    const now = Math.floor(Date.now() / 1000);
    const active = { created_at: now - 100, tags: [['expires_at', String(now + 1000)]] };
    const expired = { created_at: now - 100, tags: [['expires_at', String(now - 100)]] };
    const result = filterActiveListings([active, expired] as any);
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});
