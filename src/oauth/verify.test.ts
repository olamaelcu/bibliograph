import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyRequest } from './verify.js';
import { currentNonce } from './nonce.js';
import { createOauthTestKit } from '../test-utils/fake-auth.js';
import { SERVICE_DID } from '../test-utils/db.js';

beforeAll(() => {
	process.env.ATP_SERVICE_DID = SERVICE_DID;
});
afterAll(() => {
	delete process.env.ATP_SERVICE_DID;
});

const DID = 'did:web:alice.example.com';
const METHOD = 'GET';
// `htu` per RFC 9449 excludes the query string; the request itself carries one
// to exercise that the server-side normalization strips it the same way.
const HTU = 'https://books.example.com/xrpc/net.olamaelcu.livtet.biblio.getActor';
const REQUEST_URL = `${HTU}?actor=${encodeURIComponent(DID)}`;

function req(headers: Record<string, string>): Request {
	return new Request(REQUEST_URL, { method: METHOD, headers });
}

describe('verifyRequest', () => {
	it('accepts a valid DPoP-bound access token (URL issuer)', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		const { authorization, dpop } = await session.headers({ method: METHOD, url: HTU });
		const result = await verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch });
		expect(result.did).toBe(DID);
		expect(result.scope).toBe('atproto');
	});

	it('resolves a did:web issuer via its #atproto_pds service endpoint', async () => {
		const kit = await createOauthTestKit();
		const issuerDid = 'did:web:pds-issuer.example.com';
		kit.serveDidWebDocument(issuerDid);
		const session = await kit.mintSession({ did: DID, iss: issuerDid });
		const { authorization, dpop } = await session.headers({ method: METHOD, url: HTU });
		const result = await verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch });
		expect(result.did).toBe(DID);
	});

	it('rejects a tampered access-token signature', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		const { dpop } = await session.headers({ method: METHOD, url: HTU });
		const tampered = session.accessToken.slice(0, -1) + (session.accessToken.endsWith('A') ? 'B' : 'A');
		await expect(
			verifyRequest(req({ authorization: `DPoP ${tampered}`, dpop }), { fetchFn: kit.fetch }),
		).rejects.toThrow();
	});

	it('rejects a token minted for a different audience', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID, aud: 'did:web:someone-else.example.com' });
		const { authorization, dpop } = await session.headers({ method: METHOD, url: HTU });
		await expect(verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch })).rejects.toThrow();
	});

	it('rejects a token missing the atproto scope', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID, scope: 'transition:generic' });
		const { authorization, dpop } = await session.headers({ method: METHOD, url: HTU });
		await expect(verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch })).rejects.toThrow();
	});

	it('rejects an expired access token', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID, expSeconds: -10 });
		const { authorization, dpop } = await session.headers({ method: METHOD, url: HTU });
		await expect(verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch })).rejects.toThrow();
	});

	it('rejects a DPoP proof key that does not match the token cnf.jkt', async () => {
		const kit = await createOauthTestKit();
		const sessionA = await kit.mintSession({ did: DID });
		const sessionB = await kit.mintSession({ did: DID });
		const dpop = await sessionB.sign({ method: METHOD, url: HTU });
		await expect(
			verifyRequest(req({ authorization: `DPoP ${sessionA.accessToken}`, dpop }), { fetchFn: kit.fetch }),
		).rejects.toThrow();
	});

	it('rejects a DPoP htm mismatch', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		const { authorization, dpop } = await session.headers({ method: 'POST', url: HTU });
		await expect(verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch })).rejects.toThrow();
	});

	it('rejects a DPoP htu mismatch', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		const { authorization, dpop } = await session.headers({ method: METHOD, url: `${HTU}-wrong` });
		await expect(verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch })).rejects.toThrow();
	});

	it('rejects a DPoP ath mismatch', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		const dpop = await session.sign({ method: METHOD, url: HTU, athOverride: 'not-the-real-hash' });
		await expect(
			verifyRequest(req({ authorization: `DPoP ${session.accessToken}`, dpop }), { fetchFn: kit.fetch }),
		).rejects.toThrow();
	});

	it('rejects a DPoP proof missing jti', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		const dpop = await session.sign({ method: METHOD, url: HTU, omitJti: true });
		await expect(
			verifyRequest(req({ authorization: `DPoP ${session.accessToken}`, dpop }), { fetchFn: kit.fetch }),
		).rejects.toThrow();
	});

	it('accepts a DPoP proof carrying the current nonce (bootstrap)', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		const { authorization, dpop } = await session.headers({ method: METHOD, url: HTU, nonce: currentNonce() });
		const result = await verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch });
		expect(result.did).toBe(DID);
	});

	it('rejects a DPoP proof carrying a stale/incorrect nonce', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		const { authorization, dpop } = await session.headers({ method: METHOD, url: HTU, nonce: 'not-a-real-nonce' });
		await expect(verifyRequest(req({ authorization, dpop }), { fetchFn: kit.fetch })).rejects.toThrow();
	});

	it('rejects a request with no Authorization header', async () => {
		const kit = await createOauthTestKit();
		await expect(verifyRequest(req({}), { fetchFn: kit.fetch })).rejects.toThrow();
	});

	it('rejects a request with no DPoP header', async () => {
		const kit = await createOauthTestKit();
		const session = await kit.mintSession({ did: DID });
		await expect(
			verifyRequest(req({ authorization: `DPoP ${session.accessToken}` }), { fetchFn: kit.fetch }),
		).rejects.toThrow();
	});
});
