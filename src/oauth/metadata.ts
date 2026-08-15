import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from 'jose';
import { getPdsEndpoint } from '@atcute/identity';
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	AtprotoWebDidDocumentResolver,
} from '@atcute/identity-resolver';
import type { Did } from '@atcute/lexicons/syntax';
import { AuthRequiredError, XRPCError } from '@atcute/xrpc-server';

/**
 * Resolves an OAuth `iss` claim (a DID or an origin URL) to authorization-server
 * metadata and a remote JWKS, per atproto.com/specs/oauth. Metadata/JWKS are
 * cached per issuer so a hot path doesn't refetch on every request.
 */

interface AuthServerMetadata {
	issuer: string;
	jwks_uri: string;
	[key: string]: unknown;
}

export interface ResolvedAuthServer {
	metadata: AuthServerMetadata;
	jwks: JWTVerifyGetKey;
}

export interface MetadataOpts {
	fetchFn?: typeof fetch;
}

const METADATA_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { entry: ResolvedAuthServer; expiresAt: number }>();

function makeDidResolver(fetchFn: typeof fetch): CompositeDidDocumentResolver<'plc' | 'web'> {
	return new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver({ fetch: fetchFn }),
			web: new AtprotoWebDidDocumentResolver({ fetch: fetchFn }),
		},
	});
}

function unresolvableIssuer(iss: string): never {
	throw new AuthRequiredError({
		status: 401,
		error: 'AuthRequired',
		message: `unable to resolve authorization server for issuer: ${iss}`,
	});
}

function transientFailure(message: string): never {
	throw new XRPCError({ status: 500, error: 'InternalServerError', message });
}

async function resolveIssuerOrigin(iss: string, fetchFn: typeof fetch): Promise<string> {
	if (iss.startsWith('did:')) {
		let doc: Awaited<ReturnType<CompositeDidDocumentResolver<'plc' | 'web'>['resolve']>>;
		try {
			doc = await makeDidResolver(fetchFn).resolve(iss as Did<'plc' | 'web'>);
		} catch {
			return unresolvableIssuer(iss);
		}
		const pdsUrl = getPdsEndpoint(doc);
		if (!pdsUrl) return unresolvableIssuer(iss);
		return new URL(pdsUrl).origin;
	}
	try {
		return new URL(iss).origin;
	} catch {
		return unresolvableIssuer(iss);
	}
}

/** Resolve `iss` → authorization-server metadata → remote JWKS, with caching. */
export async function resolveAuthServer(iss: string, opts?: MetadataOpts): Promise<ResolvedAuthServer> {
	const cached = cache.get(iss);
	if (cached && cached.expiresAt > Date.now()) return cached.entry;

	const fetchFn = opts?.fetchFn ?? fetch;
	const origin = await resolveIssuerOrigin(iss, fetchFn);
	const metadataUrl = `${origin}/.well-known/oauth-authorization-server`;

	let res: Response;
	try {
		res = await fetchFn(metadataUrl);
	} catch {
		return transientFailure(`failed to fetch authorization-server metadata: ${metadataUrl}`);
	}
	if (!res.ok) {
		if (res.status >= 500) transientFailure(`authorization-server metadata fetch failed (${res.status})`);
		return unresolvableIssuer(iss);
	}

	let metadata: AuthServerMetadata;
	try {
		metadata = (await res.json()) as AuthServerMetadata;
	} catch {
		return unresolvableIssuer(iss);
	}
	// The metadata's `issuer` must match where it was actually fetched from
	// (RFC 8414 §3.3): the resolved origin, not necessarily the token's raw
	// `iss` claim, which may have been a DID that resolved to this origin.
	if (metadata.issuer !== origin || typeof metadata.jwks_uri !== 'string') {
		return unresolvableIssuer(iss);
	}

	let jwksUrl: URL;
	try {
		jwksUrl = new URL(metadata.jwks_uri);
	} catch {
		return unresolvableIssuer(iss);
	}
	const jwks = createRemoteJWKSet(jwksUrl, { [customFetch]: fetchFn as never });

	const entry: ResolvedAuthServer = { metadata, jwks };
	cache.set(iss, { entry, expiresAt: Date.now() + METADATA_TTL_MS });
	return entry;
}
