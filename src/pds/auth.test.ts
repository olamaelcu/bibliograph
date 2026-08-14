import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, InvalidRequestError } from '@atcute/xrpc-server';
import { getServiceDid } from '../did.js';
import { makeDidDoc, makeJwt, stubFetch } from '../test-utils/fake-auth.js';
import { authenticate, authenticateOptional } from './auth.js';

afterEach(() => {
	vi.unstubAllGlobals();
});

function requestWith(token: string | null): Request {
	const headers: Record<string, string> = {};
	if (token !== null) headers.authorization = `Bearer ${token}`;
	return new Request('https://books.example.com/xrpc/net.olamaelcu.livtet.biblio.getBook', {
		method: 'POST',
		headers,
	});
}

describe('authenticate', () => {
	it('throws AuthRequiredError when the Authorization header is missing', async () => {
		await expect(authenticate(requestWith(null))).rejects.toThrow(AuthRequiredError);
	});

	it('throws AuthRequiredError on a malformed token', async () => {
		await expect(authenticate(requestWith('not-a-jwt'))).rejects.toThrow(AuthRequiredError);
	});

	it('throws AuthRequiredError on an undecodable payload', async () => {
		await expect(authenticate(requestWith('a.eyJmb28i.sig'))).rejects.toThrow(AuthRequiredError);
	});

	it('throws InvalidRequestError when sub is not a DID', async () => {
		const token = makeJwt({ sub: 'not-a-did', aud: getServiceDid() });
		await expect(authenticate(requestWith(token))).rejects.toThrow(InvalidRequestError);
	});

	it('throws InvalidRequestError when aud does not match the service DID', async () => {
		const token = makeJwt({ sub: 'did:web:alice.example.com', aud: 'did:web:someone-else' });
		await expect(authenticate(requestWith(token))).rejects.toThrow(InvalidRequestError);
	});

	it('resolves a did:web token against the stubbed DID document', async () => {
		vi.stubGlobal(
			'fetch',
			stubFetch(
				makeDidDoc({
					serviceEndpoint: 'https://pds.alice.example.com',
					alsoKnownAs: ['at://alice.example.com'],
				}),
			),
		);
		const token = makeJwt({ sub: 'did:web:alice.example.com', aud: getServiceDid() });

		const session = await authenticate(requestWith(token));
		expect(session.did).toBe('did:web:alice.example.com');
		expect(session.handle).toBe('alice.example.com');
		expect(session.pdsUrl).toBe('https://pds.alice.example.com');
		expect(session.token).toBe(token);
	});

	it('accepts an aud carrying a fragment', async () => {
		vi.stubGlobal('fetch', stubFetch(makeDidDoc({ serviceEndpoint: 'https://pds.alice.example.com' })));
		const token = makeJwt({ sub: 'did:web:alice.example.com', aud: `${getServiceDid()}#atproto` });

		const session = await authenticate(requestWith(token));
		expect(session.pdsUrl).toBe('https://pds.alice.example.com');
	});

	it('resolves a did:plc token through the configured PLC directory', async () => {
		vi.stubEnv('ATP_PLC_DIRECTORY', 'https://plc.example.com');
		vi.stubGlobal(
			'fetch',
			stubFetch(
				makeDidDoc({
					serviceEndpoint: 'https://pds.alice.example.com',
					alsoKnownAs: ['at://alice.example.com'],
				}),
			),
		);
		const token = makeJwt({ sub: 'did:plc:abc123', aud: getServiceDid() });

		const session = await authenticate(requestWith(token));
		expect(session.did).toBe('did:plc:abc123');
		expect(session.handle).toBe('alice.example.com');
		expect(session.pdsUrl).toBe('https://pds.alice.example.com');
	});

	it('throws InvalidRequestError when the DID document has no atproto_pds service', async () => {
		vi.stubGlobal(
			'fetch',
			stubFetch({
				id: 'did:web:alice.example.com',
				alsoKnownAs: ['at://alice.example.com'],
				service: [{ id: '#other', type: 'SomeOtherService', serviceEndpoint: 'https://pds.alice.example.com' }],
			}),
		);
		const token = makeJwt({ sub: 'did:web:alice.example.com', aud: getServiceDid() });

		await expect(authenticate(requestWith(token))).rejects.toThrow(InvalidRequestError);
	});

	it('throws InvalidRequestError when the DID document fetch fails', async () => {
		vi.stubGlobal('fetch', (async () => new Response('nope', { status: 404 })) as typeof fetch);
		const token = makeJwt({ sub: 'did:web:alice.example.com', aud: getServiceDid() });

		await expect(authenticate(requestWith(token))).rejects.toThrow(InvalidRequestError);
	});
});

describe('authenticateOptional', () => {
	it('returns undefined when there is no token', async () => {
		await expect(authenticateOptional(requestWith(null))).resolves.toBeUndefined();
	});

	it('still throws on a malformed present token', async () => {
		await expect(authenticateOptional(requestWith('not-a-jwt'))).rejects.toThrow(AuthRequiredError);
	});

	it('returns a session for a valid token', async () => {
		vi.stubGlobal(
			'fetch',
			stubFetch(
				makeDidDoc({
					serviceEndpoint: 'https://pds.alice.example.com',
					alsoKnownAs: ['at://alice.example.com'],
				}),
			),
		);
		const token = makeJwt({ sub: 'did:web:alice.example.com', aud: getServiceDid() });

		const session = await authenticateOptional(requestWith(token));
		expect(session?.did).toBe('did:web:alice.example.com');
		expect(session?.handle).toBe('alice.example.com');
		expect(session?.pdsUrl).toBe('https://pds.alice.example.com');
		expect(session?.token).toBe(token);
	});
});
