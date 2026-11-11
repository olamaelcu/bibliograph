#!/usr/bin/env tsx
// Seed a local HappyView admin API key and confidential XRPC client so
// `hv:deploy` and the edge work without the dashboard OAuth dance.
//
// Local development only. It writes to the database named by
// HAPPYVIEW_DATABASE_URL, which must include `search_path=happyview,public`.
//
//   HAPPYVIEW_DATABASE_URL=... pnpm hv:dev-auth
//
// Prints the values to put in .env:
//   HAPPYVIEW_ADMIN_KEY=hv_dev_admin
//   HAPPYVIEW_CLIENT_KEY=bib_dev
//   HAPPYVIEW_CLIENT_SECRET=dev-client-secret

import { createHash } from 'node:crypto';
import { Pool } from 'pg';

const URL = process.env.DATABASE_URL ?? process.env.HAPPYVIEW_DATABASE_URL;
if (!URL) {
	console.error('[hv:dev-auth] DATABASE_URL (or HAPPYVIEW_DATABASE_URL) is required');
	process.exit(2);
}

const ADMIN_KEY = process.env.HAPPYVIEW_DEV_ADMIN_KEY ?? 'hv_dev_admin';
const CLIENT_KEY = process.env.HAPPYVIEW_DEV_CLIENT_KEY ?? 'bib_dev';
const CLIENT_SECRET = process.env.HAPPYVIEW_DEV_CLIENT_SECRET ?? 'dev-client-secret';
const USER_DID = 'did:web:local.test';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const now = new Date().toISOString();

const PERMISSIONS = [
	'scripts:read',
	'scripts:manage',
	'lexicons:create',
	'lexicons:read',
	'lexicons:delete',
	'lexicons:publish',
	'script-variables:create',
	'script-variables:read',
	'backfill:read',
	'backfill:create',
	'stats:read',
	'records:read',
];

async function main(): Promise<void> {
	const pool = new Pool({ connectionString: URL, max: 1 });
	try {
		await pool.query(`CREATE SCHEMA IF NOT EXISTS happyview`);
		const user = await pool.query<{ id: string }>(
			`INSERT INTO happyview.happyview_users (id, created_at, did, is_super)
			 VALUES ('u_dev', $1, $2, 1)
			 ON CONFLICT (did) DO UPDATE SET is_super = 1
			 RETURNING id`,
			[now, USER_DID],
		);
		const userId = user.rows[0]!.id;
		await pool.query(
			`INSERT INTO happyview.happyview_api_keys (id, user_id, name, key_hash, key_prefix, created_at, permissions)
			 VALUES ('k_dev', $1, 'local dev', $2, 'hv_dev', $3, $4)
			 ON CONFLICT (id) DO UPDATE SET user_id = $1, key_hash = $2, permissions = $4, revoked_at = NULL`,
			[userId, sha256(ADMIN_KEY), now, JSON.stringify(PERMISSIONS)],
		);
		await pool.query(
			`INSERT INTO happyview.happyview_api_clients
			 (id, client_key, name, client_id_url, client_uri, redirect_uris, scopes, created_by, created_at, updated_at, client_secret_hash, client_type)
			 VALUES ('c_dev', $1, 'Bibliograph edge', 'http://127.0.0.1:5176', 'http://127.0.0.1:5176', '[]', 'atproto', $2, $3, $3, $4, 'confidential')
			 ON CONFLICT (client_id_url) DO UPDATE SET client_key = $1, client_secret_hash = $4, is_active = 1`,
			[CLIENT_KEY, userId, now, sha256(CLIENT_SECRET)],
		);
	} finally {
		await pool.end();
	}
	console.log(`HAPPYVIEW_ADMIN_KEY=${ADMIN_KEY}`);
	console.log(`HAPPYVIEW_CLIENT_KEY=${CLIENT_KEY}`);
	console.log(`HAPPYVIEW_CLIENT_SECRET=${CLIENT_SECRET}`);
}

main().catch((err) => {
	console.error('[hv:dev-auth] failed:', err);
	process.exit(1);
});
