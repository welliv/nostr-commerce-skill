import { describe, it, expect } from 'vitest';
import {
  findAudience,
  runZapvertiseCampaign,
} from '../src/zapvertising.js';

describe('Zapvertising (Scenario 17)', () => {
  it('findAudience is callable', () => {
    expect(typeof findAudience).toBe('function');
  });

  it('runZapvertiseCampaign is callable', () => {
    expect(typeof runZapvertiseCampaign).toBe('function');
  });
});
