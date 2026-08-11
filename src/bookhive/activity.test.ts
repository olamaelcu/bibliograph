import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, clearSqliteTables } from '../test-utils/db.js';
import { schema } from '../db/connection.js';
import { BookhiveActivityEnumerator } from './activity.js';

const { db } = createTestDb();

beforeEach(() => {
  clearSqliteTables((db as any).$sqlite);
});

const CATALOG_DID = 'did:plc:enu2j5xjlqsjaylv3du4myh4';

function activityRecord(userDid: string, handle: string, hiveId: string) {
  return {
    uri: `at://${CATALOG_DID}/buzz.bookhive.activity/${hiveId}`,
    cid: 'cid-' + hiveId,
    value: {
      $type: 'buzz.bookhive.activity',
      type: 'started',
      title: 'Dune',
      hiveId,
      userDid,
      userHandle: handle,
      createdAt: '2026-07-28T16:53:43.424Z',
    },
  };
}

function catalogBookRecord(hiveId: string, title: string, authors: string) {
  return {
    uri: `at://${CATALOG_DID}/buzz.bookhive.book/${hiveId}`,
    cid: 'cid-' + hiveId,
    value: {
      $type: 'buzz.bookhive.book',
      title,
      authors,
      hiveId,
      status: 'buzz.bookhive.defs#reading',
      createdAt: '2026-07-28T16:53:43.424Z',
    },
  };
}

describe('BookhiveActivityEnumerator', () => {
  it('collects userDids from the activity feed into bookhive_user_discovery', async () => {
    const enumerator = new BookhiveActivityEnumerator(db, {
      catalogDid: CATALOG_DID,
      listActivity: async (opts) => ({
        records: [
          activityRecord('did:plc:user1', 'user1.bsky.social', 'bk_AAA'),
          activityRecord('did:plc:user2', 'user2.bsky.social', 'bk_BBB'),
          activityRecord('did:plc:user1', 'user1.bsky.social', 'bk_CCC'),
        ],
        cursor: undefined,
      }),
      listCatalogBooks: async () => ({ records: [], cursor: undefined }),
    });

    const result = await enumerator.enumerate();
    expect(result.discovered).toBe(2);

    const rows = db.select().from(schema.bookhiveUserDiscovery).all();
    expect(rows).toHaveLength(2);
    const byDid = new Map(rows.map((r) => [r.did, r]));
    expect(byDid.get('did:plc:user1')!.handle).toBe('user1.bsky.social');
    expect(byDid.get('did:plc:user1')!.bookCountDiscovered).toBe(2);
    expect(byDid.get('did:plc:user2')!.bookCountDiscovered).toBe(1);
  });

  it('seeds the catalog repo as a user from its own buzz.bookhive.book records', async () => {
    const enumerator = new BookhiveActivityEnumerator(db, {
      catalogDid: CATALOG_DID,
      listActivity: async () => ({ records: [], cursor: undefined }),
      listCatalogBooks: async () => ({
        records: [
          catalogBookRecord('bk_AAA', 'Dune', 'Frank Herbert'),
          catalogBookRecord('bk_BBB', 'Vanguard', 'Matt Fitton'),
        ],
        cursor: undefined,
      }),
    });

    const result = await enumerator.enumerate();
    expect(result.discovered).toBe(1);

    const rows = db.select().from(schema.bookhiveUserDiscovery).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].did).toBe(CATALOG_DID);
    expect(rows[0].bookCountDiscovered).toBe(2);
  });

  it('is idempotent across repeated runs', async () => {
    const enumerator = new BookhiveActivityEnumerator(db, {
      catalogDid: CATALOG_DID,
      listActivity: async () => ({
        records: [activityRecord('did:plc:user1', 'user1.bsky.social', 'bk_AAA')],
        cursor: undefined,
      }),
      listCatalogBooks: async () => ({ records: [], cursor: undefined }),
    });

    await enumerator.enumerate();
    await enumerator.enumerate();
    await enumerator.enumerate();

    const rows = db.select().from(schema.bookhiveUserDiscovery).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].bookCountDiscovered).toBe(1);
  });

  it('marks an unreachable feed as an error on the row', async () => {
    const enumerator = new BookhiveActivityEnumerator(db, {
      catalogDid: CATALOG_DID,
      listActivity: async () => {
        throw new Error('502 Bad Gateway');
      },
      listCatalogBooks: async () => ({ records: [], cursor: undefined }),
    });

    await expect(enumerator.enumerate()).rejects.toThrow(/502/);
  });
});
