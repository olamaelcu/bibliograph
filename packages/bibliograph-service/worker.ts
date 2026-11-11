// Node entrypoint for catalog jobs and the PDS outbox publisher.
//
// Boot order matters: tsx plus the dependency graph take a couple of seconds to
// load, and a SIGTERM arriving in that window hits the default disposition. The
// handlers are therefore installed before the application is imported.

let appReady = false;

function exitDuringBoot(signal: NodeJS.Signals): void {
	if (appReady) return;
	console.error(`[worker] ${signal} during startup; nothing buffered, exiting cleanly`);
	process.exit(0);
}

process.once('SIGTERM', () => exitDuringBoot('SIGTERM'));
process.once('SIGINT', () => exitDuringBoot('SIGINT'));

const { runJobTasks } = await import('./src/lib/server/jobs/run-tasks');
const { enqueuePdsPublish } = await import('./src/lib/server/jobs/enqueue');
const { createLogger } = await import('./src/lib/server/logger');

const log = createLogger('worker');
log.info('worker process started');

appReady = true;

// Drain the outbox once at boot, then every minute. `jobKey` keeps a relaunch
// from stacking duplicates while one is still pending.
const outboxTimer = setInterval(() => {
	void enqueuePdsPublish().catch((err) => log.warn({ err }, 'could not enqueue pds-publish'));
}, 60_000);
void enqueuePdsPublish().catch((err) => log.warn({ err }, 'could not enqueue pds-publish at boot'));

try {
	await runJobTasks(log);
	log.info('worker stopped');
	clearInterval(outboxTimer);
	process.exit(0);
} catch (err) {
	log.fatal({ err }, 'worker crashed');
	clearInterval(outboxTimer);
	process.exit(1);
}

export {};
