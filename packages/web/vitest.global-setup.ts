import { readFile, readdir } from 'node:fs/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

// The DB-backed suites create and truncate their own scratch schemas, so they
// must never run against the development database `DATABASE_URL` names. Every
// run gets its own throwaway Postgres. The catalog SQL is replayed into `public`
// the way `deploy.sh` does because the suites both read `packages/worker/sql`
// for their scratch schemas and clean up rows in the public catalog tables.
const SQL_DIR = new URL('../worker/sql/', import.meta.url);
const IMAGE = 'postgres:18.4';

// HappyView owns the `happyview` schema; its DDL ships inside the pinned binary,
// not this repo, but the worker SQL and the suites read it. This is the same
// shape read off a live HappyView database, plus the account registry that
// 0038's `actor_handles` view reads (that migration grants it to the
// `happyview_app` role, so the container needs the role too).
const HAPPYVIEW_FIXTURE = `
CREATE SCHEMA happyview;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happyview_app') THEN
    CREATE ROLE happyview_app;
  END IF;
END $$;
CREATE TABLE happyview.happyview_linked_repos (
  did text NOT NULL PRIMARY KEY,
  handle text
);
CREATE TABLE happyview.happyview_records (
  uri text NOT NULL PRIMARY KEY,
  did text NOT NULL,
  collection text NOT NULL,
  rkey text NOT NULL,
  record text NOT NULL,
  cid text NOT NULL,
  indexed_at text,
  created_at text NOT NULL
);
`;

export default async function setup() {
  const started = Date.now();
  const container = await new PostgreSqlContainer(IMAGE).start();
  const url = container.getConnectionUri();

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(HAPPYVIEW_FIXTURE);
    const files = (await readdir(SQL_DIR)).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(await readFile(new URL(file, SQL_DIR), 'utf8'));
    }
  } finally {
    await client.end();
  }

  // Forked test processes inherit the environment when they are spawned, which
  // is after this hook runs, so every file sees the container.
  process.env.DATABASE_URL = url;
  console.log(`[testcontainers] postgres ready in ${Date.now() - started}ms: ${url}`);

  return async () => {
    await container.stop();
  };
}
