import test from "node:test";
import assert from "node:assert/strict";
import { editionRecordCid, editionRecordValue } from "./edition-record";
import type { EditionRow } from "./db/schema";
import type { Identifier } from "./identifiers";

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
    contributors: [],
    pages: 200,
    identifiers: [{ type: "isbn", value: "9780306406157" }],
    publishedYear: 2020,
    language: "en",
  });
  assert.ok(value);
  assert.equal(value.pages, 200);
  assert.deepEqual(value.identifiers, [
    { type: "isbn", value: "9780306406157" },
  ]);
  assert.equal(value.publishedDate, "2020");
  assert.equal(value.language, "en");
});

test("a record metadata change moves the CID", async () => {
  const identifiers: Identifier[] = [{ type: "isbn", value: "9780306406157" }];
  const before = await editionRecordCid(row, { contributors: [], identifiers });
  const after = await editionRecordCid(row, {
    contributors: [],
    pages: 200,
    identifiers,
    publishedYear: 2020,
    language: "en",
  });
  assert.ok(before);
  assert.ok(after);
  assert.notEqual(before, after);
});

test("a provider's 'no cover' placeholder never reaches coverUrl", () => {
  const placeholder =
    "https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/nophoto/book/111x148.png";
  const identifiers: Identifier[] = [{ type: "isbn", value: "9780306406157" }];
  const stored = editionRecordValue(
    { ...row, coverImageUrl: placeholder },
    { contributors: [], identifiers },
  );
  const overridden = editionRecordValue(row, {
    contributors: [],
    identifiers,
    coverUrl: placeholder,
  });
  assert.ok(stored);
  assert.ok(overridden);
  assert.equal(stored.coverUrl, undefined);
  assert.equal(overridden.coverUrl, undefined);
});

test("a real cover still becomes coverUrl", () => {
  const value = editionRecordValue(
    { ...row, coverImageUrl: "https://example.test/c.jpg" },
    { contributors: [], identifiers: [{ type: "isbn", value: "9780306406157" }] },
  );
  assert.ok(value);
  assert.equal(value.coverUrl, "https://example.test/c.jpg");
});
