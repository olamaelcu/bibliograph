import { describe, expect, it } from 'vitest';
import { isTransientNetworkError, withRetry } from './network.js';

function transientError(code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`connect ${code} 49.13.238.125:443`), { code }),
  });
}

describe('isTransientNetworkError', () => {
  it('classifies undici fetch failures with a transient cause', () => {
    expect(isTransientNetworkError(transientError('ECONNRESET'))).toBe(true);
    expect(isTransientNetworkError(transientError('ECONNREFUSED'))).toBe(true);
    expect(isTransientNetworkError(transientError('ETIMEDOUT'))).toBe(true);
    expect(isTransientNetworkError(transientError('ENOTFOUND'))).toBe(true);
    expect(isTransientNetworkError(transientError('EAI_AGAIN'))).toBe(true);
  });

  it('classifies aggregate causes (one per tried address)', () => {
    const err = new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }),
        Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      ]),
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns false when no code is present or the code is not transient', () => {
    expect(isTransientNetworkError(new TypeError('fetch failed', { cause: new Error('boom') }))).toBe(false);
    expect(isTransientNetworkError(new Error('boom'))).toBe(false);
    expect(isTransientNetworkError(transientError('EACCES'))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries a transient failure then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      'boom',
      async () => {
        calls += 1;
        if (calls < 2) throw transientError('ECONNREFUSED');
        return 'ok';
      },
      {},
      { baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('rethrows non-transient errors immediately', async () => {
    let calls = 0;
    await expect(
      withRetry('boom', async () => {
        calls += 1;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('exhausts attempts for a persistent transient failure', async () => {
    let calls = 0;
    await expect(
      withRetry(
        'boom',
        async () => {
          calls += 1;
          throw transientError('ECONNREFUSED');
        },
        {},
        { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(2);
  });
});
