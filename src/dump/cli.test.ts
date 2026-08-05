import { describe, it, expect } from 'vitest';
import { OL_DUMP_BATCH_SIZE_DEFAULT_FOR_TESTS as resolver } from './cli.js';

describe('cli batch-size env handling', () => {
  it('falls back to 500 for empty / NaN / non-positive env values', () => {
    expect(resolver('')).toBe(500);
    expect(resolver('NaN')).toBe(500);
    expect(resolver('0')).toBe(500);
    expect(resolver('-1')).toBe(500);
    expect(resolver('not-a-number')).toBe(500);
    expect(resolver('500')).toBe(500);
    expect(resolver('1000')).toBe(1000);
  });
});