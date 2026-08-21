import { beforeEach, describe, expect, it } from 'vitest';
import { cacheClear, cacheGet, cacheSet } from './cache.js';

describe('cache', () => {
	beforeEach(() => cacheClear());

	it('returns the stored value after cacheSet', () => {
		cacheSet('k', 42, 60_000);
		expect(cacheGet('k')).toBe(42);
	});

	it('returns undefined for a missing key', () => {
		expect(cacheGet('missing')).toBeUndefined();
	});

	it('returns undefined and removes the entry when expired', () => {
		const t0 = 1_000_000;
		cacheSet('k', 'value', 1000, t0);
		expect(cacheGet('k', t0)).toBe('value');
		expect(cacheGet('k', t0 + 1000)).toBeUndefined();
		expect(cacheGet('k', t0 + 1001)).toBeUndefined();
	});

	it('stores distinct values for distinct keys', () => {
		cacheSet('a', 1, 60_000);
		cacheSet('b', 2, 60_000);
		cacheSet('c', 3, 60_000);
		expect(cacheGet('a')).toBe(1);
		expect(cacheGet('b')).toBe(2);
		expect(cacheGet('c')).toBe(3);
	});

	it('overwrites the value for an existing key', () => {
		cacheSet('k', 'first', 60_000);
		cacheSet('k', 'second', 60_000);
		expect(cacheGet('k')).toBe('second');
	});

	it('evicts the oldest entry when the cache is full', () => {
		const n = 10_000;
		for (let i = 0; i < n; i++) {
			cacheSet(`k:${i}`, i, 60_000);
		}
		expect(cacheGet('k:0')).toBe(0);
		cacheSet(`k:${n}`, n, 60_000);
		expect(cacheGet('k:0')).toBeUndefined();
		expect(cacheGet(`k:${n}`)).toBe(n);
		expect(cacheGet(`k:${n - 1}`)).toBe(n - 1);
	});

	it('clears all entries on cacheClear', () => {
		cacheSet('a', 1, 60_000);
		cacheSet('b', 2, 60_000);
		expect(cacheGet('a')).toBe(1);
		expect(cacheGet('b')).toBe(2);
		cacheClear();
		expect(cacheGet('a')).toBeUndefined();
		expect(cacheGet('b')).toBeUndefined();
	});
});