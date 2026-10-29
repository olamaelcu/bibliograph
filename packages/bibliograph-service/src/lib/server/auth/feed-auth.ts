// Feed authentication module for ATProto feed generator endpoints.
// Uses @atcute/xrpc-server/auth ServiceJwtVerifier to validate JWT bearer tokens.
//
// The verifier resolves the *issuer's* DID document to find the signing key.
// Bibliograph only issues tokens to itself (audio: the publisher feed
// generator), so resolution is served straight from the in-process DID
// document — no network round-trip and no third-party issuers.

import { ServiceJwtVerifier } from '@atcute/xrpc-server/auth';
import { AuthRequiredError } from '@atcute/xrpc-server';
import type { DidDocumentResolver } from '@atcute/identity-resolver';
import type { Did } from '@atcute/lexicons/syntax';
import { getDidDocument, PUBLISHER_DID } from '../did';
import { createLogger } from '../logger';

const log = createLogger('feed-auth');

const resolver = {
	async resolve(did: string) {
		const doc = getDidDocument();
		if (doc.id === did) {
			return doc;
		}
		throw new Error(`DID not found: ${did}`);
	},
} as unknown as DidDocumentResolver;

let verifier: ServiceJwtVerifier | null = null;

function getVerifier(): ServiceJwtVerifier {
	if (!verifier) {
		verifier = new ServiceJwtVerifier({
			acceptAudiences: [PUBLISHER_DID as Did, `${PUBLISHER_DID}#atproto_feed` as `${Did}#${string}`],
			resolver,
			maxAge: 300,
		});
	}
	return verifier;
}

export async function verifyFeedAuth(request: Request): Promise<string | null> {
	try {
		const v = getVerifier();
		const result = await v.verifyRequest(request, {
			lxm: 'com.atproto.feed.getFeedSkeleton',
		});
		return result.issuer;
	} catch (err) {
		// Missing or invalid Authorization header -> optional auth returns null
		if (err instanceof AuthRequiredError) {
			return null;
		}
		if (err && typeof err === 'object' && 'error' in err && err.error === 'AuthenticationRequired') {
			return null;
		}
		log.warn({ err }, 'feed-auth: unexpected verification error');
		return null;
	}
}

export async function requireFeedAuth(request: Request): Promise<string> {
	const did = await verifyFeedAuth(request);
	if (!did) {
		throw new AuthRequiredError({
			status: 401,
			error: 'AuthenticationRequired',
			message: 'Dynamic feed requires a valid JWT bearer token (lxm: com.atproto.feed.getFeedSkeleton)',
			wwwAuthenticate: { scheme: 'Bearer' },
		});
	}
	return did;
}
