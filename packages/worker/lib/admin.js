/**
 * Authenticated loopback admin API for catalog curation.
 *
 * The public edge never talks to the providers directly: it proxies here with
 * the operator token. The API is deliberately small (provider search + ingest)
 * and bound to 127.0.0.1 by default. When ADMIN_TOKEN is unset the server is
 * not started at all, so a deployment without an operator token has no write
 * surface.
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createIngest } from './ingest.js';
import { FormatResolveError, normalizeFormatIsbns, resolveFormat } from './resolve-format.js';
import { DEFAULT_CONTRIBUTOR_ROLE, normalizeContributorRole } from './contributor-roles.js';
import { cleanString, isbn13 as normalizeIsbn13 } from './util.js';
import { openLibraryBookKey } from './providers/openlibrary.js';

export const DEFAULT_ADMIN_HOST = '127.0.0.1';
export const DEFAULT_ADMIN_PORT = 9465;
const MAX_BODY_BYTES = 1024 * 1024;
const PROVIDERS = new Set(['googlebooks', 'isbndb', 'openlibrary', 'goodreads']);
// Publisher name length is shared by search and import so a name that previews
// can always be imported; ISBNdb publisher names are short in practice.
const PUBLISHER_NAME_MAX = 150;
const PUBLISHER_SEARCH_PAGE_SIZE = 50;
const PUBLISHER_PAGE_SIZE_MAX = 100;
const PUBLISHER_IMPORT_PAGE_SIZE_DEFAULT = 100;
const PUBLISHER_IMPORT_MAX_PAGES = 5;
// OpenLibrary author search is unbounded text; keep an operator query small
// enough to be cheap upstream and a bounded page of results for the UI.
const CONTRIBUTOR_QUERY_MAX = 200;
const CONTRIBUTOR_LIMIT_DEFAULT = 20;
const CONTRIBUTOR_LIMIT_MAX = 50;
// ISBNdb accepts YYYY, YYYY-MM and YYYY-MM-DD; zero padding makes a plain
// string comparison the correct range check.
const DATE_FILTER = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

const STRING_FIELDS = [
  'title',
  'subtitle',
  'language',
  'publishedDate',
  'format',
  'bookEdition',
  'description',
  'coverUrl'
];
const INTEGER_FIELDS = ['pages', 'durationSeconds', 'chapters'];

export class AdminRequestError extends Error {
  constructor(status, message, code = 'BadRequest') {
    super(message);
    this.name = 'AdminRequestError';
    this.status = status;
    this.code = code;
  }
}

/** Parse and validate the admin listener configuration. */
export function resolveAdminConfig(env = process.env) {
  const token = cleanString(env.ADMIN_TOKEN);
  const host = cleanString(env.WORKER_ADMIN_HOST) ?? DEFAULT_ADMIN_HOST;
  const rawPort = cleanString(env.WORKER_ADMIN_PORT);
  const port = rawPort === undefined ? DEFAULT_ADMIN_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`WORKER_ADMIN_PORT=${JSON.stringify(rawPort)} is not a valid TCP port`);
  }
  return { token, host, port, enabled: Boolean(token) };
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time bearer-token comparison; never compares raw lengths. */
export function authorized(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string' || token === '') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}

function stringValue(value) {
  if (typeof value === 'string') return cleanString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return undefined;
}

function identifierList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const identifiers = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const issuer = stringValue(entry.issuer);
    const rawValue = stringValue(entry.value);
    if (!issuer || !rawValue) continue;
    const key = `${issuer}\u0000${rawValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push({ issuer, value: rawValue });
  }
  return identifiers;
}

function contributorList(value) {
  if (!Array.isArray(value)) return [];
  const contributors = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    // Lexicon-shaped input uses `displayName`; the admin UI round-trips the
    // internal candidate shape and uses `name`.
    const name = stringValue(entry.displayName) ?? stringValue(entry.name);
    if (!name) continue;
    const contributor = {
      name,
      role: normalizeContributorRole(entry.role ?? DEFAULT_CONTRIBUTOR_ROLE)
    };
    // Provider metadata: the admin UI round-trips an ISBNdb candidate, and
    // dropping this field here would lose the inverted name at import time.
    // It is not identity, so it never influences dedupe.
    const nameInverted = stringValue(entry.nameInverted);
    if (nameInverted) contributor.nameInverted = nameInverted;
    const identifiers = identifierList(entry.identifiers);
    if (identifiers.length > 0) contributor.identifiers = identifiers;
    const ref = stringValue(entry.ref);
    if (ref) contributor.ref = ref;
    contributors.push(contributor);
  }
  return contributors;
}

function publisherValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = stringValue(value.name);
  if (!name) return undefined;
  const identifiers = identifierList(value.identifiers);
  return identifiers.length > 0 ? { name, identifiers } : { name };
}

function seriesValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = stringValue(value.name);
  if (!name) return undefined;
  const series = { name };
  const position = stringValue(value.position);
  if (position) series.position = position;
  const display = stringValue(value.display);
  if (display) series.display = display;
  return series;
}

function integerValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Normalize a provider candidate from a browser-supplied body.
 *
 * The admin UI round-trips candidates, so every value is untrusted. Required
 * identity (a title and at least one identifier) is enforced here as well as in
 * the provider parsers, and strings/numeric fields are coerced rather than
 * passed through as arbitrary JSON.
 */
export function normalizeCandidate(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AdminRequestError(400, 'candidate must be an object');
  }
  const title = stringValue(input.title);
  if (!title) throw new AdminRequestError(400, 'candidate.title is required');
  const identifiers = identifierList(input.identifiers);
  if (identifiers.length === 0) {
    throw new AdminRequestError(400, 'candidate.identifiers must contain at least one identifier');
  }

  const candidate = { title, identifiers };
  for (const field of STRING_FIELDS) {
    if (field === 'title') continue;
    const value = stringValue(input[field]);
    if (value !== undefined) candidate[field] = value;
  }
  for (const field of INTEGER_FIELDS) {
    const value = integerValue(input[field]);
    if (value !== undefined) candidate[field] = value;
  }

  const series = seriesValue(input.series);
  if (series) candidate.series = series;

  const contributors = contributorList(input.contributors);
  if (contributors.length > 0) candidate.contributors = contributors;

  const publisher = publisherValue(input.publisher);
  if (publisher) candidate.publisher = publisher;

  return candidate;
}

/** Pick one provider for an operator search, by ISBN when the query is one. */
export async function searchProvider(providers, provider, query) {
  if (!PROVIDERS.has(provider)) {
    throw new AdminRequestError(
      400,
      'provider must be one of googlebooks, isbndb, openlibrary or goodreads'
    );
  }
  const text = cleanString(query);
  if (!text) throw new AdminRequestError(400, 'query is required');
  const isbn = normalizeIsbn13(text);

  if (provider === 'googlebooks') {
    return isbn
      ? providers.providers.google.byIsbn(isbn)
      : providers.providers.google.search({ q: text });
  }
  if (provider === 'isbndb') {
    const isbndb = isbndbOr503(providers);
    return isbn ? isbndb.byIsbn(isbn) : isbndb.search(text);
  }
  if (provider === 'openlibrary') {
    const openlibrary = providers.providers.openlibrary;
    if (isbn) return openlibrary.byIsbn(isbn);
    if (openLibraryBookKey(text)) return openlibrary.byIdentifier(text);
    return openlibrary.search({ q: text });
  }
  return isbn
    ? providers.providers.goodreads.byIdentifier(isbn)
    : providers.providers.goodreads.search(text);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new AdminRequestError(413, 'request body is too large');
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new AdminRequestError(400, 'request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AdminRequestError(400, 'request body must be valid JSON');
  }
}

function objectBody(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminRequestError(400, 'request body must be an object');
  }
  return value;
}

function isbndbOr503(providers) {
  const isbndb = providers.providers.isbndb;
  if (!isbndb) {
    throw new AdminRequestError(
      503,
      'ISBNdb is not configured (ISBNDB_API_KEY is unset)',
      'ProviderNotConfigured'
    );
  }
  return isbndb;
}

function isbndbQuotaError() {
  return new AdminRequestError(
    503,
    'ISBNdb daily quota exhausted; it resets at 00:00 UTC',
    'ProviderQuotaExhausted'
  );
}

function publisherQueryInput(body) {
  const query = stringValue(body.query);
  if (!query) throw new AdminRequestError(400, 'query is required');
  if (query.length > PUBLISHER_NAME_MAX) {
    throw new AdminRequestError(400, `query must be at most ${PUBLISHER_NAME_MAX} characters`);
  }
  return query;
}

function contributorQueryInput(body) {
  const query = stringValue(body.q);
  if (!query) throw new AdminRequestError(400, 'q is required');
  if (query.length > CONTRIBUTOR_QUERY_MAX) {
    throw new AdminRequestError(400, `q must be at most ${CONTRIBUTOR_QUERY_MAX} characters`);
  }
  return query;
}

function publisherNameInput(body) {
  const name = stringValue(body.name);
  if (!name) throw new AdminRequestError(400, 'name is required');
  if (name.length > PUBLISHER_NAME_MAX) {
    throw new AdminRequestError(400, `name must be at most ${PUBLISHER_NAME_MAX} characters`);
  }
  return name;
}

function positivePage(value) {
  if (value === undefined || value === null || value === '') return 1;
  const page = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(page) || page < 1) {
    throw new AdminRequestError(400, 'page must be a positive integer');
  }
  return page;
}

function boundedInteger(value, name, { fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AdminRequestError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function optionalDate(value, name) {
  const text = stringValue(value);
  if (text === undefined) return undefined;
  if (!DATE_FILTER.test(text)) {
    throw new AdminRequestError(400, `${name} must be YYYY, YYYY-MM or YYYY-MM-DD`);
  }
  return text;
}

function publisherFilters(body) {
  const publishedFrom = optionalDate(body.publishedFrom, 'publishedFrom');
  const publishedTo = optionalDate(body.publishedTo, 'publishedTo');
  if (publishedFrom && publishedTo && publishedFrom > publishedTo) {
    throw new AdminRequestError(400, 'publishedFrom must not be later than publishedTo');
  }
  const language = stringValue(body.language);
  if (language && language.length > 50) {
    throw new AdminRequestError(400, 'language must be at most 50 characters');
  }
  return { publishedFrom, publishedTo, language };
}

/**
 * Create the HTTP handler. Exported separately from the listener so tests can
 * exercise routing without binding a port.
 */
export function createAdminHandler({ providers, ingest, token, logger = console }) {
  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (!authorized(request.headers.authorization, token)) {
        sendJson(response, 401, {
          error: 'Unauthorized',
          message: 'a valid admin bearer token is required'
        });
        return;
      }

      if (url.pathname === '/provider-search') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'MethodNotAllowed' });
          return;
        }
        const body = objectBody(await readJson(request));
        const candidates = await searchProvider(providers, body.provider, body.query);
        sendJson(response, 200, { provider: body.provider, candidates });
        return;
      }

      if (url.pathname === '/contributor-search') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'MethodNotAllowed' });
          return;
        }
        const body = objectBody(await readJson(request));
        const query = contributorQueryInput(body);
        const limit = boundedInteger(body.limit, 'limit', {
          fallback: CONTRIBUTOR_LIMIT_DEFAULT,
          min: 1,
          max: CONTRIBUTOR_LIMIT_MAX
        });
        const contributors = await providers.providers.openlibrary.searchContributors(query, {
          limit
        });
        sendJson(response, 200, { query, limit, contributors });
        return;
      }

      if (url.pathname === '/resolve-format') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'MethodNotAllowed' });
          return;
        }
        const body = objectBody(await readJson(request));
        const isbns = normalizeFormatIsbns(body.isbns);
        const resolved = await resolveFormat(providers, isbns);
        if (!resolved) {
          throw new AdminRequestError(
            404,
            'Goodreads returned no format for the supplied ISBNs',
            'FormatNotFound'
          );
        }
        sendJson(response, 200, resolved);
        return;
      }

      if (url.pathname === '/ingest') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'MethodNotAllowed' });
          return;
        }
        const body = objectBody(await readJson(request));
        const candidate = normalizeCandidate(body.candidate);
        const result = await ingest(candidate);
        if (!result) throw new AdminRequestError(422, 'candidate could not be ingested');
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === '/publisher-search') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'MethodNotAllowed' });
          return;
        }
        const body = objectBody(await readJson(request));
        const query = publisherQueryInput(body);
        const page = positivePage(body.page);
        const pageSize = boundedInteger(body.pageSize, 'pageSize', {
          fallback: PUBLISHER_SEARCH_PAGE_SIZE,
          min: 1,
          max: PUBLISHER_PAGE_SIZE_MAX
        });
        const result = await isbndbOr503(providers).searchPublishers(query, { page, pageSize });
        if (result === null) throw isbndbQuotaError();
        sendJson(response, 200, { query, ...result });
        return;
      }

      if (url.pathname === '/publisher-books') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'MethodNotAllowed' });
          return;
        }
        const body = objectBody(await readJson(request));
        const name = publisherNameInput(body);
        const page = positivePage(body.page);
        const pageSize = boundedInteger(body.pageSize, 'pageSize', {
          fallback: PUBLISHER_IMPORT_PAGE_SIZE_DEFAULT,
          min: 1,
          max: PUBLISHER_PAGE_SIZE_MAX
        });
        const result = await isbndbOr503(providers).booksByPublisher(name, {
          page,
          pageSize,
          ...publisherFilters(body)
        });
        if (result === null) throw isbndbQuotaError();
        sendJson(response, 200, { name, ...result });
        return;
      }

      if (url.pathname === '/publisher-import') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'MethodNotAllowed' });
          return;
        }
        const body = objectBody(await readJson(request));
        const name = publisherNameInput(body);
        const firstPage = positivePage(body.page);
        const pageSize = boundedInteger(body.pageSize, 'pageSize', {
          fallback: PUBLISHER_IMPORT_PAGE_SIZE_DEFAULT,
          min: 1,
          max: PUBLISHER_PAGE_SIZE_MAX
        });
        const maxPages = boundedInteger(body.maxPages, 'maxPages', {
          fallback: 1,
          min: 1,
          max: PUBLISHER_IMPORT_MAX_PAGES
        });
        const filters = publisherFilters(body);
        const isbndb = isbndbOr503(providers);

        // Each book is ingested in its own transaction, so one bad record never
        // discards the rest of the batch; failures are reported per title.
        let page = firstPage;
        let pagesFetched = 0;
        let imported = 0;
        let created = 0;
        let existing = 0;
        let total = 0;
        let stopped = 'end';
        const failures = [];

        for (let index = 0; index < maxPages; index += 1) {
          const batch = await isbndb.booksByPublisher(name, { page, pageSize, ...filters });
          if (batch === null) {
            stopped = 'quota_exhausted';
            break;
          }
          total = Math.max(total, batch.total);
          if (batch.candidates.length === 0) {
            stopped = 'end';
            break;
          }
          for (const candidate of batch.candidates) {
            try {
              const result = await ingest(normalizeCandidate(candidate));
              if (!result) {
                failures.push({ title: candidate.title, message: 'no ingestable identifiers' });
                continue;
              }
              imported += 1;
              if (result.created) created += 1;
              else existing += 1;
            } catch (error) {
              failures.push({ title: candidate.title, message: error.message });
            }
          }
          pagesFetched += 1;
          page += 1;
          stopped = total > 0 && page * pageSize >= total ? 'end' : 'max_pages';
          if (stopped === 'end') break;
        }

        sendJson(response, 200, {
          name,
          pagesFetched,
          nextPage: stopped === 'max_pages' ? page : null,
          total,
          imported,
          created,
          existing,
          failed: failures.length,
          failures,
          stopped
        });
        return;
      }

      sendJson(response, 404, { error: 'NotFound' });
    } catch (error) {
      if (error instanceof FormatResolveError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
        return;
      }
      if (error instanceof AdminRequestError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
        return;
      }
      // Provider failures must not leak upstream bodies (or credentials) to a
      // browser; log the cause and return a stable gateway error.
      logger?.error?.(`worker admin: ${request.method} ${url.pathname} failed — ${error.message}`);
      sendJson(response, 502, {
        error: 'ProviderUnavailable',
        message: 'the provider request failed'
      });
    }
  };
}

/**
 * Start the admin listener. Returns `undefined` and logs when ADMIN_TOKEN is
 * unset, which is the documented way to disable the admin surface.
 */
export async function startAdminServer({
  pool,
  providers,
  publisherDid,
  publisherHost,
  env = process.env,
  logger = console
} = {}) {
  const config = resolveAdminConfig(env);
  if (!config.enabled) {
    logger?.log?.(
      'worker: admin API disabled — ADMIN_TOKEN is unset; provider search and ingest are unavailable'
    );
    return undefined;
  }
  if (!pool || !providers) throw new Error('admin server requires the catalog pool and providers');

  const ingest = createIngest({ pool, publisherDid, publisherHost });
  const handler = createAdminHandler({ providers, ingest, token: config.token, logger });
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : config.port;
  logger?.log?.(`worker: admin API listening on http://${config.host}:${port}`);

  return {
    server,
    host: config.host,
    port,
    url: `http://${config.host}:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
