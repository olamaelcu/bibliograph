import { AuthRequiredError, InvalidRequestError } from '@atcute/xrpc-server';
import { getServiceDid } from '../did.js';

export interface PdsSession {
	did: string;
	handle?: string;
	pdsUrl: string;
	token: string;
}

export interface AuthOpts {
	fetchFn?: typeof fetch;
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

function authError(message: string): never {
	throw new AuthRequiredError({ error: 'AuthRequired', message });
}

function invalidRequest(message: string): never {
	throw new InvalidRequestError({ error: 'InvalidRequest', message });
}

function bearerToken(request: Request): string | undefined {
	const header = request.headers.get('authorization');
	if (!header) return undefined;
	const match = BEARER_RE.exec(header);
	if (!match) authError('invalid authorization header');
	return match![1];
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split('.');
	if (parts.length !== 3 || parts[1] === '') authError('malformed token');

	let json: string;
	try {
		json = Buffer.from(parts[1], 'base64url').toString('utf8');
	} catch {
		authError('malformed token');
	}

	let payload: unknown;
	try {
		payload = JSON.parse(json);
	} catch {
		authError('malformed token');
	}
	if (typeof payload !== 'object' || payload === null) authError('malformed token');
	return payload as Record<string, unknown>;
}

export async function authenticate(request: Request, opts?: AuthOpts): Promise<PdsSession> {
	const token = bearerToken(request);
	if (!token) authError('missing bearer token');
	return authenticateToken(token, opts?.fetchFn);
}

export async function authenticateOptional(
	request: Request,
	opts?: AuthOpts,
): Promise<PdsSession | undefined> {
	const token = bearerToken(request);
	if (!token) return undefined;
	return authenticateToken(token, opts?.fetchFn);
}

async function authenticateToken(token: string, fetchFn?: typeof fetch): Promise<PdsSession> {
	const { sub, aud } = decodeJwtPayload(token);
	if (typeof sub !== 'string' || !sub.startsWith('did:')) {
		invalidRequest(`invalid sub claim: ${String(sub)}`);
	}
	if (typeof aud !== 'string') invalidRequest('invalid aud claim');

	const expected = getServiceDid();
	// accept a bare DID or one carrying a fragment (e.g. `did:web:localhost#atproto`)
	if (aud.split('#')[0] !== expected) {
		invalidRequest(`aud mismatch: expected ${expected}, got ${aud}`);
	}

	const { pdsUrl, handle } = await resolvePds(sub, fetchFn);
	return { did: sub, handle, pdsUrl, token };
}

export async function resolveDidDocument(did: string, fetchFn?: typeof fetch): Promise<unknown> {
	const url = didDocumentUrl(did);

	let res: Response;
	try {
		res = await (fetchFn ?? fetch)(url);
	} catch {
		invalidRequest(`failed to resolve DID document for ${did}`);
	}
	if (!res.ok) invalidRequest(`DID document fetch failed (${res.status}) for ${did}`);

	try {
		return await res.json();
	} catch {
		invalidRequest(`invalid DID document for ${did}`);
	}
}

async function resolvePds(did: string, fetchFn?: typeof fetch): Promise<{ pdsUrl: string; handle?: string }> {
	const doc = (await resolveDidDocument(did, fetchFn)) as Record<string, unknown>;

	const service = Array.isArray(doc.service) ? doc.service : [];
	const entry = service.find((s) => {
		if (typeof s !== 'object' || s === null) return false;
		const svc = s as Record<string, unknown>;
		return (
			typeof svc.id === 'string' &&
			svc.id.endsWith('#atproto_pds') &&
			svc.type === 'AtprotoPersonalDataServer'
		);
	});
	const pdsUrl = entry ? (entry as Record<string, unknown>).serviceEndpoint : undefined;
	if (typeof pdsUrl !== 'string' || !/^https?:\/\//.test(pdsUrl)) {
		invalidRequest(`no atproto_pds service in DID document for ${did}`);
	}

	const alsoKnownAs = Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : [];
	const first = alsoKnownAs[0];
	const handle =
		typeof first === 'string' && first.startsWith('at://') ? first.slice('at://'.length) : undefined;

	return { pdsUrl, handle };
}

function didDocumentUrl(did: string): string {
	if (did.startsWith('did:web:')) {
		return `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
	}
	const directory = process.env.ATP_PLC_DIRECTORY || 'https://plc.directory';
	return `${directory}/${did}`;
}
