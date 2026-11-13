/**
 * Project Gutenberg provider: public-domain ebooks, no key and no third-party
 * mirror.
 *
 * Two catalogue surfaces, both served by gutenberg.org itself:
 *
 * - `/cache/epub/<id>/pg<id>.rdf` is one ebook's Dublin Core metadata: title,
 *   creator agents (inverted names, with the Wikipedia page), language,
 *   subjects, the generated summary, and the format list that names the cover.
 * - `/ebooks/search.opds/?sort_order=downloads` is an OPDS catalogue page, 25
 *   most-downloaded ebooks at a time, with a `rel="next"` link.
 *
 * The RDF is authoritative and is the only thing a candidate is built from;
 * OPDS exists here to discover ids (the "seed the catalogue" path).
 *
 * A Gutenberg copy is its own edition: identity is the ebook id
 * (`gutenberg:<id>`). These texts predate the ISBN system, so an ISBN is never
 * invented for them — mapping one onto a modern reprint would merge two
 * different objects.
 */

import { createGate, cleanString, stripHtml } from '../util.js';
import { DEFAULT_CONTRIBUTOR_ROLE } from '../contributor-roles.js';
import { parseIsbndbAuthor } from '../isbndb-names.js';
import { fetchText } from './http.js';

export const GUTENBERG_BASE_URL = 'https://www.gutenberg.org';
/** Gutenberg pages the catalogue at 25 entries; the seeder walks pages. */
export const OPDS_PAGE_SIZE = 25;
/** `dcterms:language` carries RFC 4646 tags; only keep the shape we can use. */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i;
/** Gutenberg asks crawlers to stay polite: one request at a time, 500 ms apart. */
const gate = createGate(500);
const USER_AGENT =
  'Bibliograph/0.2 (+https://biblio.livtet.olamaelcu.net; Project Gutenberg provider)';
const MAX_DESCRIPTION_LENGTH = 1500;
const IDENTIFIER_ISSUER = 'gutenberg';

/** The ebook id in any spelling Gutenberg uses: `1342`, `/ebooks/1342.opds`, a cache path. */
export function gutenbergEbookId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  const text = cleanString(typeof value === 'string' ? value : undefined);
  if (!text) return undefined;
  const direct = text.match(/^(\d+)$/);
  if (direct) return direct[1];
  // `1342`, `ebooks/1342`, `/ebooks/1342.opds`, `https://…/cache/epub/1342/pg1342.rdf`:
  // the id is always the digits after the `ebooks`/`epub` segment.
  const path = text.match(/(?:^|\/)(?:ebooks|epub)\/(\d+)/);
  return path ? path[1] : undefined;
}

/**
 * The ebook id this RDF describes.
 *
 * The document's own `rdf:about="ebooks/1342"` is the primary spelling; the
 * cover filename and the `isFormatOf` references repeat it, so a document
 * missing the root attribute still resolves.
 */
function ebookIdFromRdf(xml) {
  const root = xml.match(/<pgterms:ebook\b[^>]*rdf:about="([^"]+)"/);
  return gutenbergEbookId(root?.[1] ?? '');
}

/** The inner text of the first `<name>` element, entity-decoded. */
function element(xml, name) {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? match[1] : undefined;
}

/** Every `<name>` block, in document order. */
function elements(xml, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'g');
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

/** Credit each `dcterms:creator` agent as an author. */
function creators(xml) {
  const contributors = [];
  for (const block of elements(xml, 'dcterms:creator')) {
    const name = stripHtml(element(block, 'pgterms:name'));
    if (!name) continue;
    // Gutenberg writes agents inverted ("Austen, Jane"), the same shape ISBNdb
    // uses, so the shared parser decides when the inversion is unambiguous.
    const parsed = parseIsbndbAuthor(name);
    contributors.push(
      parsed
        ? {
            name: parsed.name,
            nameInverted: parsed.nameInverted,
            role: DEFAULT_CONTRIBUTOR_ROLE
          }
        : { name, role: DEFAULT_CONTRIBUTOR_ROLE }
    );
  }
  return contributors;
}

/** The ebook's language tag, when the RDF states one. */
function language(xml) {
  for (const block of elements(xml, 'dcterms:language')) {
    const value = stripHtml(element(block, 'rdf:value'));
    if (value && LANGUAGE_TAG.test(value)) return value.toLowerCase();
  }
  return undefined;
}

/**
 * A readable description.
 *
 * `pgterms:marc520` is a prose summary, which is what a shelf card wants; the
 * `dcterms:description` entries are catalogue notes ("Wikipedia page about this
 * book: …", "also available as eBook #42671"), so they are the fallback only.
 */
function description(xml) {
  const summary = stripHtml(element(xml, 'pgterms:marc520'));
  const fallback = elements(xml, 'dcterms:description')
    .map((block) => stripHtml(block))
    .find((text) => text !== undefined);
  const text = summary ?? fallback;
  if (!text) return undefined;
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()}…`
    : text;
}

/** The medium cover URL Gutenberg emits beside the ebook's other formats. */
function coverImage(xml) {
  const files = [...xml.matchAll(/<pgterms:file\b[^>]*rdf:about="([^"]+)"[^>]*>([\s\S]*?)<\/pgterms:file>/g)];
  const jpegs = files
    .filter((match) => match[2].includes('image/jpeg'))
    .map((match) => match[1]);
  return (
    jpegs.find((url) => url.endsWith('cover.medium.jpg')) ??
    jpegs.find((url) => url.endsWith('.jpg'))
  );
}

/**
 * One `dcterms:creator`-backed candidate from an ebook's RDF.
 *
 * `dcterms:issued` is deliberately dropped: it is the date Gutenberg published
 * *this file* (1998 for an 1813 novel), and claiming it as the edition's
 * publication date would be a lie a reader can see.
 */
export function candidateFromRdf(xml) {
  if (typeof xml !== 'string' || xml === '') return undefined;
  const title = stripHtml(element(xml, 'dcterms:title'));
  const id = ebookIdFromRdf(xml);
  if (!title || !id) return undefined;

  const candidate = {
    identifiers: [{ issuer: IDENTIFIER_ISSUER, value: id }],
    title,
    contributors: creators(xml),
    // A Gutenberg release is an ebook, whatever formats it also ships.
    format: 'ebook'
  };

  const subtitle = stripHtml(element(xml, 'dcterms:alternative'));
  if (subtitle) candidate.subtitle = subtitle;
  const lang = language(xml);
  if (lang) candidate.language = lang;
  const text = description(xml);
  if (text) candidate.description = text;
  const cover = coverImage(xml);
  if (cover) candidate.coverUrl = cover;
  const publisher = stripHtml(element(xml, 'dcterms:publisher'));
  if (publisher) candidate.publisher = { name: publisher };

  return candidate;
}

/** The ebook ids an OPDS catalogue page lists, in its own order. */
export function gutenbergIdsFromOpds(xml) {
  if (typeof xml !== 'string' || xml === '') return [];
  const ids = [];
  for (const entry of elements(xml, 'entry')) {
    const id = gutenbergEbookId(stripHtml(element(entry, 'id')));
    if (id) ids.push(id);
  }
  return ids;
}

/** The `rel="next"` path of an OPDS page, so the seeder can walk it. */
function nextOpdsPath(xml) {
  const link = xml.match(/<link\b[^>]*rel="next"[^>]*href="([^"]+)"/);
  if (!link) return undefined;
  return link[1].replace(/&amp;/g, '&');
}

export function createGutenberg({
  baseUrl = GUTENBERG_BASE_URL,
  fetchImpl = fetch
} = {}) {
  const root = baseUrl.replace(/\/+$/, '');

  async function get(path) {
    const page = await gate(() =>
      fetchText(fetchImpl, `${root}${path}`, {
        headers: { 'user-agent': USER_AGENT }
      })
    );
    return page?.text;
  }

  /** One ebook's RDF document, or undefined when it does not exist. */
  async function rdf(id) {
    const ebook = gutenbergEbookId(id);
    if (!ebook) return undefined;
    return get(`/cache/epub/${ebook}/pg${ebook}.rdf`);
  }

  return {
    /**
     * The candidate for one ebook id, in the shape `createIngest` consumes.
     * An unknown id answers `[]`: Gutenberg 404s, and "no such ebook" is a
     * normal provider answer.
     */
    async byId(id) {
      const xml = await rdf(id);
      const candidate = xml ? candidateFromRdf(xml) : undefined;
      return candidate ? [candidate] : [];
    },

    /**
     * Ebook ids to seed from, most-downloaded first.
     *
     * Gutenberg pages the list at 25, so this walks `rel="next"` until it has
     * `limit` ids or the catalogue ends. Ids, not candidates: the seeder reads
     * each ebook's RDF so one failure cannot cost the whole page.
     */
    async popular({ limit = OPDS_PAGE_SIZE, startIndex = 1 } = {}) {
      const wanted = Math.max(1, Number(limit) || OPDS_PAGE_SIZE);
      const ids = [];
      const seen = new Set();
      let path = `/ebooks/search.opds/?sort_order=downloads&start_index=${Math.max(1, Number(startIndex) || 1)}`;
      for (let page = 0; path && page < 40 && ids.length < wanted; page += 1) {
        const xml = await get(path);
        if (!xml) break;
        for (const id of gutenbergIdsFromOpds(xml)) {
          if (seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
        }
        path = nextOpdsPath(xml);
      }
      return ids.slice(0, wanted);
    }
  };
}
