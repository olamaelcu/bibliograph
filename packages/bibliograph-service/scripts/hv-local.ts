#!/usr/bin/env tsx
// Extract the published HappyView image into `.cache/happyview`, then run the
// same binary against the local database. This is the local-development path;
// production installs the Debian package.
//
//   tsx scripts/hv-local.ts extract
//   tsx scripts/hv-local.ts run
//
// `extract` needs Docker; `run` does not.

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(ROOT, '.cache/happyview');
const IMAGE = process.env.HAPPYVIEW_IMAGE ?? 'ghcr.io/gamesgamesgamesgamesgames/happyview:2.17.4';

function run(command: string, args: string[], cwd = ROOT): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const child = spawn(command, args, { cwd, stdio: 'inherit' });
	child.on('error', reject);
	child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
	return promise;
}

async function replaceSentinel(dir: string): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await replaceSentinel(path);
			continue;
		}
		if (!/\.(?:html|js|css|json|txt|svg|map)$/i.test(entry.name)) continue;
		const before = await readFile(path, 'utf8');
		if (!before.includes('__HAPPYVIEW_BP__')) continue;
		// The image's entrypoint replaces `/__HAPPYVIEW_BP__` (with the leading
		// slash); replacing only the token would leave `//~/hv`.
		await writeFile(path, before.replaceAll('/__HAPPYVIEW_BP__', '/~/hv'));
	}
}

async function extract(): Promise<void> {
	await rm(CACHE, { recursive: true, force: true });
	await mkdir(CACHE, { recursive: true });
	await run('docker', ['pull', IMAGE]);
	const created = Promise.withResolvers<string>();
	{
		const child = spawn('docker', ['create', IMAGE]);
		let out = '';
		child.stdout.on('data', (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.on('error', created.reject);
		child.on('exit', (code) =>
			code === 0 ? created.resolve(out.trim()) : created.reject(new Error(`docker create exited ${code}`)),
		);
	}
	const container = await created.promise;
	try {
		await run('docker', ['cp', `${container}:/usr/local/bin/happyview`, join(CACHE, 'happyview')]);
		await cpFromContainer(container, '/srv/static', join(CACHE, 'static'));
		await cpFromContainer(container, '/app/migrations', join(CACHE, 'migrations'));
	} finally {
		await run('docker', ['rm', '-f', container]);
	}
	await replaceSentinel(join(CACHE, 'static'));
	console.log(`[hv-local] extracted ${IMAGE} into ${CACHE}`);
}

async function cpFromContainer(container: string, from: string, to: string): Promise<void> {
	const temp = `${to}.tmp`;
	await rm(temp, { recursive: true, force: true });
	await run('docker', ['cp', `${container}:${from}`, temp]);
	await rm(to, { recursive: true, force: true });
	await rename(temp, to);
}

async function serve(): Promise<void> {
	const databaseUrl = process.env.HAPPYVIEW_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error('HAPPYVIEW_DATABASE_URL (or DATABASE_URL) is required');
	// HappyView's migrations are unqualified. Its own login role has
	// `search_path=happyview,public`, so they land in `happyview` instead of
	// colliding with the labeler's `labels` table. Provision both here with the
	// app's admin connection; HappyView itself never sees it.
	const adminUrl = process.env.DATABASE_URL;
	if (!adminUrl) throw new Error('DATABASE_URL is required to provision the happyview schema/role');
	const admin = new Pool({ connectionString: adminUrl, max: 1 });
	try {
		await admin.query(`
			CREATE SCHEMA IF NOT EXISTS happyview;
			DO $$ BEGIN
				IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happyview_app') THEN
					CREATE ROLE happyview_app LOGIN PASSWORD 'happyview';
				END IF;
			END $$;
			ALTER ROLE happyview_app SET search_path = happyview, public;
			GRANT USAGE, CREATE ON SCHEMA happyview TO happyview_app;
			GRANT USAGE ON SCHEMA public TO happyview_app;
			GRANT SELECT ON ALL TABLES IN SCHEMA public TO happyview_app;
			GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA happyview TO happyview_app;
			GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA happyview TO happyview_app;
		`);
	} finally {
		await admin.end();
	}
	const binary = join(CACHE, 'happyview');
	const child = spawn(binary, [], {
		cwd: CACHE,
		stdio: 'inherit',
		env: {
			...process.env,
			// HappyView's own tables live in the `happyview` schema; `appview_book`
			// is read from public by the Lua queries.
			DATABASE_URL: databaseUrl,
			STATIC_DIR: join(CACHE, 'static'),
			BASE_PATH: '/~/hv',
			PUBLIC_URL: process.env.HAPPYVIEW_PUBLIC_URL ?? 'http://127.0.0.1:3000',
			HOST: process.env.HAPPYVIEW_HOST ?? '127.0.0.1',
			PORT: process.env.HAPPYVIEW_PORT ?? '3000',
			SESSION_SECRET:
				process.env.SESSION_SECRET ?? 'local-dev-session-secret-0123456789-0123456789-0123456789',
			PLC_URL: 'https://plc.directory',
			ALLOW_PRIVATE_DESTINATIONS: 'true',
		},
	});
	child.on('exit', (code) => process.exit(code ?? 0));
}

const command = process.argv[2] ?? 'run';
try {
	if (command === 'extract') await extract();
	else if (command === 'run') await serve();
	else throw new Error(`unknown command: ${command} (use extract or run)`);
} catch (err) {
	console.error('[hv-local] failed:', err);
	process.exit(1);
}
