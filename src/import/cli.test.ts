import { describe, expect, it } from 'vitest';

describe('import CLI wiring', () => {
  it('loads the dispatcher module', async () => {
    const mod = await import('./cli.js');
    expect(mod).toBeDefined();
    expect(typeof mod.main).toBe('function');
  });
});
