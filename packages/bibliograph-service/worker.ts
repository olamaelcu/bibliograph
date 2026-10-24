// Node entrypoint for the TAP consumer.
//
// Boot order matters. tsx plus the dependency graph take a couple of seconds to
// load, and a SIGTERM arriving in that window hits the default disposition,
// which terminates the process with exit 143 — systemd reports that as
// "Failed with result 'exit-code'", which is what a package upgrade looked like
// before this file was written. The handlers are therefore installed before the
// application is imported, and the import is dynamic.

let appReady = false;

function exitDuringBoot(signal: NodeJS.Signals): void {
  // Once the consumer is running it owns shutdown (it flushes the batch buffers
  // and closes the TAP websocket), so this handler steps aside.
  if (appReady) return;
  console.error(`[worker] ${signal} during startup; nothing buffered, exiting cleanly`);
  process.exit(0);
}

process.once('SIGTERM', () => exitDuringBoot('SIGTERM'));
process.once('SIGINT', () => exitDuringBoot('SIGINT'));

// Dynamic, not static, imports — and this is the one thing that cannot be
// changed back: a static import is evaluated before any statement in this file
// runs, so the handlers above would again be installed only after the whole
// dependency graph (tsx loader, pino, @atcute/tap, pg, graphile-worker) has
// loaded. The specifiers are fixed, but the *timing* of the import is the point.
const { runTapConsumer } = await import('./src/lib/server/tap-consumer');
const { createLogger } = await import('./src/lib/server/logger');

const log = createLogger('worker');
log.info('worker process started');

// runTapConsumer registers its own signal handlers synchronously before its
// first await, so the flag below is only set once they are in place.
const running = runTapConsumer(log);
appReady = true;

try {
  await running;
  // Only a signal-driven shutdown resolves; an unexpected end throws.
  log.info('worker stopped');
  process.exit(0);
} catch (err) {
  log.fatal({ err }, 'tap consumer crashed');
  process.exit(1);
}

// Marks the file as a module for TypeScript, which is what permits the
// top-level await above. Node already treats it as ESM (`"type": "module"`).
export {};
