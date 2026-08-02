import { describe, it, expect } from 'vitest';
import { requestTracing } from './middleware.js';

function mockContext(overrides: {
  headers?: Record<string, string>;
  method?: string;
  path?: string;
} = {}) {
  const store = new Map<string, unknown>();
  const headers = overrides.headers || {};

  let responseStatus = 200;

  const c = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    req: {
      header: (name: string) => headers[name] || null,
      raw: {
        headers: new Headers(headers),
      },
      method: overrides.method || 'GET',
      path: overrides.path || '/test',
    },
    res: {
      status: responseStatus,
      headers: new Headers(),
    },
    set status(code: number) {
      responseStatus = code;
    },
  };

  return c as any;
}

describe('requestTracing', () => {
  it('sets requestId and log in context', async () => {
    const ctx = mockContext();

    await requestTracing(ctx, async () => {});

    const reqId = ctx.get('requestId');
    expect(reqId).toBeDefined();
    expect(typeof reqId).toBe('string');
  });

  it('uses X-Request-Id header when present', async () => {
    const ctx = mockContext({
      headers: { 'X-Request-Id': 'custom-id-123' },
    });

    await requestTracing(ctx, async () => {});

    expect(ctx.get('requestId')).toBe('custom-id-123');
  });

  it('generates UUID when no X-Request-Id header', async () => {
    const ctx = mockContext();

    await requestTracing(ctx, async () => {});

    const reqId = ctx.get('requestId') as string;
    expect(reqId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('passes through to next middleware', async () => {
    const ctx = mockContext();
    let called = false;

    await requestTracing(ctx, async () => {
      called = true;
    });

    expect(called).toBe(true);
  });

  it('still throws errors from next middleware', async () => {
    const ctx = mockContext();

    await expect(
      requestTracing(ctx, async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');
  });
});
