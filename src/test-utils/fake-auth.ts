function base64url(input: string): string {
	return Buffer.from(input, 'utf8').toString('base64url');
}

export function makeJwt(payload: Record<string, unknown>): string {
	const header = { alg: 'none', typ: 'JWT' };
	return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.fake`;
}

export function makeDidDoc(opts: {
	serviceEndpoint: string;
	alsoKnownAs?: string[];
}): Record<string, unknown> {
	return {
		'@context': 'https://www.w3.org/ns/did/v1',
		id: 'did:web:alice.example.com',
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

export function stubFetch(
	doc: Record<string, unknown> | (() => Promise<Record<string, unknown>>),
): typeof fetch {
	const getDoc = typeof doc === 'function' ? doc : async () => doc;
	return (async () => {
		const body = await getDoc();
		return new Response(JSON.stringify(body), { status: 200 });
	}) as typeof fetch;
}
