#!/usr/bin/env tsx
// Authorize an ATProto account for the HappyView dashboard.
//
//   pnpm hv:authorize --did=did:plc:...
//   pnpm hv:authorize --handle=alice.bsky.social
//
// The dashboard only admits DIDs that already have a `happyview_users` row
// (except on a completely empty instance, where the first login bootstraps).
// This makes the account a superuser so it can also manage the instance.
// Local development only: it writes to HAPPYVIEW_DATABASE_URL / DATABASE_URL.

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const URL = process.env.DATABASE_URL ?? process.env.HAPPYVIEW_DATABASE_URL;
if (!URL) {
	console.error('[hv:authorize] DATABASE_URL (or HAPPYVIEW_DATABASE_URL) is required');
	process.exit(2);
}

function argument(name: string): string | undefined {
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
	}
	return undefined;
}

async function resolveHandle(handle: string): Promise<string> {
	const res = await fetch(
		`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
	);
	if (!res.ok) throw new Error(`could not resolve ${handle}: ${res.status} ${await res.text()}`);
	const body = (await res.json()) as { did?: string };
	if (!body.did) throw new Error(`no DID for ${handle}`);
	return body.did;
}

async function main(): Promise<void> {
	const handle = argument('handle');
	const explicitDid = argument('did');
	if (!handle && !explicitDid) {
		throw new Error('usage: pnpm hv:authorize --did=did:plc:... | --handle=name.example');
	}
	const did = explicitDid ?? (await resolveHandle(handle!));
	if (!did.startsWith('did:')) throw new Error(`not a DID: ${did}`);

	const pool = new Pool({ connectionString: URL, max: 1 });
	try {
		const now = new Date().toISOString();
		const existing = await pool.query<{ id: string }>(
			`SELECT id FROM happyview.happyview_users WHERE did = $1`,
			[did],
		);
		if (existing.rows[0]) {
			await pool.query(
				`UPDATE happyview.happyview_users SET is_super = 1 WHERE id = $1`,
				[existing.rows[0].id],
			);
		} else {
			await pool.query(
				`INSERT INTO happyview.happyview_users (id, did, is_super, created_at)
				 VALUES ($1, $2, 1, $3)`,
				[randomUUID(), did, now],
			);
		}
	} finally {
		await pool.end();
	}
	console.log(`[hv:authorize] ${did} can sign in to the dashboard (superuser)`);
}

main().catch((err) => {
	console.error('[hv:authorize] failed:', err);
	process.exit(1);
});
