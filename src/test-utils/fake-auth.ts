import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, calculateJwkThumbprint, generateKeyPair, type JWK } from 'jose';
import { getServiceDid } from '../did.js';

/**
 * Test double for an atproto OAuth authorization server (the user's PDS).
 * Mints real ES256 `at+jwt` access tokens and `dpop+jwt` proofs, and serves
 * `/.well-known/oauth-authorization-server` + JWKS from a stubbed `fetch` so
 * `src/oauth/*` can be exercised end-to-end without a network.
 */

export interface DpopSignOpts {
	method: string;
	url: string;
	nonce?: string;
	iat?: number;
	/** Override the proof's `ath` claim (defaults to base64url(SHA-256(access token))) — for adversarial tests. */
	athOverride?: string;
	/** Omit the `jti` claim entirely — for adversarial tests. */
	omitJti?: boolean;
}

export interface OauthSession {
	/** The DPoP-bound access token (unprefixed — callers add the `DPoP ` scheme). */
	accessToken: string;
	/** This session's DPoP public key thumbprint (matches the token's `cnf.jkt`). */
	jkt: string;
	/** Sign a fresh DPoP proof for a request against this session's access token. */
	sign(opts: DpopSignOpts): Promise<string>;
	/** Convenience: `{ authorization, dpop }` headers for one request. */
	headers(opts: DpopSignOpts): Promise<{ authorization: string; dpop: string }>;
}

export interface OauthTestKit {
	/** Origin serving authorization-server metadata + JWKS (also usable as a URL `iss`). */
	origin: string;
	/** Answers `.well-known/oauth-authorization-server`, the JWKS, and any registered DID documents. */
	fetch: typeof fetch;
	/** Mint a DPoP-bound session (access token + proof signer) for `did`. */
	mintSession(opts: {
		did: string;
		aud?: string;
		scope?: string;
		iss?: string;
		expSeconds?: number;
		nowSeconds?: number;
	}): Promise<OauthSession>;
	/** Stub a `did:web` document at `did` whose `#atproto_pds` service endpoint is this kit's origin. */
	serveDidWebDocument(did: string): void;
}

function base64urlSha256(input: string): string {
	return createHash('sha256').update(input).digest('base64url');
}

async function generateEs256KeyPair() {
	const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
	const publicJwk = await exportJWK(publicKey);
	return { privateKey, publicJwk };
}

/** Build a `did:web` document whose `#atproto_pds` service points at `serviceEndpoint`. */
export function makeDidDoc(opts: { serviceEndpoint: string; alsoKnownAs?: string[]; id?: string }): Record<string, unknown> {
	return {
		'@context': ['https://www.w3.org/ns/did/v1'],
		id: opts.id ?? 'did:web:alice.example.com',
		alsoKnownAs: opts.alsoKnownAs,
		service: [
			{
				id: '#atproto_pds',
				type: 'AtprotoPersonalDataServer',
				serviceEndpoint: opts.serviceEndpoint,
			},
		],
	};
}

/**
 * Spin up an in-memory OAuth authorization server double: an ES256 signing
 * key, authorization-server metadata, a JWKS, and a `fetch` stub that answers
 * all three (plus any DID documents registered via `serveDidWebDocument`).
 * Everything else falls through to the real global `fetch`.
 */
export async function createOauthTestKit(opts?: { origin?: string }): Promise<OauthTestKit> {
	// Unique per kit by default: `resolveAuthServer` caches metadata/JWKS per
	// issuer at module scope, and that cache persists across tests in the same
	// vitest worker, so a fixed origin would leak one test's signing key into
	// another test that reuses it.
	const origin = opts?.origin ?? `https://pds-${randomUUID()}.example.com`;
	const metadataUrl = `${origin}/.well-known/oauth-authorization-server`;
	const jwksUrl = `${origin}/.well-known/jwks.json`;

	const { privateKey, publicJwk } = await generateEs256KeyPair();
	const kid = randomUUID();
	const signingJwk: JWK = { ...publicJwk, kid, alg: 'ES256', use: 'sig' };

	const metadata = { issuer: origin, jwks_uri: jwksUrl };
	const jwks = { keys: [signingJwk] };

	const didDocs = new Map<string, Record<string, unknown>>();

	const realFetch = globalThis.fetch;
	const fetchStub: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
		const href = url.toString();
		if (href === metadataUrl) {
			return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (href === jwksUrl) {
			return new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (url.pathname === '/.well-known/did.json') {
			const doc = didDocs.get(url.host);
			if (doc) return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		return realFetch(input, init);
	}) as typeof fetch;

	async function mintSession(sessionOpts: {
		did: string;
		aud?: string;
		scope?: string;
		iss?: string;
		expSeconds?: number;
		nowSeconds?: number;
	}): Promise<OauthSession> {
		const { privateKey: dpopPrivateKey, publicJwk: dpopPublicJwk } = await generateEs256KeyPair();
		const jkt = await calculateJwkThumbprint(dpopPublicJwk, 'sha256');

		const now = sessionOpts.nowSeconds ?? Math.floor(Date.now() / 1000);
		const exp = now + (sessionOpts.expSeconds ?? 3600);
		const accessToken = await new SignJWT({
			scope: sessionOpts.scope ?? 'atproto',
			cnf: { jkt },
		})
			.setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid })
			.setIssuer(sessionOpts.iss ?? origin)
			.setSubject(sessionOpts.did)
			.setAudience(sessionOpts.aud ?? getServiceDid())
			.setIssuedAt(now)
			.setExpirationTime(exp)
			.sign(privateKey);

		async function sign(proofOpts: DpopSignOpts): Promise<string> {
			const claims: Record<string, unknown> = {
				htm: proofOpts.method.toUpperCase(),
				htu: proofOpts.url,
				ath: proofOpts.athOverride ?? base64urlSha256(accessToken),
			};
			if (!proofOpts.omitJti) claims.jti = randomUUID();
			if (proofOpts.nonce) claims.nonce = proofOpts.nonce;
			return new SignJWT(claims)
				.setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: dpopPublicJwk })
				.setIssuedAt(proofOpts.iat ?? Math.floor(Date.now() / 1000))
				.sign(dpopPrivateKey);
		}

		return {
			accessToken,
			jkt,
			sign,
			async headers(proofOpts) {
				return { authorization: `DPoP ${accessToken}`, dpop: await sign(proofOpts) };
			},
		};
	}

	function serveDidWebDocument(did: string): void {
		if (!did.startsWith('did:web:')) throw new Error(`not a did:web identifier: ${did}`);
		const host = did.slice('did:web:'.length);
		didDocs.set(host, makeDidDoc({ serviceEndpoint: origin, id: did }));
	}

	return { origin, fetch: fetchStub, mintSession, serveDidWebDocument };
}
