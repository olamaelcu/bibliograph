#!/usr/bin/env tsx
// Publish every lexicon under `lexicons/` to the publisher PDS as
// `com.atproto.lexicon.schema` records (rkey = NSID).
//
// This replaces the CAR lex-repo build. `com.atproto.lexicon.resolveLexicon` is
// served at the edge from the local map, and the PDS copy is what other hosts
// resolve.
//
//   pnpm --filter bibliograph-service pds:publish-lexicons

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const PDS_URL = process.env.PDS_URL ?? 'http://127.0.0.1:2583';
const PASSWORD = process.env.PDS_ACCOUNT_PASSWORD;
const IDENTIFIER = process.env.PDS_ACCOUNT_DID ?? process.env.LEX_PUBLISHER_DID;
const LEXICONS_DIR = new URL('../lexicons/', import.meta.url).pathname;

if (!PASSWORD || !IDENTIFIER) {
	console.error('[pds:publish-lexicons] PDS_ACCOUNT_PASSWORD and PDS_ACCOUNT_DID are required');
	process.exit(2);
}

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(path)));
		else if (entry.name.endsWith('.json') && !path.includes('/codegen/')) files.push(path);
	}
	return files;
}

async function main(): Promise<void> {
	const sessionRes = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD }),
	});
	if (!sessionRes.ok) throw new Error(`createSession failed: ${sessionRes.status} ${await sessionRes.text()}`);
	const session = (await sessionRes.json()) as { accessJwt: string };

	const files = await walk(LEXICONS_DIR);
	let published = 0;
	for (const file of files) {
		const schema = JSON.parse(await readFile(file, 'utf8')) as { id?: string };
		const nsid = schema.id;
		if (!nsid) {
			console.warn(`[pds:publish-lexicons] skipping ${file}: no id`);
			continue;
		}
		const res = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.putRecord`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${session.accessJwt}`,
			},
			body: JSON.stringify({
				repo: IDENTIFIER,
				collection: 'com.atproto.lexicon.schema',
				rkey: nsid,
				validate: false,
				record: schema,
			}),
		});
		if (!res.ok) {
			throw new Error(`putRecord ${nsid} failed: ${res.status} ${await res.text()}`);
		}
		published += 1;
	}
	console.log(`[pds:publish-lexicons] published ${published} lexicons to ${PDS_URL}`);
}

main().catch((err) => {
	console.error('[pds:publish-lexicons] failed:', err);
	process.exit(1);
});
