import { randomBytes } from 'node:crypto';
import type { Context, Next } from 'hono';

/**
 * Rotating DPoP nonce. A single in-memory value per process is enough here:
 * Bibliograph is a resource server (not an authorization server), so the
 * nonce only needs to be unpredictable and short-lived — it is never
 * persisted or looked up by value, just compared against the last two
 * generated values so a proof minted just before a rotation still verifies.
 */
const ROTATE_INTERVAL_MS = 5 * 60 * 1000;

function generateNonce(): string {
	return randomBytes(18).toString('base64url');
}

let current = generateNonce();
let previous: string | null = null;
let rotatedAt = Date.now();

function rotateIfDue(): void {
	if (Date.now() - rotatedAt < ROTATE_INTERVAL_MS) return;
	previous = current;
	current = generateNonce();
	rotatedAt = Date.now();
}

export function currentNonce(): string {
	rotateIfDue();
	return current;
}

/** DPoP proofs are lenient about nonces: absent is accepted, present must match. */
export function isValidNonce(nonce: string): boolean {
	rotateIfDue();
	return nonce === current || nonce === previous;
}

/** Hono middleware: stamps `DPoP-Nonce` on every response. */
export async function dpopNonceMiddleware(c: Context, next: Next): Promise<void> {
	await next();
	c.res.headers.set('DPoP-Nonce', currentNonce());
}
