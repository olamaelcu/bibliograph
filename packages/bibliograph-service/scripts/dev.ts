#!/usr/bin/env tsx
// `mise run dev`: migrate, start HappyView, seed local credentials, deploy the
// lexicons/scripts, then run the worker and the Vite dev server.
//
// HappyView must be healthy before `hv:deploy`: its admin API is the thing the
// deploy talks to. Ports are overridable (HAPPYVIEW_PORT, WEB_PORT) so this can
// run beside another project's dev servers.

import { spawn, type ChildProcess } from 'node:child_process';

const HAPPYVIEW_PORT = process.env.HAPPYVIEW_PORT ?? '3000';
const WEB_PORT = process.env.WEB_PORT ?? '5176';
const HAPPYVIEW_URL = `http://127.0.0.1:${HAPPYVIEW_PORT}`;
const ADMIN_KEY = process.env.HAPPYVIEW_ADMIN_KEY ?? 'hv_dev_admin';
const CLIENT_KEY = process.env.HAPPYVIEW_CLIENT_KEY ?? 'bib_dev';
const CLIENT_SECRET = process.env.HAPPYVIEW_CLIENT_SECRET ?? 'dev-client-secret';

const children: ChildProcess[] = [];

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const child = spawn(command, args, { stdio: 'inherit', env });
	child.on('error', reject);
	child.on('exit', (code) =>
		code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
	);
	return promise;
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
	const child = spawn(command, args, { stdio: 'inherit', env });
	children.push(child);
	return child;
}

async function waitForHappyView(): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${HAPPYVIEW_URL}/health`);
			if (res.ok) return;
		} catch {
			// Not listening yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`HappyView did not become healthy at ${HAPPYVIEW_URL}`);
}

function shutdown(): void {
	for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main(): Promise<void> {
	console.log('[dev] migrate');
	await run('pnpm', ['--filter', 'bibliograph-service', 'db:migrate']);
	console.log('[dev] extract HappyView');
	await run('pnpm', ['--filter', 'bibliograph-service', 'hv:extract']);

	console.log(`[dev] start HappyView on ${HAPPYVIEW_PORT}`);
	const hv = start('pnpm', ['--filter', 'bibliograph-service', 'hv:dev'], {
		...process.env,
		HAPPYVIEW_PORT,
		HAPPYVIEW_PUBLIC_URL: `http://127.0.0.1:${HAPPYVIEW_PORT}`,
	});
	void hv;

	console.log('[dev] wait for HappyView health');
	await waitForHappyView();
	console.log('[dev] HappyView healthy');
	console.log('[dev] seed local HappyView credentials');
	await run('pnpm', ['--filter', 'bibliograph-service', 'hv:dev-auth']);
	console.log('[dev] deploy lexicons/scripts');
	await run('pnpm', ['--filter', 'bibliograph-service', 'hv:deploy'], {
		...process.env,
		HAPPYVIEW_URL,
		HAPPYVIEW_ADMIN_KEY: ADMIN_KEY,
		HAPPYVIEW_CLIENT_KEY: CLIENT_KEY,
		HAPPYVIEW_CLIENT_SECRET: CLIENT_SECRET,
	});

	const common = {
		...process.env,
		HAPPYVIEW_URL,
		HAPPYVIEW_CLIENT_KEY: CLIENT_KEY,
		HAPPYVIEW_CLIENT_SECRET: CLIENT_SECRET,
		HAPPYVIEW_ADMIN_KEY: ADMIN_KEY,
	};
	console.log('[dev] start worker and web');
	start('pnpm', ['--filter', 'bibliograph-service', 'worker'], common);
	start('pnpm', ['--filter', 'bibliograph-service', 'dev', '--host', '--port', WEB_PORT], common);
}

main().catch((err) => {
	console.error('[dev] failed:', err);
	shutdown();
	process.exit(1);
});
