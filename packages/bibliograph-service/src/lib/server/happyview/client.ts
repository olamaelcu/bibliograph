// Internal HappyView client. HappyView is never the public XRPC origin: the
// edge reaches it at `/<BASE_PATH>/xrpc/<nsid>` on loopback.

const BASE = `${process.env.HAPPYVIEW_URL ?? 'http://127.0.0.1:3000'}/~/hv`;

export function hvUrl(path: string): string {
	return `${BASE}${path}`;
}

export function hvHeaders(extra: Record<string, string> = {}): Record<string, string> {
	const headers: Record<string, string> = { ...extra };
	const key = process.env.HAPPYVIEW_CLIENT_KEY;
	const secret = process.env.HAPPYVIEW_CLIENT_SECRET;
	if (key) headers['x-client-key'] = key;
	if (secret) headers['x-client-secret'] = secret;
	return headers;
}

/** The `__bib_http` wrapper a query script uses to signal a non-200 answer. */
export interface BibHttpError {
	status: number;
	body: unknown;
}

export function bibHttpError(value: unknown): BibHttpError | null {
	if (!value || typeof value !== 'object' || !('__bib_http' in value)) return null;
	const envelope = value.__bib_http;
	if (!envelope || typeof envelope !== 'object' || !('status' in envelope)) return null;
	const status = envelope.status;
	if (typeof status !== 'number' || !('body' in envelope)) return null;
	return { status, body: envelope.body };
}

export async function hvQuery(nsid: string, params: URLSearchParams): Promise<Response> {
	const search = params.toString();
	let res: Response;
	try {
		res = await fetch(hvUrl(`/xrpc/${nsid}${search ? `?${search}` : ''}`), {
			headers: hvHeaders({ accept: 'application/json' }),
		});
	} catch {
		return Response.json({ error: 'UpstreamUnavailable', message: 'HappyView did not answer' }, { status: 502 });
	}
	const body: unknown = await res.json().catch(() => null);
	const failure = bibHttpError(body);
	if (failure) return Response.json(failure.body, { status: failure.status });
	return new Response(JSON.stringify(body), {
		status: res.status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

/** Forward an arbitrary XRPC request to HappyView, preserving method and body. */
export async function hvRequest(request: Request, nsid: string): Promise<Response> {
	const url = new URL(request.url);
	const body =
		request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
	let res: Response;
	try {
		res = await fetch(hvUrl(`/xrpc/${nsid}${url.search}`), {
			method: request.method,
		headers: hvHeaders({
			accept: request.headers.get('accept') ?? 'application/json',
			'content-type': request.headers.get('content-type') ?? 'application/json',
			...(request.headers.get('authorization')
				? { authorization: request.headers.get('authorization')! }
				: {}),
		}),
			body,
		});
	} catch {
		return Response.json({ error: 'UpstreamUnavailable', message: 'HappyView did not answer' }, { status: 502 });
	}
	const text = await res.text();
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		return new Response(text, {
			status: res.status,
			headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
		});
	}
	const failure = bibHttpError(parsed);
	if (failure) return Response.json(failure.body, { status: failure.status });
	return Response.json(parsed, { status: res.status });
}

export async function hvAdmin(path: string, init: RequestInit = {}): Promise<Response> {
	const key = process.env.HAPPYVIEW_ADMIN_KEY;
	if (!key) throw new Error('HAPPYVIEW_ADMIN_KEY is required for the HappyView admin API');
	return fetch(hvUrl(path), {
		...init,
		headers: {
			authorization: `Bearer ${key}`,
			'content-type': 'application/json',
			...(init.headers ?? {}),
		},
	});
}
