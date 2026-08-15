import type { MetadataOpts } from './metadata.js';
import { verifyRequest } from './verify.js';

export interface OauthIdentity {
	did: string;
}

export type AuthOpts = MetadataOpts;

/** Require a valid DPoP-bound OAuth access token; throws 401 otherwise. */
export async function authenticate(request: Request, opts?: AuthOpts): Promise<OauthIdentity> {
	const { did } = await verifyRequest(request, opts);
	return { did };
}

/** Same as `authenticate`, but returns `undefined` when no Authorization header is present. */
export async function authenticateOptional(request: Request, opts?: AuthOpts): Promise<OauthIdentity | undefined> {
	if (!request.headers.get('authorization')) return undefined;
	return authenticate(request, opts);
}
