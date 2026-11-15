import pg from 'pg';
import { parseCronItems, run } from 'graphile-worker';
import { createProviders } from './lib/providers/index.js';
import { createTasks } from './lib/tasks.js';
import { createOutboxPublisher } from './lib/publish.js';
import { resolvePublisherAuthority, resolvePublisherConfig } from './lib/pds.js';
import { ensureSupportSchema } from './lib/setup.js';
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
const concurrency = Number.parseInt(process.env.GRAPHILE_WORKER_CONCURRENCY ?? '5', 10);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
await ensureSupportSchema(pool);

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

const taskList = createTasks({
  pool,
  providers,
  publisherDid,
  publisherHost,
  publisher,
  coversCacheDir,
  coversBaseUrl,
  coverMetrics,
  bookhiveMetrics
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
  task: 'catalog.bookhive',
  match: '0 3 * * 1',
  options: {
    queueName: 'bookhive',
    jobKey: 'catalog.bookhive:cron',
    maxAttempts: 2
  }
});
const parsedCronItems = parseCronItems(cronItems);

const runner = await run({
  connectionString: databaseUrl,
  concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 5,
  taskList,
  parsedCronItems,
  logger: undefined
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
    `pds-publish=${publisher ? 'enabled' : 'disabled'})`
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
  await pool.end();
}
