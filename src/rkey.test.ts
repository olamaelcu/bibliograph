import { describe, it, expect } from 'vitest';
import { generateRkey } from './rkey.js';

describe('generateRkey', () => {
  it('returns a 13-char string from the safe alphabet', () => {
    const rkey = generateRkey();
    expect(rkey).toMatch(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);
  });

  it('produces distinct values across calls', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateRkey()));
    expect(set.size).toBe(100);
  });
});
