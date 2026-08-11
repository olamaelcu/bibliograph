import { describe, it, expect } from 'vitest';
import { BookhiveStreamer, type BookhiveRecord, type ListRecordsFn } from './streamer.js';

const SAMPLE: BookhiveRecord[] = [
  { uri: 'at://did:plc:x/buzz.bookhive.catalogBook/rkey-a', rkey: 'rkey-a', record: { id: 'A' } },
  { uri: 'at://did:plc:x/buzz.bookhive.catalogBook/rkey-b', rkey: 'rkey-b', record: { id: 'B' } },
  { uri: 'at://did:plc:x/buzz.bookhive.catalogBook/rkey-c', rkey: 'rkey-c', record: { id: 'C' } },
];

describe('BookhiveStreamer', () => {
  it('emits every record across pages until cursor=null', async () => {
    const listRecords: ListRecordsFn = async (opts) => {
      const all = [...SAMPLE];
      const start = opts.cursor ? all.findIndex((r) => r.rkey === opts.cursor) + 1 : 0;
      const page = all.slice(start, start + 2);
      const nextCursor = start + 2 < all.length ? page[page.length - 1].rkey : undefined;
      return {
        records: page.map((r) => ({ uri: r.uri, cid: 'cid-' + r.rkey, value: r.record as Record<string, unknown> })),
        cursor: nextCursor,
      };
    };

    const streamer = new BookhiveStreamer({
      pdsUrl: 'https://bookhive.buzz',
      repoDid: 'did:plc:enu2j5xjlqsjaylv3du4myh4',
      collection: 'buzz.bookhive.catalogBook',
      pageSize: 2,
      listRecords,
    });

    const out: BookhiveRecord[] = [];
    for await (const item of streamer.iter()) {
      out.push(item);
    }
    expect(out).toEqual(SAMPLE);
  });

  it('respects the resumeCursor passed to iter()', async () => {
    let calls = 0;
    const listRecords: ListRecordsFn = async (opts) => {
      calls++;
      if (calls === 1) {
        expect(opts.cursor).toBe('resume-here');
        return {
          records: [
            {
              uri: 'at://did:plc:x/buzz.bookhive.catalogBook/rkey-b',
              cid: 'cid-b',
              value: { id: 'B' },
            },
          ],
          cursor: undefined,
        };
      }
      throw new Error('should have only one call when cursor is undefined');
    };

    const streamer = new BookhiveStreamer({
      pdsUrl: 'https://bookhive.buzz',
      repoDid: 'did:plc:enu2j5xjlqsjaylv3du4myh4',
      collection: 'buzz.bookhive.catalogBook',
      pageSize: 10,
      listRecords,
    });

    const out: BookhiveRecord[] = [];
    for await (const item of streamer.iter({ resumeCursor: 'resume-here' })) {
      out.push(item);
    }
    expect(out).toEqual([
      {
        uri: 'at://did:plc:x/buzz.bookhive.catalogBook/rkey-b',
        rkey: 'rkey-b',
        record: { id: 'B' },
      },
    ]);
  });

  it('throws on transient HTTP failure', async () => {
    const listRecords: ListRecordsFn = async () => {
      throw new Error('502 Bad Gateway');
    };
    const streamer = new BookhiveStreamer({
      pdsUrl: 'https://bookhive.buzz',
      repoDid: 'did:plc:enu2j5xjlqsjaylv3du4myh4',
      collection: 'buzz.bookhive.catalogBook',
      pageSize: 10,
      listRecords,
    });

    await expect(async () => {
      for await (const _ of streamer.iter()) {
        // empty
      }
    }).rejects.toThrow(/502/);
  });
});
