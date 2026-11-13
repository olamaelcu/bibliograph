import test from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateFromRdf,
  createGutenberg,
  gutenbergEbookId,
  gutenbergIdsFromOpds
} from '../lib/providers/gutenberg.js';
import { seedCatalogFromProvider } from '../lib/seed.js';

/** The shape gutenberg.org serves at /cache/epub/1342/pg1342.rdf, trimmed. */
const RDF = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xml:base="http://www.gutenberg.org/"
  xmlns:pgterms="http://www.gutenberg.org/2009/pgterms/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns:dcam="http://purl.org/dc/dcam/">
  <pgterms:ebook rdf:about="ebooks/1342">
    <dcterms:publisher>Project Gutenberg</dcterms:publisher>
    <dcterms:issued rdf:datatype="http://www.w3.org/2001/XMLSchema#date">1998-06-01</dcterms:issued>
    <pgterms:downloads rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">208430</pgterms:downloads>
    <dcterms:creator>
      <pgterms:agent rdf:about="2009/agents/68">
        <pgterms:name>Austen, Jane</pgterms:name>
        <pgterms:deathdate rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">1817</pgterms:deathdate>
      </pgterms:agent>
    </dcterms:creator>
    <dcterms:title>Pride and Prejudice</dcterms:title>
    <dcterms:description>Wikipedia page about this book: https://en.wikipedia.org/wiki/Pride_and_Prejudice</dcterms:description>
    <pgterms:marc520>A novel of manners &amp; marriage in Regency England.</pgterms:marc520>
    <dcterms:language>
      <rdf:Description rdf:nodeID="N1">
        <rdf:value rdf:datatype="http://purl.org/dc/terms/RFC4646">en</rdf:value>
      </rdf:Description>
    </dcterms:language>
    <dcterms:subject>
      <rdf:Description rdf:nodeID="N2">
        <dcam:memberOf rdf:resource="http://purl.org/dc/terms/LCSH"/>
        <rdf:value>England -- Fiction</rdf:value>
      </rdf:Description>
    </dcterms:subject>
    <dcterms:hasFormat>
      <pgterms:file rdf:about="https://www.gutenberg.org/ebooks/1342.html.images">
        <dcterms:format>
          <rdf:Description rdf:nodeID="N3">
            <rdf:value rdf:datatype="http://purl.org/dc/terms/IMT">text/html</rdf:value>
          </rdf:Description>
        </dcterms:format>
      </pgterms:file>
    </dcterms:hasFormat>
    <dcterms:hasFormat>
      <pgterms:file rdf:about="https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg">
        <dcterms:format>
          <rdf:Description rdf:nodeID="N4">
            <rdf:value rdf:datatype="http://purl.org/dc/terms/IMT">image/jpeg</rdf:value>
          </rdf:Description>
        </dcterms:format>
      </pgterms:file>
    </dcterms:hasFormat>
  </pgterms:ebook>
</rdf:RDF>`;

/** The shape gutenberg.org serves at /ebooks/search.opds/, trimmed to two entries. */
const OPDS = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
<id>http://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads</id>
<link rel="next" title="Next Page" href="/ebooks/search.opds/?sort_order=downloads&amp;start_index=3"/>
<entry>
<id>https://www.gutenberg.org/ebooks/1342.opds</id>
<title>Pride and Prejudice</title>
<content type="text">Austen, Jane</content>
</entry>
<entry>
<id>https://www.gutenberg.org/ebooks/84.opds</id>
<title>Frankenstein; Or, The Modern Prometheus</title>
<content type="text">Shelley, Mary Wollstonecraft</content>
</entry>
</feed>`;

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: new Headers(),
    text: async () => body
  };
}

test('gutenbergEbookId accepts every spelling the catalogue uses', () => {
  assert.equal(gutenbergEbookId(1342), '1342');
  assert.equal(gutenbergEbookId('1342'), '1342');
  assert.equal(gutenbergEbookId('ebooks/1342'), '1342');
  assert.equal(gutenbergEbookId('/ebooks/1342.opds'), '1342');
  assert.equal(gutenbergEbookId('https://www.gutenberg.org/ebooks/1342'), '1342');
  assert.equal(gutenbergEbookId('https://www.gutenberg.org/cache/epub/1342/pg1342.rdf'), '1342');
  assert.equal(gutenbergEbookId(''), undefined);
  assert.equal(gutenbergEbookId('not-a-book'), undefined);
  assert.equal(gutenbergEbookId(0), undefined);
});

test('candidateFromRdf maps the Dublin Core record onto the ingest shape', () => {
  const candidate = candidateFromRdf(RDF);
  assert.deepEqual(candidate.identifiers, [{ issuer: 'gutenberg', value: '1342' }]);
  assert.equal(candidate.title, 'Pride and Prejudice');
  assert.equal(candidate.format, 'ebook');
  assert.equal(candidate.language, 'en');
  assert.equal(candidate.coverUrl, 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg');
  assert.deepEqual(candidate.publisher, { name: 'Project Gutenberg' });
  // The summary wins over the catalogue note, and entities are decoded.
  assert.equal(candidate.description, 'A novel of manners & marriage in Regency England.');
});

test('candidateFromRdf keeps the inverted author name next to the display name', () => {
  const [contributor] = candidateFromRdf(RDF).contributors;
  assert.deepEqual(contributor, { name: 'Jane Austen', nameInverted: 'Austen, Jane', role: 'A01' });
});

test('candidateFromRdf does not claim the Gutenberg release date as publication', () => {
  // `dcterms:issued` is when Gutenberg posted the file (1998), not when the
  // edition was published; a reader must not be told Pride and Prejudice is
  // from 1998.
  assert.equal(candidateFromRdf(RDF).publishedDate, undefined);
});

test('candidateFromRdf rejects a document without a title or an id', () => {
  assert.equal(candidateFromRdf(''), undefined);
  assert.equal(candidateFromRdf('<rdf:RDF></rdf:RDF>'), undefined);
  assert.equal(
    candidateFromRdf(
      '<pgterms:ebook rdf:about="ebooks/1"><dcterms:title>Untitled</dcterms:title></pgterms:ebook>'
    ).title,
    'Untitled'
  );
});

test('gutenbergIdsFromOpds lists the ids in catalogue order', () => {
  assert.deepEqual(gutenbergIdsFromOpds(OPDS), ['1342', '84']);
  assert.deepEqual(gutenbergIdsFromOpds(''), []);
});

test('byId reads the ebook RDF and builds one candidate', async () => {
  const urls = [];
  const provider = createGutenberg({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return response(RDF);
    }
  });

  const [candidate] = await provider.byId('1342');

  assert.deepEqual(urls, ['https://www.gutenberg.org/cache/epub/1342/pg1342.rdf']);
  assert.equal(candidate.title, 'Pride and Prejudice');
});

test('byId answers empty for an ebook that does not exist', async () => {
  const provider = createGutenberg({ fetchImpl: async () => response('', 404) });
  assert.deepEqual(await provider.byId('999999999'), []);
});

test('popular walks the next link until it has enough ids', async () => {
  const urls = [];
  const provider = createGutenberg({
    fetchImpl: async (url) => {
      urls.push(String(url));
      const page = String(url).includes('start_index=3')
        ? OPDS.replace(
            /<link rel="next"[^>]*\/>/,
            ''
          ).replace('ebooks/1342.opds', 'ebooks/31.opds').replace('1342', '31')
        : OPDS;
      return response(page);
    }
  });

  const ids = await provider.popular({ limit: 4 });

  assert.deepEqual(ids, ['1342', '84', '31']);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/ebooks\/search\.opds\/\?sort_order=downloads/);
  assert.match(urls[1], /start_index=3/);
});

test('seeding ingests every listed id and reports what it did', async () => {
  const ingested = [];
  const summary = await seedCatalogFromProvider({
    provider: {
      popular: async ({ limit }) => ['1342', '84', '31'].slice(0, limit),
      byId: async (id) =>
        id === '31' ? [] : [{ identifiers: [{ issuer: 'gutenberg', value: id }], title: `T${id}` }]
    },
    ingest: async (candidate) => {
      ingested.push(candidate.identifiers[0].value);
      return { uri: `at://did:plc:p/community.lexicon.media.book.edition/${candidate.identifiers[0].value}`, created: candidate.identifiers[0].value !== '84' };
    },
    count: 3,
    logger: { warn() {} }
  });

  assert.deepEqual(ingested, ['1342', '84']);
  assert.deepEqual(summary, {
    requested: 3,
    listed: 3,
    created: 1,
    updated: 1,
    skipped: 1,
    failed: 0,
    uris: [
      'at://did:plc:p/community.lexicon.media.book.edition/1342',
      'at://did:plc:p/community.lexicon.media.book.edition/84'
    ]
  });
});

test('seeding counts a failed record and keeps going', async () => {
  const warnings = [];
  const summary = await seedCatalogFromProvider({
    provider: {
      popular: async () => ['1', '2'],
      byId: async (id) => {
        if (id === '1') throw new Error('upstream 500');
        return [{ identifiers: [{ issuer: 'gutenberg', value: id }], title: `T${id}` }];
      }
    },
    ingest: async () => ({ uri: 'at://x/1', created: true }),
    count: 2,
    logger: { warn: (message) => warnings.push(message) }
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.created, 1);
  assert.match(warnings[0], /seed 1 failed — upstream 500/);
});

test('seeding refuses a count that cannot be a page size', async () => {
  await assert.rejects(
    () => seedCatalogFromProvider({ provider: { popular: async () => [], byId: async () => [] }, ingest: async () => {}, count: 0 }),
    /count must be a positive integer/
  );
  await assert.rejects(() => seedCatalogFromProvider({ ingest: async () => {} }), /popular\(\) and byId\(\)/);
  await assert.rejects(() => seedCatalogFromProvider({ provider: { popular: async () => [], byId: async () => [] } }), /ingest\(\)/);
});
