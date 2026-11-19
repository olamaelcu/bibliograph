import pg from 'pg';
import { parseCronItems, run } from 'graphile-worker';
import { createProviders } from './lib/providers/index.js';
import { createTasks } from './lib/tasks.js';
import { createOutboxPublisher } from './lib/publish.js';
import { resolvePublisherAuthority, resolvePublisherConfig } from './lib/pds.js';
import { clearStaleGraphileLocks, ensureSupportSchema } from './lib/setup.js';
import { createCoverMetrics } from './lib/cover-metrics.js';
import { startMetricsServer } from './lib/metrics.js';
import { startAdminServer } from './lib/admin.js';
import { parseDailyLimit } from './lib/providers/usage.js';
import { prepareEntityRecords } from './lib/prepare-entities.js';
import { createIngest } from './lib/ingest.js';
import { createGutenberg } from './lib/providers/gutenberg.js';
import { seedCatalogFromProvider } from './lib/seed.js';
import { createBookhiveMetrics, importBookhiveCatalog } from './lib/bookhive.js';
import { coversBaseUrlFromEnv } from './lib/cover-cache.js';
import { DEFAULT_LABELER_PORT, loadLabelerKeypair, startLabeler } from './lib/labeler.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('worker: DATABASE_URL is required');
  process.exit(1);
}

const publisherHost = process.env.ATP_SERVICE_HOST || 'biblio.livtet.olamaelcu.net';
// Where the cached covers are stored and advertised. Both units run on one host
// as one user, so the edge reads the same directory the worker writes.
// The directory comes from configuration, never from a baked-in path: the unit's
// conffile names it (`/var/cache/bibliograph-covers` in production, the unit's
// CacheDirectory), and mise's [env] names the repo-local one in development.
// Unset disables the cover cache instead of guessing a path.
const coversCacheDir = (process.env.COVERS_CACHE_DIR ?? '').trim();
const coversBaseUrl = coversBaseUrlFromEnv(process.env, publisherHost);
// One counter instance: the cover jobs increment it, the scrape reports it.
const coverMetrics = createCoverMetrics();
// Same for the Bookhive walk: the `catalog.bookhive` task increments it and the
// scrape reports it; the durable total is the gauge read from
// `edition_identifiers`.
const bookhiveMetrics = createBookhiveMetrics();
if (coversCacheDir === '') {
  console.error(
    'worker: cover caching is DISABLED — COVERS_CACHE_DIR is not set. ' +
      'catalog.covers becomes a no-op, so no cover bytes are downloaded or served; ' +
      'set it (e.g. /var/cache/bibliograph-covers) and restart.'
  );
}
// The repo authority is independent of publisher credentials: hydration mints
// the same URIs even while pds-publish is disabled.
const publisherDid = resolvePublisherAuthority() || `did:web:${publisherHost}`;
/**
 * Worker sizing.
 *
 * Five jobs shared by every queue was the ceiling: four long `catalog.genres`
 * jobs (each 1–3 minutes against the providers) left one worker for everything
 * else, and a newly queued job — a hydration, an ISBN backfill — waited behind
 * a thousand due jobs. Both pools are sized with the concurrency because each
 * worker needs a connection to fetch and one to do its SQL.
 *
 * `max_connections` is 100 on the deployment host, and the rest of the budget
 * is the edge's three pools (25), HappyView's role limit (40) and a few
 * maintenance sessions. 12 concurrency + 10 app + 12 graphile = 22 worker
 * connections keeps the worst case around 90, so the work can grow without
 * every other service queueing for a connection.
 */
function positiveInteger(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const concurrency = positiveInteger(process.env.GRAPHILE_WORKER_CONCURRENCY, 12);
const workerPoolMax = positiveInteger(process.env.WORKER_POOL_MAX, 10);
const graphilePoolMax = positiveInteger(process.env.GRAPHILE_POOL_MAX, 12);

const pool = new pg.Pool({ connectionString: databaseUrl, max: workerPoolMax });
await ensureSupportSchema(pool);

// A stop that outlives graphile's abort window (or a kill) leaves job and queue
// locks held for four hours, and a locked queue stops that task entirely. The
// packaged unit runs exactly one worker against the database, so any lock seen
// at boot is stale by definition; WORKER_CLEAR_STALE_LOCKS=1 (set by that
// unit) clears them here instead of asking an operator to run SQL after a
// restart. Never enable it where a second worker shares the database.
if ((process.env.WORKER_CLEAR_STALE_LOCKS ?? '').trim() === '1') {
  const cleared = await clearStaleGraphileLocks(pool);
  if (cleared.jobs > 0 || cleared.queues > 0) {
    console.log(
      `worker: cleared stale graphile locks (jobs=${cleared.jobs}, queues=${cleared.queues})`
    );
  }
}

// Operator entry point for the one-off entity rollout:
//
//   node index.js --prepare-entities            # mint + queue records/editions
//   node index.js --prepare-entities --phase=editions  # republish pass
//
// It only writes catalog/outbox rows; `pds-publish` (the worker task) is what
// actually publishes them. Running it twice is safe: the mint phase finds no
// NULL at_uri rows the second time.
if (process.argv.includes('--prepare-entities')) {
  const phaseArg = process.argv.find((arg) => arg.startsWith('--phase='));
  const phase = phaseArg ? phaseArg.slice('--phase='.length) : 'mint';
  try {
    const summary = await prepareEntityRecords(pool, { authority: publisherDid, phase });
    console.log(`worker: entities.prepare[${phase}] ${JSON.stringify(summary)}`);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

// Operator entry point for filling an empty catalogue from Project Gutenberg:
//
//   node index.js --seed-gutenberg=10    # the ten most-downloaded ebooks
//
// Editions take the same path hydration uses; the catalog trigger queues each
// record and `pds-publish` publishes it. Re-running is safe: identity is the
// ebook's own identifier, so an existing edition is updated, never duplicated.
if (process.argv.some((arg) => arg.startsWith('--seed-gutenberg'))) {
  const countArg = process.argv.find((arg) => arg.startsWith('--seed-gutenberg='));
  const count = countArg ? countArg.slice('--seed-gutenberg='.length) : '10';
  let exitCode = 0;
  try {
    const summary = await seedCatalogFromProvider({
      provider: createGutenberg({ baseUrl: process.env.GUTENBERG_BASE_URL || undefined }),
      ingest: createIngest({ pool, publisherDid, publisherHost }),
      count: Number(count)
    });
    console.log(
      `worker: catalog.seed[gutenberg] created=${summary.created} updated=${summary.updated} ` +
        `skipped=${summary.skipped} failed=${summary.failed}`
    );
  } catch (error) {
    console.error(`worker: catalog.seed[gutenberg] failed — ${error.message}`);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

// Operator entry point for the Bookhive join:
//
//   node index.js --import-bookhive=100   # walk 100 catalog pages
//
// Every Bookhive reader record names a book by hive id and nothing else, so the
// catalog books have to exist as editions before those records can be read. The
// walk is idempotent (a book whose identifier set is already present is
// skipped), so a partial run resumes by starting from the first page again.
if (process.argv.some((arg) => arg.startsWith('--import-bookhive'))) {
  const pagesArg = process.argv.find((arg) => arg.startsWith('--import-bookhive='));
  const pages = pagesArg ? pagesArg.slice('--import-bookhive='.length) : '100';
  let exitCode = 0;
  try {
    const summary = await importBookhiveCatalog({
      pool,
      ingest: createIngest({ pool, publisherDid, publisherHost }),
      pages: Number(pages)
    });
    console.log(`worker: catalog.bookhive ${JSON.stringify(summary)}`);
  } catch (error) {
    console.error(`worker: catalog.bookhive failed — ${error.message}`);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

const isbndbDailyLimit = parseDailyLimit(process.env.ISBNDB_DAILY_LIMIT);
const providers = createProviders({ pool, isbndbDailyLimit });

// The labeler signs the `known-author` labels a librarian's approval queues. Its
// identity is the did:web this host already serves — the key is published as
// `#atproto_label` in that document — so no PDS account is involved. Without a
// key file the whole feature is off: the endpoint does not start and the queue
// keeps its rows, exactly like an unconfigured `pds-publish`.
const labelerKeyFile = (process.env.LABELER_KEY_FILE ?? '').trim();
const labelerDid =
  (process.env.LABELER_DID ?? '').trim() || `did:web:${publisherHost}`;
const labelerPort = positiveInteger(process.env.LABELER_PORT, DEFAULT_LABELER_PORT);
let labelerKeypair;
if (labelerKeyFile !== '') {
  try {
    labelerKeypair = await loadLabelerKeypair(labelerKeyFile);
  } catch (error) {
    console.error(
      `worker: labeler DISABLED — cannot read LABELER_KEY_FILE=${labelerKeyFile}: ${error.message}`
    );
  }
} else {
  console.error(
    'worker: labeler DISABLED — LABELER_KEY_FILE is not set, so queued labels are ' +
      'never signed. Generate a key with scripts/gen-labeler-key.mjs and restart.'
  );
}

// The admin API is how an operator searches providers and ingests a result.
// It is loopback-only by default and absent when ADMIN_TOKEN is unset; a bind
// failure must not stop catalog hydration or publishing.
let adminServer;
try {
  adminServer = await startAdminServer({ pool, providers, publisherDid, publisherHost });
} catch (error) {
  console.error(`worker: admin API disabled — ${error.message}`);
}

// Metrics are best-effort: a port conflict must not stop hydration/publishing.
let metricsServer;
try {
  metricsServer = await startMetricsServer({
    pool,
    limit: isbndbDailyLimit,
    providerMetrics: providers.metrics,
    coverMetrics,
    bookhiveMetrics,
    // Outbox gauges count the rows this publisher can claim; a database shared
    // with another identity must not inflate this worker's backlog.
    publisherDid
  });
} catch (error) {
  console.error(`worker: metrics server disabled — ${error.message}`);
}

// The labeler serves the labels this worker signs. Like the admin API it is
// best-effort: a bound port must not stop hydration or publishing, and the
// queued rows wait for it.
let labelerServer;
if (labelerKeypair) {
  try {
    labelerServer = await startLabeler({
      pool,
      src: labelerDid,
      port: labelerPort
    });
  } catch (error) {
    console.error(`worker: labeler endpoint disabled — ${error.message}`);
  }
}

// The PDS publisher is configured or loud about it. The worker still runs the
// hydration tasks without credentials; only pds-publish is unavailable.
const publisherConfig = resolvePublisherConfig();
let publisher;
if (publisherConfig.configured) {
  publisher = createOutboxPublisher({ pool, config: publisherConfig, coversBaseUrl });
} else {
  console.error(
    'worker: pds-publish is DISABLED — missing/invalid configuration: ' +
      publisherConfig.problems.join('; ') +
      '. Catalog rows still queue in pds_outbox and nothing is lost; set' +
      ' PDS_URL, the publisher DID and PDS_ACCOUNT_PASSWORD/PDS_ACCESS_TOKEN and restart.'
  );
}

// A graceful stop is announced before graphile aborts in-flight jobs: the pool
// emits `pool:gracefulShutdown` the moment SIGTERM lands, and only aborts after
// `gracefulShutdownAbortTimeout`. The long tasks watch this signal, so they
// return at their next checkpoint *inside* the window — which is what lets
// graphile complete them cleanly instead of abandoning their job and queue
// locks for four hours.
const shutdown = new AbortController();

const taskList = createTasks({
  pool,
  providers,
  publisherDid,
  publisherHost,
  publisher,
  coversCacheDir,
  coversBaseUrl,
  coverMetrics,
  bookhiveMetrics,
  signal: shutdown.signal,
  // Null when the key is missing, which is what makes `labels.emit` refuse the
  // job instead of signing nothing.
  labels: labelerKeypair ? { keypair: labelerKeypair, src: labelerDid } : null
});

// One publisher at a time: the task queue serializes the jobs, so two batches
// never race for the same rows (claiming is safe anyway, this just avoids noise).
//
// The catalog sweeps are unconditional: they only enqueue fetch jobs, which work
// with or without publisher credentials. Passing a non-empty list also overrides
// graphile-worker's default `./crontab` read, which this deployment never wanted.
const cronItems = [];
if (publisher) {
  cronItems.push({
    task: 'pds-publish',
    match: '* * * * *',
    options: {
      queueName: 'pds-publish',
      jobKey: 'pds-publish:cron',
      maxAttempts: 3
    }
  });
}
cronItems.push({
  // A librarian's approval queues a label; signing it from the table means a
  // restart during that window re-emits it. `maxAttempts: 1` is deliberate: a
  // failed batch is already backed off row by row inside `emitLabels`, so a
  // graphile retry would only sign the same rows twice.
  task: 'labels.emit',
  match: '* * * * *',
  options: {
    queueName: 'labels',
    jobKey: 'labels.emit:cron',
    maxAttempts: 1
  }
});
cronItems.push({
  task: 'catalog.genres.sweep',
  match: '*/10 * * * *',
  options: {
    queueName: 'genres-sweep',
    jobKey: 'catalog.genres.sweep:cron',
    maxAttempts: 3
  }
});
cronItems.push({
  task: 'catalog.covers.sweep',
  match: '*/5 * * * *',
  options: {
    queueName: 'covers-sweep',
    jobKey: 'catalog.covers.sweep:cron',
    maxAttempts: 3
  }
});
cronItems.push({
  // The edge's enqueue marks are only read inside its own windows (the longest
  // is an hour), so anything older than a day is dead weight. Hourly, off the
  // top of the hour so it does not queue behind the sweeps.
  task: 'catalog.marks.prune',
  match: '17 * * * *',
  options: {
    queueName: 'marks-prune',
    jobKey: 'catalog.marks.prune:cron',
    maxAttempts: 3
  }
});
cronItems.push({
  task: 'catalog.bookhive',
  match: '0 3 * * 1',
  options: {
    queueName: 'bookhive',
    jobKey: 'catalog.bookhive:cron',
    maxAttempts: 2
  }
});
cronItems.push({
  // One batch a day, spent under the task's `ISBN_BACKFILL_PER_DAY` budget: the
  // work is free-provider lookups over a ~100k-edition backlog, so the point is
  // a steady trickle, not a flood. The per-edition jobs run on the
  // `isbn-backfill` queue; the sweep keeps its own queue so a busy backfill
  // never delays it. The daily budget, not the queue, is what bounds the work.
  task: 'catalog.isbn.backfill.sweep',
  match: '0 4 * * *',
  options: {
    queueName: 'isbn-backfill-sweep',
    jobKey: 'catalog.isbn.backfill.sweep:cron',
    maxAttempts: 3
  }
});
const parsedCronItems = parseCronItems(cronItems);

const runner = await run({
  connectionString: databaseUrl,
  concurrency,
  // Graphile's own pool (job fetch, locks, completion). It defaults to 10, which
  // puts a ceiling under a higher concurrency: workers would queue for a
  // connection to claim their next job.
  maxPoolSize: graphilePoolMax,
  taskList,
  parsedCronItems,
  logger: undefined,
  // Graphile stops fetching on SIGTERM, then aborts in-flight jobs after this
  // window and only then force-terminates. Default is 5s, which a batched
  // drain or a catalog walk cannot observe; 30s lets both reach their next
  // checkpoint (a claim boundary, a page boundary) and settle cleanly.
  gracefulShutdownAbortTimeout: 30_000
});

runner.events.on('pool:gracefulShutdown', ({ message }) => {
  shutdown.abort(new Error(message));
});
runner.events.on('pool:gracefulShutdown:complete', () => {
  console.log('worker: graceful shutdown complete');
});

// Report the repo authority, configured or not: it is the identity catalog URIs
// are minted under, whether or not publisher credentials are present.
const publisherLabel = publisher ? publisher.config.publisherDid : publisherDid;
console.log(
  `worker: ready (concurrency=${concurrency}, publisher=${publisherLabel}, ` +
    `isbndb=${providers.providers.isbndb ? 'enabled' : 'disabled'}, ` +
    `isbndb-daily-limit=${isbndbDailyLimit}, ` +
    `metrics=${metricsServer ? 'enabled' : 'disabled'}, ` +
    `admin=${adminServer ? adminServer.url : 'disabled'}, ` +
    `pds-publish=${publisher ? 'enabled' : 'disabled'}, ` +
    `labeler=${labelerServer ? `${labelerDid} @ ${labelerServer.url}` : 'disabled'})`
);

// Cron fires at the top of each minute; drain once at boot so a backlog from a
// restart does not wait for it.
if (publisher) {
  await runner.addJob('pds-publish', {}, {
    queueName: 'pds-publish',
    maxAttempts: 3,
    // A restart loop must not pile up boot jobs; one queued drain is enough.
    jobKey: 'pds-publish:boot',
    jobKeyMode: 'unsafe_dedupe'
  });
}

// A queued label should not wait a minute for the cron after a restart.
if (labelerServer) {
  await runner.addJob('labels.emit', {}, {
    queueName: 'labels',
    maxAttempts: 1,
    jobKey: 'labels.emit:boot',
    jobKeyMode: 'unsafe_dedupe'
  });
}

// Same for the genre backlog: a restart should file the existing editions
// immediately instead of waiting up to ten minutes for the cron.
await runner.addJob('catalog.genres.sweep', {}, {
  queueName: 'genres-sweep',
  maxAttempts: 3,
  jobKey: 'catalog.genres.sweep:boot',
  jobKeyMode: 'unsafe_dedupe'
});

// Coverless editions are a much smaller backlog and cost one provider request
// each, so the boot drain is the same one-shot job on its own queue.
await runner.addJob('catalog.covers.sweep', {}, {
  queueName: 'covers-sweep',
  maxAttempts: 3,
  jobKey: 'catalog.covers.sweep:boot',
  jobKeyMode: 'unsafe_dedupe'
});

try {
  await runner.promise;
} finally {
  if (adminServer) await adminServer.close();
  if (metricsServer) {
    await new Promise((resolve) => metricsServer.close(resolve));
  }
  if (labelerServer) await labelerServer.close();
  await pool.end();
}
