// Node entrypoint.
//
// Replaces `node build/index.js` because adapter-node's generated entrypoint
// builds its own http.Server internally and offers no `upgrade` hook. Using the
// emitted `build/handler.js` instead gives us the same SvelteKit handling for
// HTTP plus the ability to serve the labeler's WebSocket on the same origin —
// which matters, because a labeler's `#atproto_labeler` service endpoint is an
// origin with no path, so the stream has to live on this host.
//
// Run with `tsx server.ts` (tsx is a runtime dependency, and the container
// already uses it for the migrator).

import http from 'node:http';
import process from 'node:process';
import { attachLabelStream } from './src/lib/server/labeler/stream';

// Register before the build/handler.js import below. That import takes a
// moment, and a signal arriving before the server is listening would otherwise
// terminate the process with the default disposition (exit 143) rather than
// exiting cleanly.
let listening = false;
function exitDuringBoot(signal: string): void {
  if (listening) return;
  console.error(`[server] ${signal} during startup; exiting cleanly`);
  process.exit(0);
}
process.once('SIGTERM', () => exitDuringBoot('SIGTERM'));
process.once('SIGINT', () => exitDuringBoot('SIGINT'));

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

// Static import cannot be used here: `build/handler.js` is produced by `vite
// build` and does not exist on a clean checkout, so a static import would make
// `tsc`/`pnpm check` fail before the first build.
const handlerModulePath = './build/handler.js';
const { handler } = (await import(handlerModulePath)) as { handler: http.RequestListener };

const server = http.createServer(handler);
attachLabelStream(server);

server.listen(port, host, () => {
  listening = true;
  console.log(`Listening on ${host}:${port} (label stream on /xrpc/com.atproto.label.subscribeLabels)`);
});

function shutdown(reason: string): void {
  server.close(() => process.exit(0));
  // Do not let an idle keep-alive or an open label stream block shutdown.
  server.closeAllConnections();
  console.log(`Shutting down (${reason})`);
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
