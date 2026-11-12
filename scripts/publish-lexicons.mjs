#!/usr/bin/env node
/**
 * Publish every local lexicon as a `com.atproto.lexicon.schema` record.
 *
 * A lexicon is only discoverable by NSID once it is a record in the publisher's
 * repo at `at://<did>/com.atproto.lexicon.schema/<nsid>`. This script walks
 * `happyview/lexicons/**\/*.json`, validates the document and its path-derived
 * NSID, and writes each one with `com.atproto.repo.putRecord` (rkey = NSID).
 *
 * Publishing is a repo write, not a namespace claim: the PDS performs only
 * structural checks. Consumers additionally require `_lexicon.<authority>` TXT
 * to name the publishing DID, so the script reports authority status but does
 * not treat a missing TXT as a write failure.
 *
 * Authentication mirrors `packages/worker/lib/pds.js`:
 *
 * - `PDS_ACCOUNT_DID` + `PDS_ACCOUNT_PASSWORD` (an app password): a fresh
 *   `com.atproto.server.createSession`, refreshed on 401.
 * - `PDS_ACCESS_TOKEN` (+ optional `PDS_REFRESH_TOKEN`): a provisioned session.
 *
 * Required: `PDS_URL` and `PDS_ACCOUNT_DID`. `ATP_SERVICE_DID` (or
 * `ATP_SERVICE_HOST`) may name the same publisher identity; a mismatch is a
 * configuration error, because the session account must own the repo.
 *
 * Idempotent: an identical existing record is reported as skipped; changed
 * documents are updated; new ones are created. Every write is re-read and the
 * stored value/CID are compared before it counts as published.
 *
 * Usage:
 *   node scripts/publish-lexicons.mjs [--dry-run] [--no-validate]
 *                                     [--dir happyview/lexicons] [--skip-authority]
 *
 * Secrets are never printed.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolveTxt } from 'node:dns/promises';
import path from 'node:path';

const COLLECTION = 'com.atproto.lexicon.schema';
const DEFAULT_LEXICON_DIR = 'happyview/lexicons';
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TIMEOUT_MS = 20_000;
const DNS_TIMEOUT_MS = 5_000;

// NSID syntax from https://atproto.com/specs/nsid
const NSID_RE =
  /^[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(\.[a-zA-Z]([a-zA-Z0-9]{0,62})?)$/;

class PdsError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'PdsError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function parseArgs(argv) {
  const options = {
    dir: DEFAULT_LEXICON_DIR,
    dryRun: false,
    validate: true,
    skipAuthority: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-validate':
        options.validate = false;
        break;
      case '--skip-authority':
        options.skipAuthority = true;
        break;
      case '--dir': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--dir needs a path');
        options.dir = value;
        break;
      }
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Reverse every segment before the final name segment. */
function authorityFor(nsid) {
  return nsid.split('.').slice(0, -1).reverse().join('.');
}

async function collectLexiconFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot read ${dir}: ${error.message}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(full);
      }
    }
  }
  await walk(root);
  return files;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadDocuments(files, root) {
  const errors = [];
  const byId = new Map();
  const documents = [];

  for (const file of files) {
    const relative = path.relative(root, file);
    const pathId = relative.replace(/\.json$/, '').split(path.sep).join('.');
    let doc;
    try {
      doc = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      errors.push(`${relative}: invalid JSON (${error.message})`);
      continue;
    }
    if (!isPlainObject(doc)) {
      errors.push(`${relative}: document must be a JSON object`);
      continue;
    }
    if (doc.lexicon !== 1) {
      errors.push(`${relative}: "lexicon" must be the integer 1 (got ${JSON.stringify(doc.lexicon)})`);
      continue;
    }
    if (typeof doc.id !== 'string' || doc.id === '') {
      errors.push(`${relative}: "id" must be a non-empty string`);
      continue;
    }
    if (!NSID_RE.test(doc.id)) {
      errors.push(`${relative}: "id" ${JSON.stringify(doc.id)} is not a valid NSID`);
      continue;
    }
    if (doc.id !== pathId) {
      errors.push(`${relative}: "id" ${JSON.stringify(doc.id)} does not match the path-derived NSID ${JSON.stringify(pathId)}`);
      continue;
    }
    if (!isPlainObject(doc.defs) || Object.keys(doc.defs).length === 0) {
      errors.push(`${relative}: "defs" must be a non-empty object`);
      continue;
    }
    if (doc.$type !== undefined && doc.$type !== COLLECTION) {
      errors.push(`${relative}: "$type" must be ${COLLECTION} if present (got ${JSON.stringify(doc.$type)})`);
      continue;
    }
    if (byId.has(doc.id)) {
      errors.push(`${relative}: duplicate NSID ${JSON.stringify(doc.id)} (also ${path.relative(root, byId.get(doc.id))})`);
      continue;
    }
    byId.set(doc.id, file);
    documents.push({ file, relative, id: doc.id, document: doc });
  }

  return { documents, errors };
}

/** Canonical JSON for structural comparison (object key order is irrelevant). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rkeyOf(schemaDocument) {
  return { ...schemaDocument, $type: COLLECTION };
}

function resolveConfig(env = process.env) {
  const pdsUrl = typeof env.PDS_URL === 'string' ? env.PDS_URL.replace(/\/+$/, '') : '';
  const serviceDid =
    env.ATP_SERVICE_DID ||
    (env.ATP_SERVICE_HOST ? `did:web:${env.ATP_SERVICE_HOST}` : '');
  const accountDid = env.PDS_ACCOUNT_DID || serviceDid;
  const password = env.PDS_ACCOUNT_PASSWORD || '';
  const accessToken = env.PDS_ACCESS_TOKEN || '';
  const refreshToken = env.PDS_REFRESH_TOKEN || '';

  const problems = [];
  if (!pdsUrl) problems.push('PDS_URL');
  if (!accountDid) problems.push('PDS_ACCOUNT_DID (or ATP_SERVICE_DID)');
  if (!accessToken && !password) problems.push('PDS_ACCOUNT_PASSWORD or PDS_ACCESS_TOKEN');
  if (serviceDid && accountDid && serviceDid !== accountDid) {
    problems.push(
      `PDS_ACCOUNT_DID (${accountDid}) is not the publisher DID (${serviceDid}); ` +
        'the session must own the repo being written'
    );
  }

  return { pdsUrl, accountDid, password, accessToken, refreshToken, problems };
}

function configError(config) {
  return new Error(
    `publish-lexicons is not configured: ${config.problems.join('; ')}. ` +
      'Set PDS_URL and PDS_ACCOUNT_DID plus PDS_ACCOUNT_PASSWORD (app password) ' +
      'or PDS_ACCESS_TOKEN.'
  );
}

async function readJson(response) {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'InvalidResponse', message: text.slice(0, 500) };
  }
}

function createClient(config) {
  let session;
  let sessionPromise;

  async function request(nsid, { httpMethod = 'POST', body, token, query } = {}) {
    const url = new URL(`${config.pdsUrl}/xrpc/${nsid}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    const init = {
      method: httpMethod,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    };
    const response = await fetch(url, init);
    const payload = await readJson(response);
    if (!response.ok) {
      throw new PdsError(
        `${nsid} failed: ${response.status} ${payload.error ?? ''} ${payload.message ?? ''}`.trim(),
        { status: response.status, code: payload.error, body: payload }
      );
    }
    return payload;
  }

  function assertAccount(did) {
    if (typeof did === 'string' && did !== '' && did !== config.accountDid) {
      throw new PdsError(
        `authenticated as ${did}, but publishing as ${config.accountDid}; ` +
          'set PDS_ACCOUNT_DID to the account that owns the repo',
        { code: 'WrongRepoOwner' }
      );
    }
  }

  async function createSession() {
    if (config.accessToken) {
      const current = await request('com.atproto.server.getSession', {
        httpMethod: 'GET',
        token: config.accessToken
      });
      assertAccount(current.did);
      return { accessJwt: config.accessToken, refreshJwt: config.refreshToken };
    }
    const created = await request('com.atproto.server.createSession', {
      body: { identifier: config.accountDid, password: config.password }
    });
    if (typeof created.accessJwt !== 'string' || created.accessJwt === '') {
      throw new PdsError('createSession returned no accessJwt', { body: created });
    }
    assertAccount(created.did);
    return { accessJwt: created.accessJwt, refreshJwt: created.refreshJwt };
  }

  async function refreshSession(previous) {
    if (!previous?.refreshJwt) {
      if (!config.password) throw expiredSessionError();
      return createSession();
    }
    try {
      const refreshed = await request('com.atproto.server.refreshSession', {
        token: previous.refreshJwt
      });
      if (typeof refreshed.accessJwt !== 'string' || refreshed.accessJwt === '') {
        throw new PdsError('refreshSession returned no accessJwt', { body: refreshed });
      }
      assertAccount(refreshed.did);
      return { accessJwt: refreshed.accessJwt, refreshJwt: refreshed.refreshJwt };
    } catch {
      if (!config.password) throw expiredSessionError();
      return createSession();
    }
  }

  function expiredSessionError() {
    return new PdsError(
      'the PDS session expired and no refresh token or account password is configured; ' +
        'issue a new PDS_ACCESS_TOKEN (and PDS_REFRESH_TOKEN) or set PDS_ACCOUNT_PASSWORD',
      { status: 401, code: 'ExpiredToken' }
    );
  }

  async function token(force = false) {
    if (session && !force) return session.accessJwt;
    sessionPromise ??= (async () => {
      const previous = session;
      session = undefined;
      try {
        session = await (force && previous ? refreshSession(previous) : createSession());
        return session.accessJwt;
      } finally {
        sessionPromise = undefined;
      }
    })();
    return sessionPromise;
  }

  async function rpc(method, options = {}) {
    let accessJwt = await token();
    try {
      return await request(method, { ...options, token: accessJwt });
    } catch (error) {
      if (!(error instanceof PdsError) || error.status !== 401) throw error;
      accessJwt = await token(true);
      return request(method, { ...options, token: accessJwt });
    }
  }

  async function getRecord(rkey) {
    try {
      return await rpc('com.atproto.repo.getRecord', {
        httpMethod: 'GET',
        query: { repo: config.accountDid, collection: COLLECTION, rkey }
      });
    } catch (error) {
      if (error instanceof PdsError && (error.code === 'RecordNotFound' || error.status === 404)) {
        return null;
      }
      throw error;
    }
  }

  async function putRecord(rkey, record, validate) {
    return rpc('com.atproto.repo.putRecord', {
      body: {
        repo: config.accountDid,
        collection: COLLECTION,
        rkey,
        validate,
        record
      }
    });
  }

  return { getRecord, putRecord };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref()
    )
  ]);
}

async function authorityOwner(authority) {
  try {
    const records = await withTimeout(
      resolveTxt(`_lexicon.${authority}`),
      DNS_TIMEOUT_MS,
      `TXT _lexicon.${authority}`
    );
    for (const chunks of records) {
      const match = /(?:^|\s)did=([^\s]+)/.exec(chunks.join(''));
      if (match) return match[1];
    }
    return '';
  } catch {
    return null;
  }
}

async function reportAuthorities(documents, publisherDid) {
  const authorities = new Map();
  for (const { id } of documents) {
    const authority = authorityFor(id);
    if (!authorities.has(authority)) authorities.set(authority, []);
    authorities.get(authority).push(id);
  }

  const problems = [];
  for (const [authority, ids] of [...authorities].sort(([a], [b]) => a.localeCompare(b))) {
    const owner = await authorityOwner(authority);
    if (owner === publisherDid) {
      console.log(`  authority ${authority}: _lexicon TXT -> ${owner}`);
    } else if (owner === null) {
      problems.push(`${authority}: no _lexicon.${authority} TXT (${ids.length} lexicon${ids.length === 1 ? '' : 's'})`);
    } else if (owner === '') {
      problems.push(`${authority}: _lexicon.${authority} TXT has no did= value (${ids.length} lexicon${ids.length === 1 ? '' : 's'})`);
    } else {
      problems.push(`${authority}: _lexicon.${authority} TXT names ${owner}, not ${publisherDid} (${ids.length} lexicon${ids.length === 1 ? '' : 's'})`);
    }
  }
  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'usage: node scripts/publish-lexicons.mjs [--dry-run] [--no-validate] [--dir <path>] [--skip-authority]'
    );
    return 0;
  }

  const root = path.resolve(REPO_ROOT, options.dir);
  const files = await collectLexiconFiles(root);
  if (files.length === 0) throw new Error(`no lexicon JSON files under ${root}`);

  const { documents, errors } = await loadDocuments(files, root);
  if (errors.length > 0) {
    console.error(`refusing to publish: ${errors.length} invalid lexicon file(s)`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }

  const config = resolveConfig();
  if (!options.dryRun && config.problems.length > 0) throw configError(config);

  const publisherDid = config.accountDid;
  console.log(`lexicons: ${documents.length} from ${path.relative(REPO_ROOT, root)}/`);
  console.log(`publisher: ${publisherDid ?? '(unset)'}`);
  if (options.dryRun) {
    console.log('mode: dry-run (no writes)');
  } else {
    console.log(`PDS: ${config.pdsUrl}`);
  }

  if (!options.skipAuthority && publisherDid) {
    const authorityProblems = await reportAuthorities(documents, publisherDid);
    if (authorityProblems.length > 0) {
      console.log('authority warnings (repo writes still succeed; consumers need the TXT):');
      for (const problem of authorityProblems) console.log(`  - ${problem}`);
    }
  }

  if (options.dryRun) {
    for (const { id, relative } of documents) console.log(`  plan ${id}  (${relative})`);
    console.log(`dry-run: ${documents.length} lexicon(s) would be published as ${COLLECTION} records`);
    return 0;
  }

  const client = createClient(config);
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const samples = [];
  const failures = [];

  for (const { id, relative, document } of documents) {
    const record = rkeyOf(document);
    const uri = `at://${publisherDid}/${COLLECTION}/${id}`;
    try {
      const existing = await client.getRecord(id);
      if (existing !== null && canonical(existing.value) === canonical(record)) {
        counts.skipped += 1;
        console.log(`  SKIP    ${uri}  cid=${existing.cid}`);
        if (existing.cid) samples.push({ id, uri, cid: existing.cid, action: 'skipped' });
        continue;
      }

      const action = existing === null ? 'created' : 'updated';
      const result = await client.putRecord(id, record, options.validate);
      if (typeof result.cid !== 'string' || result.cid === '') {
        throw new PdsError('putRecord returned no CID', { body: result });
      }

      const verified = await client.getRecord(id);
      if (verified === null) {
        throw new PdsError('record missing after putRecord');
      }
      if (canonical(verified.value) !== canonical(record)) {
        throw new PdsError(
          `stored record differs from the published document (${relative})`
        );
      }
      if (verified.cid !== result.cid) {
        throw new PdsError(
          `verified CID ${verified.cid} does not match putRecord CID ${result.cid}`
        );
      }

      counts[action] += 1;
      console.log(`  ${action === 'created' ? 'CREATE' : 'UPDATE'}  ${uri}  cid=${result.cid}`);
      samples.push({ id, uri, cid: result.cid, action });
    } catch (error) {
      counts.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${id}: ${message}`);
      console.error(`  FAIL    ${uri}: ${message}`);
    }
  }

  console.log(
    `published: ${counts.created} created, ${counts.updated} updated, ` +
      `${counts.skipped} skipped, ${counts.failed} failed (${documents.length} total)`
  );

  if (samples.length > 0) {
    console.log('sample records:');
    for (const sample of samples.slice(0, 3)) {
      console.log(`  ${sample.uri}  cid=${sample.cid}`);
    }
  }

  if (failures.length > 0) {
    console.error('failures:');
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
