#!/usr/bin/env tsx
// Create a disposable local account and write activity records so the Lua
// queries and feeds have something to read.
//
// This mints an account on the LOCAL PDS only (configured with the mock PLC and
// a `.test` handle domain), never on the public network. It is a development
// helper, not part of the deployed service.
//
//   PDS_URL=http://127.0.0.1:2583 MOCK_PLC_URL=http://127.0.0.1:2582 \
//   pnpm dev:seed -- --book=at://did:web:.../community.lexicon.media.book.edition/<rkey>
//
// Without --book it only creates the account and a shelf.

const PDS_URL = (process.env.PDS_URL ?? 'http://127.0.0.1:2583').replace(/\/$/, '');
const PLC_URL = (process.env.MOCK_PLC_URL ?? process.env.PLC_DIRECTORY_URL ?? 'http://127.0.0.1:2582').replace(/\/$/, '');
const HANDLE = process.env.DEV_ACCOUNT_HANDLE ?? 'reader.test';
const PASSWORD = process.env.DEV_ACCOUNT_PASSWORD ?? 'dev-account-password';
const EMAIL = process.env.DEV_ACCOUNT_EMAIL ?? 'reader@example.test';

function bookFromArgs(): string | undefined {
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith('--book=')) return arg.slice('--book='.length);
	}
	return undefined;
}

async function xrpc<T>(nsid: string, body: unknown, token?: string): Promise<T> {
	const res = await fetch(`${PDS_URL}/xrpc/${nsid}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${nsid}: ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

async function main(): Promise<void> {
	const book = bookFromArgs();
	let did: string;
	try {
		const account = await xrpc<{ did: string }>('com.atproto.server.createAccount', {
			handle: HANDLE,
			password: PASSWORD,
			email: EMAIL,
		});
		did = account.did;
		console.log(`[dev-seed] created ${did} @${HANDLE}`);
	} catch (err) {
		const session = await xrpc<{ did: string }>('com.atproto.server.createSession', {
			identifier: HANDLE,
			password: PASSWORD,
		});
		did = session.did;
		console.log(`[dev-seed] reusing ${did} @${HANDLE}`);
	}

	// Make the mock PLC answer this DID even if the PDS registration path was
	// incomplete; the doc is derived from the account's own DID when possible.
	const doc = await fetch(`${PDS_URL}/xrpc/com.atproto.identity.resolveDid?did=${encodeURIComponent(did)}`)
		.then((res) => (res.ok ? res.json() : null))
		.catch(() => null);
	await fetch(`${PLC_URL}/admin/dids`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ did, pds: PDS_URL, handle: HANDLE, doc }),
	});

	const session = await xrpc<{ accessJwt: string }>('com.atproto.server.createSession', {
		identifier: HANDLE,
		password: PASSWORD,
	});

	const now = new Date().toISOString();
	await xrpc(
		'com.atproto.repo.putRecord',
		{
			repo: did,
			collection: 'net.olamaelcu.livtet.biblio.shelf',
			rkey: 'reading',
			record: { name: 'Currently Reading', createdAt: now, updatedAt: now },
		},
		session.accessJwt,
	);
	console.log('[dev-seed] wrote shelf/reading');

	if (book) {
		const rkey = book.slice(book.lastIndexOf('/') + 1);
		await xrpc(
			'com.atproto.repo.putRecord',
			{
				repo: did,
				collection: 'net.olamaelcu.livtet.biblio.bookShelving',
				rkey,
				record: {
					shelf: `at://${did}/net.olamaelcu.livtet.biblio.shelf/reading`,
					book: { uri: book },
					metadata: { status: 'reading' },
					createdAt: now,
					updatedAt: now,
				},
			},
			session.accessJwt,
		);
		console.log(`[dev-seed] shelved ${book}`);
	}

	console.log(JSON.stringify({ did, handle: HANDLE, shelf: `at://${did}/net.olamaelcu.livtet.biblio.shelf/reading` }));
}

main().catch((err) => {
	console.error('[dev-seed] failed:', err);
	process.exit(1);
});
