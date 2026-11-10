import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actorView,
  avatarCidFromUrl,
  buildActorCountQuery,
  buildActorPageQuery,
  likeContains,
  normalizeSearchActorsParams,
  searchActors,
  type ActorDirectoryDb,
  type ActorRow,
} from './actor-directory';
import { db } from './db';

function row(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    did: 'did:plc:reader',
    handle: 'reader.test',
    displayName: 'Reader',
    description: null,
    avatarCid: null,
    ...overrides,
  };
}

/** A LIKE/DID fragment is escaped so it matches itself, not a wildcard. */
test('likeContains escapes the LIKE metacharacters', () => {
  assert.equal(likeContains('plain'), '%plain%');
  assert.equal(likeContains('100%'), '%100\\%%');
  assert.equal(likeContains('a_b'), '%a\\_b%');
  assert.equal(likeContains('a\\b'), '%a\\\\b%');
});

test('avatarCidFromUrl reads the blob CID out of the public CDN URL', () => {
  assert.equal(
    avatarCidFromUrl(
      'https://cdn.bsky.app/img/avatar/plain/did:plc:reader/bafkreiaaaaaaa@jpeg',
    ),
    'bafkreiaaaaaaa',
  );
  assert.equal(avatarCidFromUrl('https://example.com/avatar.jpg'), null);
  assert.equal(avatarCidFromUrl(undefined), null);
});

test('actorView omits fields the read model has not resolved', () => {
  assert.deepEqual(actorView(row()), {
    did: 'did:plc:reader',
    handle: 'reader.test',
    displayName: 'Reader',
  });
  assert.deepEqual(
    actorView(row({ handle: null, displayName: null, description: '', avatarCid: 'bafkcid' })),
    {
      did: 'did:plc:reader',
      avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:reader/bafkcid',
    },
  );
});

test('normalizeSearchActorsParams trims q and clamps pagination', () => {
  const normalized = normalizeSearchActorsParams({
    q: '  nee  ',
    hasRecords: ['buzz.bookhive.book'],
    limit: 500,
    offset: -3,
  });
  assert.equal(normalized.q, 'nee');
  assert.equal(normalized.limit, 100);
  assert.equal(normalized.offset, 0);
  assert.deepEqual(normalized.collections, ['buzz.bookhive.book']);
  assert.equal(normalizeSearchActorsParams({}).q, undefined);
});

/**
 * The hard requirement, asserted as text: the q predicate and the records
 * EXISTS probe are in the WHERE, which precedes ORDER BY / LIMIT / OFFSET.
 */
test('the page query filters before ordering and paginating', () => {
  const params = normalizeSearchActorsParams({
    q: 'needle',
    hasRecords: ['buzz.bookhive.book', 'net.olamaelcu.livtet.biblio.bookShelving'],
    limit: 5,
    offset: 10,
  });
  const built = buildActorPageQuery(db, params).toSQL();
  const text = built.sql;

  const whereAt = text.indexOf(' where ');
  const orderAt = text.indexOf(' order by ');
  const limitAt = text.indexOf(' limit ');
  const offsetAt = text.indexOf(' offset ');
  assert.ok(whereAt > 0, text);
  assert.ok(whereAt < orderAt, text);
  assert.ok(orderAt < limitAt, text);
  assert.ok(limitAt < offsetAt, text);

  // Both halves of the filter are in that WHERE, and the records probe is
  // correlated on the actor row rather than materialized as a join.
  assert.match(text, /"actors"\."handle" ILIKE \$\d+ ESCAPE '\\'/);
  assert.match(text, /"actors"\."display_name" ILIKE \$\d+ ESCAPE '\\'/);
  assert.match(text, /"actors"\."did" = \$\d+/);
  assert.match(text, /exists \(\s*select 1\s*from "records"/);
  assert.match(text, /"records"\."did" = "actors"\."did"/);
  assert.match(text, /"records"\."collection" in \(\$\d+, \$\d+\)/);
  assert.match(text, /order by coalesce\("actors"\."handle", "actors"\."did"\) asc, "actors"\."did" asc/);

  // `limit + 1` is what answers hasMore; the offset is the caller's.
  assert.deepEqual(built.params.slice(-2), [6, 10]);
  assert.ok(built.params.includes('%needle%'));
  assert.ok(built.params.includes('buzz.bookhive.book'));
});

test('an exact-DID q is an equality on the primary key', () => {
  const built = buildActorPageQuery(
    db,
    normalizeSearchActorsParams({ q: 'did:plc:reader' }),
  ).toSQL();
  assert.match(built.sql, /"actors"\."did" = \$\d+/);
  assert.doesNotMatch(built.sql, /exists \(/);
});

test('hasRecords alone adds no text filter', () => {
  const built = buildActorPageQuery(
    db,
    normalizeSearchActorsParams({ hasRecords: ['buzz.bookhive.book'] }),
  ).toSQL();
  assert.doesNotMatch(built.sql, /ILIKE/);
  assert.match(built.sql, /exists \(\s*select 1\s*from "records"/);
});

test('the count reuses the same WHERE', () => {
  const params = normalizeSearchActorsParams({ q: 'needle', hasRecords: ['buzz.bookhive.book'] });
  const page = buildActorPageQuery(db, params).toSQL();
  const count = buildActorCountQuery(db, params).toSQL();
  // Only the projection and the page bounds differ: the count binds the same
  // filter parameters and stops before the page's limit/offset.
  assert.deepEqual(page.params.slice(0, count.params.length), count.params);
  assert.match(count.sql, /exists \(/);
  assert.match(count.sql, /ILIKE/);
  assert.match(count.sql, /count\(\*\)::int/);
});

interface CallCapture {
  order: string[];
  limit?: number;
  offset?: number;
  countQueries: number;
}

/**
 * A builder-shaped fake: it returns the rows it was handed, in the order and
 * page bounds the module asked for. `then` makes the chain awaitable exactly as
 * drizzle's own builder is.
 */
function fakeDb(rows: ActorRow[], total: number, capture: CallCapture): ActorDirectoryDb {
  return {
    select(selection: Record<string, unknown>) {
      const isCount = 'total' in selection;
      const builder: Record<string, unknown> = {
        from() {
          return builder;
        },
        where() {
          capture.order.push('where');
          return builder;
        },
        orderBy() {
          capture.order.push('orderBy');
          return builder;
        },
        limit(n: number) {
          capture.limit = n;
          capture.order.push('limit');
          return builder;
        },
        offset(n: number) {
          capture.offset = n;
          capture.order.push('offset');
          return builder;
        },
        then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
          if (isCount) {
            capture.countQueries += 1;
            return Promise.resolve([{ total }]).then(resolve, reject);
          }
          const start = capture.offset ?? 0;
          const end = start + (capture.limit ?? rows.length);
          return Promise.resolve(rows.slice(start, end)).then(resolve, reject);
        },
      };
      return builder;
    },
  } as unknown as ActorDirectoryDb;
}

test('hasMore is true exactly when a row past the page exists', async () => {
  const capture: CallCapture = { order: [], countQueries: 0 };
  const rows = [row({ did: 'did:plc:a' }), row({ did: 'did:plc:b' }), row({ did: 'did:plc:c' })];

  const first = await searchActors({ limit: 2 }, fakeDb(rows, 3, capture));
  assert.equal(first.actors.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.total, 3);
  // The extra row is requested from SQL, not fetched then trimmed.
  assert.equal(capture.limit, 3);
  assert.deepEqual(capture.order.slice(0, 4), ['where', 'orderBy', 'limit', 'offset']);

  const last = await searchActors({ limit: 3 }, fakeDb(rows, 3, capture));
  assert.equal(last.actors.length, 3);
  assert.equal(last.hasMore, false);
});

test('an empty result is an empty page, not an error', async () => {
  const capture: CallCapture = { order: [], countQueries: 0 };
  const page = await searchActors({ q: 'nobody-matches' }, fakeDb([], 0, capture));
  assert.deepEqual(page, { actors: [], hasMore: false, total: 0 });
});

test('total is a first-page cost only', async () => {
  const capture: CallCapture = { order: [], countQueries: 0 };
  const page = await searchActors({ offset: 25, limit: 5 }, fakeDb([], 0, capture));
  assert.equal(page.total, undefined);
  assert.equal(capture.countQueries, 0);
  assert.equal(capture.offset, 25);
  assert.equal(capture.limit, 6);
});

test('walking pages covers each actor once', async () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    row({ did: `did:plc:${index}`, handle: `reader${index}.test` }),
  );
  const seen: string[] = [];
  const capture: CallCapture = { order: [], countQueries: 0 };
  for (let offset = 0; ; offset += 2) {
    const page = await searchActors({ limit: 2, offset }, fakeDb(rows, rows.length, capture));
    seen.push(...page.actors.map((actor) => actor.did));
    if (!page.hasMore) break;
  }
  assert.deepEqual(seen, rows.map((actor) => actor.did));
  assert.equal(new Set(seen).size, rows.length);
});
