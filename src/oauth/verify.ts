import { createHash } from 'node:crypto';
import {
	calculateJwkThumbprint,
	decodeJwt,
	decodeProtectedHeader,
	importJWK,
	jwtVerify,
	type JWK,
} from 'jose';
import { AuthRequiredError } from '@atcute/xrpc-server';
import { getServiceDid } from '../did.js';
import { resolveAuthServer, type MetadataOpts } from './metadata.js';
import { isValidNonce } from './nonce.js';

export interface VerifiedRequest {
	did: string;
	scope: string;
}

const DPOP_IAT_TOLERANCE_SECONDS = 5 * 60;

function authError(message: string): never {
	throw new AuthRequiredError({ status: 401, error: 'AuthRequired', message });
}

function base64urlSha256(input: string): string {
	return createHash('sha256').update(input).digest('base64url');
}

/** Normalize a request URL to scheme://host/path, honoring reverse-proxy headers. */
function normalizedRequestUrl(request: Request): string {
	const url = new URL(request.url);
	const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
	const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
	return `${proto}://${host}${url.pathname}`;
}

/**
 * Verify a DPoP-bound OAuth access token per atproto.com/specs/oauth + RFC 9449:
 * resolve the token's issuer JWKS, verify the access-token JWT, then verify the
 * DPoP proof (signature, key binding via `cnf.jkt`, `htm`/`htu`/`ath`, freshness,
 * nonce). Throws `AuthRequiredError` (401) on any failure.
 */
export async function verifyRequest(request: Request, opts?: MetadataOpts): Promise<VerifiedRequest> {
	const authHeader = request.headers.get('authorization');
	if (!authHeader) authError('missing authorization header');
	const match = /^DPoP\s+(.+)$/i.exec(authHeader);
	if (!match) authError('expected a DPoP-bound access token');
	const accessToken = match[1];

	const dpopHeader = request.headers.get('dpop');
	if (!dpopHeader) authError('missing DPoP proof');

	let unverified: { iss?: unknown };
	try {
		unverified = decodeJwt(accessToken);
	} catch {
		return authError('malformed access token');
	}
	if (typeof unverified.iss !== 'string' || !unverified.iss) {
		return authError('access token missing iss claim');
	}

	const { jwks } = await resolveAuthServer(unverified.iss, opts);

	const expectedAud = getServiceDid();
	let sub: string;
	let scope: string;
	let cnfJkt: string;
	try {
		const { payload } = await jwtVerify(accessToken, jwks, {
			typ: 'at+jwt',
			algorithms: ['ES256'],
			issuer: unverified.iss,
		});
		if (typeof payload.sub !== 'string' || !payload.sub.startsWith('did:')) {
			return authError('invalid sub claim');
		}
		const audList = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
		const audMatches = audList.some((a) => a === expectedAud || a.split('#')[0] === expectedAud);
		if (!audMatches) return authError(`aud mismatch: expected ${expectedAud}`);

		scope = typeof payload.scope === 'string' ? payload.scope : '';
		if (!scope.split(' ').includes('atproto')) return authError('missing atproto scope');

		const cnf = payload.cnf as { jkt?: unknown } | undefined;
		if (typeof cnf?.jkt !== 'string' || !cnf.jkt) return authError('access token missing cnf.jkt');

		sub = payload.sub;
		cnfJkt = cnf.jkt;
	} catch (err) {
		if (err instanceof AuthRequiredError) throw err;
		return authError('invalid access token');
	}

	let proofHeader: { typ?: unknown; alg?: unknown; jwk?: unknown };
	try {
		proofHeader = decodeProtectedHeader(dpopHeader);
	} catch {
		return authError('malformed DPoP proof');
	}
	if (proofHeader.typ !== 'dpop+jwt') return authError('invalid DPoP proof typ');
	if (typeof proofHeader.alg !== 'string') return authError('invalid DPoP proof alg');
	const jwk = proofHeader.jwk as JWK | undefined;
	if (!jwk) return authError('DPoP proof missing jwk header');

	let proofKey: Parameters<typeof jwtVerify>[1];
	try {
		proofKey = (await importJWK(jwk, proofHeader.alg)) as never;
	} catch {
		return authError('invalid DPoP proof jwk');
	}

	let dpopPayload: { htm?: unknown; htu?: unknown; ath?: unknown; jti?: unknown; iat?: unknown; nonce?: unknown };
	try {
		const { payload } = await jwtVerify(dpopHeader, proofKey, {
			typ: 'dpop+jwt',
			algorithms: ['ES256'],
		});
		dpopPayload = payload;
	} catch {
		return authError('invalid DPoP proof signature');
	}

	const jkt = await calculateJwkThumbprint(jwk, 'sha256');
	if (jkt !== cnfJkt) return authError('DPoP proof key does not match token binding');

	if (typeof dpopPayload.htm !== 'string' || dpopPayload.htm.toUpperCase() !== request.method.toUpperCase()) {
		return authError('DPoP htm mismatch');
	}
	if (typeof dpopPayload.htu !== 'string' || dpopPayload.htu !== normalizedRequestUrl(request)) {
		return authError('DPoP htu mismatch');
	}
	if (typeof dpopPayload.ath !== 'string' || dpopPayload.ath !== base64urlSha256(accessToken)) {
		return authError('DPoP ath mismatch');
	}
	if (typeof dpopPayload.jti !== 'string' || !dpopPayload.jti) {
		return authError('DPoP proof missing jti');
	}
	if (typeof dpopPayload.iat !== 'number' || Math.abs(Date.now() / 1000 - dpopPayload.iat) > DPOP_IAT_TOLERANCE_SECONDS) {
		return authError('DPoP proof iat out of range');
	}
	if (dpopPayload.nonce != null) {
		if (typeof dpopPayload.nonce !== 'string' || !isValidNonce(dpopPayload.nonce)) {
			return authError('DPoP nonce mismatch');
		}
	}

	return { did: sub, scope };
}
