import test from "node:test";
import assert from "node:assert/strict";
import { editionRecordCid, editionRecordValue } from "./edition-record";
import type { EditionRow } from "./db/schema";

const row = {
  uri: "at://did:plc:test/community.lexicon.book.edition/1",
  cid: "bafyold",
  did: "did:plc:test",
  rkey: "gb.1",
  tid: "234567890abcdef",
  title: "A Book",
  subtitle: null,
  workUri: null,
  workCid: null,
  workLinkSource: null,
  publisherUri: null,
  publisherCid: null,
  place: null,
  publishedYear: null,
  language: null,
  contributors: [],
  identifiers: [],
  description: null,
  coverImageUrl: null,
  format: null,
  pages: null,
  createdAt: new Date("2020-01-01T00:00:00.000Z"),
  descriptionCheckedAt: null,
  indexedAt: new Date("2020-01-01T00:00:00.000Z"),
} satisfies EditionRow;

test("record overrides replace the stored values the CID covers", () => {
  const value = editionRecordValue(row, {
    pages: 200,
    identifiers: [{ uri: "isbn:9780306406157", resource: "isbn13" }],
    publishedYear: 2020,
    language: "en",
  });
  assert.equal(value.pages, 200);
  assert.deepEqual(value.identifiers, [
    { uri: "isbn:9780306406157", resource: "isbn13" },
  ]);
  assert.equal(value.publishedYear, 2020);
  assert.equal(value.language, "en");
});

test("a record metadata change moves the CID", async () => {
  const before = await editionRecordCid(row);
  const after = await editionRecordCid(row, {
    pages: 200,
    identifiers: [{ uri: "isbn:9780306406157", resource: "isbn13" }],
    publishedYear: 2020,
    language: "en",
  });
  assert.notEqual(before, after);
});
