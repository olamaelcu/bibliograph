/**
 * Playwright global setup: one throwaway database, the fixture PDS/PLC, and the
 * two processes this app is.
 *
 * What it starts, in order:
 *
 *  1. a Postgres testcontainer, with HappyView's record table (the fixture
 *     shape the worker suites use) and every `packages/worker/sql` file applied,
 *     exactly as `deploy.sh` replays them;
 *  2. one contributor and two claim records, so the librarian queue has
 *     something to decide;
 *  3. the worker, which serves the admin API the librarian page calls and owns
 *     the outbox/labeler jobs;
 *  4. the edge (Vite dev server), pointed at that database and worker.
 *
 * The PLC and PDS are *not* started here: they are the fixture environment the
 * repo's compose stack already runs (`docker compose up -d`), and the release
 * path this test verifies ends there — the `knownContributor` record is fetched
 * back from the fixture PDS. Without `PDS_URL`/`PDS_ACCOUNT_DID`/
 * `PDS_ACCOUNT_PASSWORD` in the environment (mise loads `.env`) the suite is
 * skipped with a reason rather than failing.
 *
 * The librarian signs in through the app's form and the fixture PDS's own pages:
 * the spec drives that OAuth round trip, so the account named by
 * `HAPPYVIEW_ACCOUNT_DID`/`HV_ACCOUNT_HANDLE` must exist and its password must
 * be `HV_ACCOUNT_PASSWORD` (the `mise run hv-account` default).
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

// Worker-internal fixtures: the same schema helpers its own suites use.
import { ensureHappyviewRecords, indexClaim } from '../packages/worker/test/support/happyview.js';
import { ensureSupportSchema } from '../packages/worker/lib/setup.js';

import {
  ROOT,
  clearState,
  startProcess,
  stopProcess,
  waitForHttp,
  writeState,
  type HarnessState
} from './harness.ts';

const IMAGE = 'postgres:18.4';
const SQL_DIR = new URL('../packages/worker/sql/', import.meta.url);
const STATE_DIR = fileURLToPath(new URL('../.cache/e2e/', import.meta.url));

// Deliberately not the development ports: a dev worker or dev server may
// already own 9464-9466 and 5176.
const EDGE_PORT = 5191;
const ADMIN_PORT = 19465;
const METRICS_PORT = 19464;
const LABELER_PORT = 19466;

const APPROVED_DID = 'did:plc:e2eapproved';
const REJECTED_DID = 'did:plc:e2erejected';
const AUTHORITY = 'did:plc:e2eauthority';
const CONTRIBUTOR_URI = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3e2econtributor`;
const CONTRIBUTOR_NAME = 'E2E Author';

const SESSION_SECRET = 'e2e-librarian-session-secret';
const ADMIN_TOKEN = 'e2e-admin-token';

function fixtureConfig() {
  const { PDS_URL, PDS_ACCOUNT_DID, PDS_ACCOUNT_PASSWORD, HAPPYVIEW_ACCOUNT_DID, HV_ACCOUNT_HANDLE } =
    process.env;
  if (!PDS_URL || !PDS_ACCOUNT_DID || !PDS_ACCOUNT_PASSWORD) {
    return {
      reason:
        'PDS_URL, PDS_ACCOUNT_DID and PDS_ACCOUNT_PASSWORD are unset; run `docker compose up -d` and use `mise run test-e2e` so .env is loaded'
    };
  }
  if (!HAPPYVIEW_ACCOUNT_DID || !HV_ACCOUNT_HANDLE) {
    return {
      reason:
        'HAPPYVIEW_ACCOUNT_DID/HV_ACCOUNT_HANDLE are unset, so there is no fixture account to sign in as; `mise run hv-account` creates one'
    };
  }
  return {
    PDS_URL,
    PDS_ACCOUNT_DID,
    PDS_ACCOUNT_PASSWORD,
    librarianDid: HAPPYVIEW_ACCOUNT_DID,
    librarianHandle: HV_ACCOUNT_HANDLE
  };
}

async function applySchema(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // HappyView owns this table; 0003/0018/0020 index it, so it exists first.
    await ensureHappyviewRecords(client as unknown as pg.Pool);
    const files = (await readdir(SQL_DIR)).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(await readFile(new URL(file, SQL_DIR), 'utf8'));
    }
    await ensureSupportSchema(client as unknown as pg.Pool);
  } finally {
    await client.end();
  }
}

async function seedClaims(url: string): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query(
    `INSERT INTO contributors (name, at_uri) VALUES ($1, $2) RETURNING id`,
    [CONTRIBUTOR_NAME, CONTRIBUTOR_URI]
  );
  // The insert queues the contributor's own record; the decisions below are
  // what this test asserts on, so start the outbox clean.
  await pool.query('DELETE FROM pds_outbox WHERE uri = $1', [CONTRIBUTOR_URI]);
  await indexClaim(pool, APPROVED_DID, CONTRIBUTOR_URI, 'I wrote the book.');
  await indexClaim(pool, REJECTED_DID, CONTRIBUTOR_URI, 'Please let me in.');
  return pool;
}

type AdminFixtures = {
  contributorSourceId: string;
  contributorTargetId: string;
  publisherSourceId: string;
  publisherTargetId: string;
  bookBaseUri: string;
  bookOtherUri: string;
  guardContributorId: string;
  guardPublisherId: string;
  deleteEditionUri: string;
  bothIdentitySourceId: string;
  bothIdentityTargetId: string;
  workbenchBaseUri: string;
  workbenchOtherUri: string;
};

/**
 * Catalog rows the admin scenarios act on: two duplicate contributors (one with
 * a credit and a verified identity), two publishers, and two editions of one
 * work that the merge workbench would combine.
 */
async function seedAdminFixtures(url: string): Promise<AdminFixtures> {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const contributorSource = await pool.query<{ id: string }>(
      'INSERT INTO contributors (name, at_uri) VALUES ($1, $2) RETURNING id',
      ['E2E Merge Source', `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3e2emergesource`]
    );
    const contributorTarget = await pool.query<{ id: string }>(
      'INSERT INTO contributors (name, at_uri) VALUES ($1, $2) RETURNING id',
      ['E2E Merge Target', `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3e2emergetarget`]
    );

    const bookBaseUri = `at://${AUTHORITY}/community.lexicon.media.book.edition/3e2ebase`;
    const bookOtherUri = `at://${AUTHORITY}/community.lexicon.media.book.edition/3e2eother`;
    await pool.query(
      `INSERT INTO books (uri, rkey, title, created_at) VALUES
         ($1, '3e2ebase', 'E2E Base Edition', '2026-01-01T00:00:00Z'),
         ($2, '3e2eother', 'E2E Other Edition', '2026-01-01T00:00:00Z')`,
      [bookBaseUri, bookOtherUri]
    );
    await pool.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES
         ($1, 'isbn13', '9780000000001'),
         ($2, 'isbn13', '9780000000002')`,
      [bookBaseUri, bookOtherUri]
    );
    // A credit and a verified identity on the source: both have to move.
    await pool.query(
      `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
       VALUES ($1, $2, 1, 'author')`,
      [bookOtherUri, contributorSource.rows[0].id]
    );
    await pool.query(
      `INSERT INTO contributor_identities (contributor_id, did, at_uri, issued_by)
       VALUES ($1, 'did:plc:e2emergesource',
               'at://did:plc:e2emergesource/net.olamaelcu.livtet.biblio.knownContributor/3e2eknown',
               'did:plc:e2elibrarian')`,
      [contributorSource.rows[0].id]
    );

    // `publishers.identifiers` is the stored bag `{issuer, value, url?}` — the
    // shape `canonicalIdentifiers` keys on, not the record lexicon's
    // `{resource, url}` (that is what `defs#identifier` publishes).
    const publisherSource = await pool.query<{ id: string }>(
      'INSERT INTO publishers (name, identifiers) VALUES ($1, $2::jsonb) RETURNING id',
      [
        'E2E Merge Press',
        JSON.stringify([{ issuer: 'isni', value: '0000000000000001' }])
      ]
    );
    const publisherTarget = await pool.query<{ id: string }>(
      'INSERT INTO publishers (name, identifiers) VALUES ($1, $2::jsonb) RETURNING id',
      [
        'E2E Merge Press Ltd',
        JSON.stringify([{ issuer: 'isni', value: '0000000000000002' }])
      ]
    );

    // ── guard fixtures ────────────────────────────────────────────────────
    // One credited contributor (delete refused), one publisher attached to an
    // edition (delete refused), one edition with nothing attached (delete
    // allowed), two contributors that each carry an identity (merge survivor
    // keeps its own), and two editions for the merge workbench UI.
    const guardEditionUri = `at://${AUTHORITY}/community.lexicon.media.book.edition/3e2eguard`;
    await pool.query(
      `INSERT INTO books (uri, rkey, title, created_at) VALUES ($1, '3e2eguard', 'E2E Guard Edition', '2026-01-01T00:00:00Z')`,
      [guardEditionUri]
    );
    await pool.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES ($1, 'isbn13', '9780000000003')`,
      [guardEditionUri]
    );
    const guardContributor = await pool.query<{ id: string }>(
      'INSERT INTO contributors (name, at_uri) VALUES ($1, $2) RETURNING id',
      ['E2E Guard Author', `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3e2eguardauthor`]
    );
    await pool.query(
      `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
       VALUES ($1, $2, 1, 'author')`,
      [guardEditionUri, guardContributor.rows[0].id]
    );
    const guardPublisher = await pool.query<{ id: string }>(
      'INSERT INTO publishers (name) VALUES ($1) RETURNING id',
      ['E2E Guard Press']
    );
    await pool.query(
      `INSERT INTO edition_identifier_publishers (edition_uri, issuer, value, publisher_id, position)
       VALUES ($1, 'isbn13', '9780000000003', $2, 1)`,
      [guardEditionUri, guardPublisher.rows[0].id]
    );

    const deleteEditionUri = `at://${AUTHORITY}/community.lexicon.media.book.edition/3e2edelete`;
    await pool.query(
      `INSERT INTO books (uri, rkey, title, created_at) VALUES ($1, '3e2edelete', 'E2E Delete Edition', '2026-01-01T00:00:00Z')`,
      [deleteEditionUri]
    );

    const bothSource = await pool.query<{ id: string }>(
      'INSERT INTO contributors (name, at_uri) VALUES ($1, $2) RETURNING id',
      ['E2E Both Identity Source', `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3e2ebotha`]
    );
    const bothTarget = await pool.query<{ id: string }>(
      'INSERT INTO contributors (name, at_uri) VALUES ($1, $2) RETURNING id',
      ['E2E Both Identity Target', `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3e2ebothb`]
    );
    await pool.query(
      `INSERT INTO contributor_identities (contributor_id, did, at_uri, issued_by) VALUES
         ($1, 'did:plc:e2ebotha',
          'at://did:plc:e2ebotha/net.olamaelcu.livtet.biblio.knownContributor/3e2ebotha', 'did:plc:e2elibrarian'),
         ($2, 'did:plc:e2ebothb',
          'at://did:plc:e2ebothb/net.olamaelcu.livtet.biblio.knownContributor/3e2ebothb', 'did:plc:e2elibrarian')`,
      [bothSource.rows[0].id, bothTarget.rows[0].id]
    );

    const workbenchBaseUri = `at://${AUTHORITY}/community.lexicon.media.book.edition/3e2ewbbase`;
    const workbenchOtherUri = `at://${AUTHORITY}/community.lexicon.media.book.edition/3e2ewbother`;
    await pool.query(
      `INSERT INTO books (uri, rkey, title, created_at) VALUES
         ($1, '3e2ewbbase', 'E2E Workbench Base', '2026-01-01T00:00:00Z'),
         ($2, '3e2ewbother', 'E2E Workbench Other', '2026-01-01T00:00:00Z')`,
      [workbenchBaseUri, workbenchOtherUri]
    );

    return {
      contributorSourceId: contributorSource.rows[0].id,
      contributorTargetId: contributorTarget.rows[0].id,
      publisherSourceId: publisherSource.rows[0].id,
      publisherTargetId: publisherTarget.rows[0].id,
      bookBaseUri,
      bookOtherUri,
      guardContributorId: guardContributor.rows[0].id,
      guardPublisherId: guardPublisher.rows[0].id,
      deleteEditionUri,
      bothIdentitySourceId: bothSource.rows[0].id,
      bothIdentityTargetId: bothTarget.rows[0].id,
      workbenchBaseUri,
      workbenchOtherUri
    };
  } finally {
    await pool.end();
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  clearState();
  mkdirSync(STATE_DIR, { recursive: true });

  const fixture = fixtureConfig();
  if ('reason' in fixture) {
    writeState({ ready: false, reason: fixture.reason } as HarnessState);
    return async () => {};
  }

  const container = await new PostgreSqlContainer(IMAGE).start();
  const databaseUrl = container.getConnectionUri();
  const children: ChildProcess[] = [];

  const teardown = async () => {
    for (const child of children) stopProcess(child);
    await container.stop().catch(() => {});
    clearState();
  };

  try {
    await applySchema(databaseUrl);
    const seedPool = await seedClaims(databaseUrl);
    await seedPool.end();
    const adminFixtures = await seedAdminFixtures(databaseUrl);

    const keyFile = fileURLToPath(new URL('../.cache/e2e/labeler.key', import.meta.url));
    rmSync(keyFile, { force: true });
    const generated = execFileSync(
      process.execPath,
      ['scripts/gen-labeler-key.mjs'],
      { cwd: `${ROOT}packages/worker`, encoding: 'utf8' }
    );
    writeFileSync(keyFile, generated, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const labelerPublic = /^public=(.+)$/m.exec(generated)?.[1]?.trim() ?? '';

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ADMIN_TOKEN,
      PDS_URL: fixture.PDS_URL,
      PDS_ACCOUNT_DID: fixture.PDS_ACCOUNT_DID,
      PDS_ACCOUNT_PASSWORD: fixture.PDS_ACCOUNT_PASSWORD
    };

    const workerLog = `${STATE_DIR}worker.log`;
    const worker = await startProcess({
      name: 'worker',
      command: process.execPath,
      args: ['index.js'],
      cwd: `${ROOT}packages/worker`,
      env: {
        ...baseEnv,
        WORKER_ADMIN_PORT: String(ADMIN_PORT),
        WORKER_METRICS_PORT: String(METRICS_PORT),
        WORKER_CLEAR_STALE_LOCKS: '1',
        LABELER_KEY_FILE: keyFile,
        LABELER_DID: 'did:web:e2e.labeler.test',
        LABELER_PORT: String(LABELER_PORT)
      },
      readyPattern: /worker: ready/,
      logFile: workerLog
    });
    children.push(worker);

    // The built edge, not `vite dev`: HMR's dependency optimizer fetches modules
    // on demand and can abort a page load mid-navigation, which showed up as a
    // hung admin scenario. This is also the artifact the package ships.
    execFileSync('pnpm', ['--filter', 'web', 'build'], { cwd: ROOT, stdio: 'inherit' });

    const edgeLog = `${STATE_DIR}edge.log`;
    const edge = await startProcess({
      name: 'edge',
      command: process.execPath,
      args: ['build'],
      cwd: `${ROOT}packages/web`,
      env: {
        ...baseEnv,
        PORT: String(EDGE_PORT),
        HOST: '127.0.0.1',
        // adapter-node builds every absolute URL from ORIGIN; it must match the
        // browser's origin or CSRF checks fail.
        ORIGIN: `http://127.0.0.1:${EDGE_PORT}`,
        WORKER_ADMIN_URL: `http://127.0.0.1:${ADMIN_PORT}`,
        // The fixture account that owns HV_ACCOUNT_HANDLE is the librarian.
        LIBRARIAN_DIDS: fixture.librarianDid,
        LIBRARIAN_SESSION_SECRET: SESSION_SECRET,
        LIVTET_LABELER_KEY_MULTIBASE: labelerPublic,
        LIVTET_LABELER_ORIGIN: `http://127.0.0.1:${LABELER_PORT}`,
        // The claims page never calls HappyView; a dead address keeps any other
        // route from reaching the development stack by accident.
        HAPPYVIEW_URL: 'http://127.0.0.1:9'
      },
      readyPattern: /Listening on/,
      logFile: edgeLog
    });
    children.push(edge);

    const edgeUrl = `http://127.0.0.1:${EDGE_PORT}`;
    await waitForHttp(`${edgeUrl}/`, 60_000);

    writeState({
      ready: true,
      databaseUrl,
      edgeUrl,
      workerAdminUrl: `http://127.0.0.1:${ADMIN_PORT}`,
      labelerUrl: `http://127.0.0.1:${LABELER_PORT}`,
      labelerPublic,
      librarianDid: fixture.librarianDid,
      librarianHandle: fixture.librarianHandle,
      contributorUri: CONTRIBUTOR_URI,
      contributorName: CONTRIBUTOR_NAME,
      approvedDid: APPROVED_DID,
      rejectedDid: REJECTED_DID,
      publisherDid: fixture.PDS_ACCOUNT_DID,
      pdsUrl: fixture.PDS_URL,
      adminToken: ADMIN_TOKEN,
      ...adminFixtures,
      workerLog,
      edgeLog
    });

    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
