import { readFile, readdir } from 'node:fs/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { ensureSupportSchema } from './lib/setup.js';

// The suite creates and truncates rows in the catalog tables, so it must never
// run against the development database `DATABASE_URL` names. Instead every run
// gets its own throwaway Postgres, and the catalog schema is replayed from
// packages/worker/sql/*.sql in lexical order the way `deploy.sh` does. Files
// 0003/0018/0020 guard themselves on HappyView's tables and skip: the
// container, like a fresh deployment, has no HappyView schema.
const SQL_DIR = new URL('./sql/', import.meta.url);
const IMAGE = 'postgres:18.4';

export default async function setup() {
  // `catalog-schema-check` creates its own scratch database, applies the SQL
  // and points the one integration file at it via CATALOG_SCHEMA_TEST_DATABASE_URL.
  // That invocation needs no container (and CI may have no Docker), so leave
  // the environment alone and start nothing.
  if (process.env.CATALOG_SCHEMA_TEST_DATABASE_URL) return async () => {};

  const started = Date.now();
  const container = await new PostgreSqlContainer(IMAGE).start();
  const url = container.getConnectionUri();

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const files = (await readdir(SQL_DIR)).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(await readFile(new URL(file, SQL_DIR), 'utf8'));
    }
  } finally {
    await client.end();
  }

  // `index.js` creates the enqueue-mark throttling table at boot, so every
  // deployed database has it. Doing it here keeps two test files from racing
  // the same `CREATE INDEX IF NOT EXISTS` on a container that starts empty.
  const support = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await ensureSupportSchema(support);
  } finally {
    await support.end();
  }

  // Forked test processes inherit the environment when they are spawned, which
  // is after this hook runs, so every file sees the container.
  process.env.DATABASE_URL = url;
  console.log(`[testcontainers] postgres ready in ${Date.now() - started}ms: ${url}`);

  return async () => {
    await container.stop();
  };
}
