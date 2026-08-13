import { describe, it, expect } from 'vitest';
import { cidForRecord, DAG_CBOR_CODEC } from './cid.js';

describe('cidForRecord', () => {
  it('returns a CIDv1 with the dag-cbor codec', () => {
    expect(DAG_CBOR_CODEC).toBe(0x71);
  });

  it('produces a base32-encoded CIDv1 string starting with "b"', async () => {
    const cid = await cidForRecord({ $type: 'app.bsky.feed.post', text: 'hi' });
    expect(cid).toMatch(/^b[a-z2-7]+$/);
  });

  it('is deterministic — same value produces the same CID', async () => {
    const value = { $type: 'app.bsky.feed.post', text: 'hi', createdAt: '2025-01-01T00:00:00Z' };
    const a = await cidForRecord(value);
    const b = await cidForRecord(value);
    expect(a).toBe(b);
  });

  it('produces different CIDs for different values', async () => {
    const a = await cidForRecord({ $type: 'x', n: 1 });
    const b = await cidForRecord({ $type: 'x', n: 2 });
    expect(a).not.toBe(b);
  });

  it('produces the same CID regardless of property insertion order', async () => {
    const a = await cidForRecord({ $type: 'x', a: 1, b: 2, c: 3 });
    const b = await cidForRecord({ c: 3, b: 2, a: 1, $type: 'x' });
    expect(a).toBe(b);
  });

  it('hashes nested structures consistently', async () => {
    const value = {
      $type: 'community.lexicon.book.book',
      title: 'Foo',
      author: 'Bar',
      contributors: [
        { contributor: { uri: 'at://did:web:x/community.lexicon.book.contributor/r', cid: 'bafyrei-z' }, order: 0 },
      ],
    };
    const cid = await cidForRecord(value);
    expect(cid).toMatch(/^b[a-z2-7]+$/);
    expect(cid).toBe(await cidForRecord(value));
  });
});