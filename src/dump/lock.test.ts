import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock } from './lock.js';

describe('lock', () => {
  it('acquires, rejects second holder, releases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-lock-'));
    const path = join(dir, 'lock');
    try {
      expect(acquireLock(path)).toBe(true);
      expect(acquireLock(path)).toBe(false);
      releaseLock(path);
      expect(acquireLock(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('force overrides stale lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-lock-'));
    const path = join(dir, 'lock');
    try {
      expect(acquireLock(path)).toBe(true);
      expect(acquireLock(path, true)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
