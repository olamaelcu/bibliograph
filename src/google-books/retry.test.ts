import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	TRANSIENT_CODES,
	isTransientNetworkError,
	withRetry,
} from './client.js';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function transientError(code: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(`transient: ${code}`);
	err.code = code;
	return err;
}

describe('isTransientNetworkError', () => {
	it('returns true for every code in TRANSIENT_CODES', () => {
		for (const code of TRANSIENT_CODES) {
			expect(isTransientNetworkError({ code })).toBe(true);
		}
	});

	it('returns false for an unknown error code', () => {
		expect(isTransientNetworkError({ code: 'INVALID_API_KEY' })).toBe(false);
		expect(isTransientNetworkError(new Error('boom'))).toBe(false);
		expect(isTransientNetworkError(null)).toBe(false);
		expect(isTransientNetworkError(undefined)).toBe(false);
		expect(isTransientNetworkError('a string')).toBe(false);
	});

	it('walks err.cause to find a transient code', () => {
		const cause = transientError('ETIMEDOUT');
		expect(isTransientNetworkError({ cause })).toBe(true);
	});

	it('walks undici AggregateError.errors[] to find a transient code', () => {
		const inner = transientError('ECONNRESET');
		expect(isTransientNetworkError({ errors: [new Error('x'), inner] })).toBe(true);
	});
});

describe('withRetry', () => {
	beforeEach(() => {
		// Pin jitter to 0 so sleep durations are deterministic: 500ms then 1000ms.
		vi.spyOn(Math, 'random').mockReturnValue(0);
	});

	it('returns the first attempt without retrying', async () => {
		const fn = vi.fn(async () => 'ok');
		const result = await withRetry('test', fn);
		expect(result).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('succeeds after two transient failures', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let calls = 0;
		const fn = vi.fn(async () => {
			calls += 1;
			if (calls < 3) throw transientError('ECONNRESET');
			return 'ok';
		});
		const promise = withRetry('test', fn);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(promise).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('gives up after the third transient failure and rethrows', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const fn = vi.fn(async () => {
			throw transientError('ETIMEDOUT');
		});
		const promise = withRetry('test', fn).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(1000);
		const err = await promise;
		expect(err).toBeInstanceOf(Error);
		expect((err as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('does NOT retry non-transient errors', async () => {
		const fn = vi.fn(async () => {
			throw new Error('plain');
		});
		await expect(withRetry('test', fn)).rejects.toThrow('plain');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('does NOT retry when signal.aborted is already true', async () => {
		const controller = new AbortController();
		controller.abort();
		const fn = vi.fn(async () => {
			throw transientError('ECONNRESET');
		});
		await expect(
			withRetry('test', fn, {}, { signal: controller.signal }),
		).rejects.toThrow();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('respects signal.aborted triggered mid-backoff', async () => {
		// Plain fake timers (no shouldAdvanceTime) so the abort genuinely races the sleep.
		vi.useFakeTimers();
		const controller = new AbortController();
		const fn = vi.fn(async () => {
			throw transientError('ECONNRESET');
		});
		// Attach the rejection handler immediately to avoid the unhandled-rejection race.
		const result = withRetry('test', fn, {}, { signal: controller.signal }).catch(
			(err: unknown) => err,
		);
		// Drain microtasks so the first attempt has thrown and the 500ms sleep is queued.
		await vi.advanceTimersByTimeAsync(0);
		// Abort fires while the backoff is still pending.
		controller.abort();
		// Advance past the end of the backoff. The loop will call fn a second time,
		// the second catch will see `aborted` and throw — proving the abort is honored.
		await vi.advanceTimersByTimeAsync(600);
		const err = await result;
		expect(err).toBeInstanceOf(Error);
		expect((err as NodeJS.ErrnoException).code).toBe('ECONNRESET');
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
