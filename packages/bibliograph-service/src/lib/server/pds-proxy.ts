// Forward `com.atproto.{repo,sync,identity,server.describeServer}` to a PDS.
//
// Our own repo lives on rsky-pds (`PDS_URL`). Other DIDs resolve to their own
// PDS through the DID document's `#atproto_pds` service. Identity resolution for
// foreign handles falls back to the public AppView, which implements
// `resolveHandle`; `resolveDid`/`resolveIdentity` are answered locally from the
// DID document so a generic PDS is not required to implement them.

import { PUBLISHER_HOSTNAME, PUBLISHER_DID, getDidDocument } from './did';
import { didDocumentResolver } from './did-document-resolver';
import { resolveActorDid, resolvePds } from './pds/resolve';

const PDS_URL = process.env.PDS_URL ?? 'http://127.0.0.1:2583';
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';

function isPublisher(value: string | null | undefined): boolean {
	if (!value) return false;
	return value === PUBLISHER_DID || value.toLowerCase() === PUBLISHER_HOSTNAME.toLowerCase();
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** Body/header pass-through with hop-by-hop headers stripped. */
function copyHeaders(from: Headers): Headers {
	const headers = new Headers();
	for (const [name, value] of from) {
		if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host'].includes(name)) continue;
		headers.set(name, value);
	}
	return headers;
}

async function forward(url: string, request: Request): Promise<Response> {
	const body =
		request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
	const headers = copyHeaders(request.headers);
	headers.delete('content-length');
	let upstream: Response;
	try {
		upstream = await fetch(url, {
			method: request.method,
			headers,
			body,
		});
	} catch {
		return json({ error: 'UpstreamUnavailable', message: 'The PDS did not answer' }, 502);
	}
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: copyHeaders(upstream.headers),
	});
}

async function identityLocally(nsid: string, params: URLSearchParams): Promise<Response | null> {
	if (nsid === 'com.atproto.identity.resolveHandle') {
		return null; // handled by the public AppView
	}
	const did = params.get('did') ?? params.get('identifier') ?? '';
	if (!did.startsWith('did:')) return null;
	try {
		const doc = await didDocumentResolver.resolve(did as `did:${string}:${string}`);
		return json({ didDoc: doc });
	} catch {
		return json({ error: 'DidNotFound', message: `Could not resolve ${did}` }, 400);
	}
}

export async function proxyToPds(request: Request, nsid: string): Promise<Response> {
	const url = new URL(request.url);
	const params = url.searchParams;

	if (nsid === 'com.atproto.server.describeServer') {
		return forward(`${PDS_URL}/xrpc/${nsid}${url.search}`, request);
	}

	if (nsid.startsWith('com.atproto.identity.')) {
		const identifier = params.get('identifier') ?? params.get('handle') ?? params.get('did');
		if (isPublisher(identifier)) {
			return forward(`${PDS_URL}/xrpc/${nsid}${url.search}`, request);
		}
		const local = await identityLocally(nsid, params);
		if (local) return local;
		return forward(`${PUBLIC_APPVIEW}/xrpc/${nsid}${url.search}`, request);
	}

	const actor = nsid.startsWith('com.atproto.sync.')
		? params.get('did')
		: (params.get('repo') ?? params.get('did'));
	if (isPublisher(actor)) {
		return forward(`${PDS_URL}/xrpc/${nsid}${url.search}`, request);
	}
	if (!actor) {
		return json({ error: 'InvalidRequest', message: 'repo or did is required' }, 400);
	}
	let did = actor;
	if (!did.startsWith('did:')) {
		const resolved = await resolveActorDid(actor);
		if (!resolved) return json({ error: 'RepoNotFound', message: `Could not resolve ${actor}` }, 400);
		did = resolved;
	}
	try {
		const pds = await resolvePds(did);
		return forward(`${pds.replace(/\/$/, '')}/xrpc/${nsid}${url.search}`, request);
	} catch {
		return json({ error: 'RepoNotFound', message: `No PDS found for ${did}` }, 400);
	}
}

export { getDidDocument };
