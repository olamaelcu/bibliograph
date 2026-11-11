import pg from 'pg';
import { parseCronItems, run } from 'graphile-worker';
import { createProviders } from './lib/providers/index.js';
import { createTasks } from './lib/tasks.js';
import { createOutboxPublisher } from './lib/publish.js';
import { resolvePublisherConfig } from './lib/pds.js';
import { ensureSupportSchema } from './lib/setup.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('worker: DATABASE_URL is required');
  process.exit(1);
}

const publisherHost = process.env.ATP_SERVICE_HOST || 'biblio.livtet.olamaelcu.net';
const concurrency = Number.parseInt(process.env.GRAPHILE_WORKER_CONCURRENCY ?? '5', 10);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
await ensureSupportSchema(pool);

const providers = createProviders({ pool });

// The PDS publisher is configured or loud about it. The worker still runs the
// hydration tasks without credentials; only pds-publish is unavailable.
const publisherConfig = resolvePublisherConfig();
let publisher;
if (publisherConfig.configured) {
  publisher = createOutboxPublisher({ pool, config: publisherConfig });
} else {
  console.error(
    'worker: pds-publish is DISABLED — missing/invalid configuration: ' +
      publisherConfig.problems.join('; ') +
      '. Catalog rows still queue in pds_outbox and nothing is lost; set' +
      ' PDS_URL, the publisher DID and PDS_ACCOUNT_PASSWORD/PDS_ACCESS_TOKEN and restart.'
  );
}

const taskList = createTasks({ pool, providers, publisherHost, publisher });

// One publisher at a time: the task queue serializes the jobs, so two batches
// never race for the same rows (claiming is safe anyway, this just avoids noise).
const parsedCronItems = publisher
  ? parseCronItems([
      {
        task: 'pds-publish',
        match: '* * * * *',
        options: {
          queueName: 'pds-publish',
          jobKey: 'pds-publish:cron',
          maxAttempts: 3
        }
      }
    ])
  : // An empty list overrides graphile-worker's default `./crontab` read.
    [];

const runner = await run({
  connectionString: databaseUrl,
  concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 5,
  taskList,
  parsedCronItems,
  logger: undefined
});

// When publishing is configured, the identity that matters is the DID the
// records are written as, not the host used to mint catalog URIs.
const publisherLabel = publisher ? publisher.config.publisherDid : publisherHost;
console.log(
  `worker: ready (concurrency=${concurrency}, publisher=${publisherLabel}, ` +
    `isbndb=${providers.providers.isbndb ? 'enabled' : 'disabled'}, ` +
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

try {
  await runner.promise;
} finally {
  await pool.end();
}
