#!/usr/bin/env node
/**
 * Structural verification for every lexicon under `happyview/lexicons`.
 *
 * This is the offline half of `scripts/publish-lexicons.mjs`: it never touches
 * a PDS. It checks the document shape against the Lexicon v1 field tables, that
 * the NSID matches the file path, that every reference resolves (locally, or to
 * the two external authorities this deployment vendors), and that no property
 * uses a field the specification does not define — `pattern`, `minItems` and
 * friends are rejected rather than silently ignored.
 *
 * Usage: node scripts/verify-lexicons.mjs [--dir happyview/lexicons]
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_DIR = 'happyview/lexicons';

// https://atproto.com/specs/lexicon — field set per definition type.
const ALLOWED_FIELDS = {
  boolean: ['description', 'default', 'const'],
  integer: ['description', 'minimum', 'maximum', 'enum', 'default', 'const'],
  string: [
    'description',
    'format',
    'maxLength',
    'minLength',
    'maxGraphemes',
    'minGraphemes',
    'knownValues',
    'enum',
    'default',
    'const'
  ],
  bytes: ['description', 'maxLength', 'minLength'],
  'cid-link': ['description'],
  blob: ['description', 'accept', 'maxSize'],
  array: ['description', 'items', 'minLength', 'maxLength'],
  object: ['description', 'properties', 'required', 'nullable'],
  params: ['description', 'required', 'properties'],
  token: ['description'],
  ref: ['description', 'ref'],
  union: ['description', 'refs', 'closed'],
  unknown: ['description'],
  record: ['description', 'key', 'record'],
  query: ['description', 'parameters', 'output', 'errors'],
  procedure: ['description', 'parameters', 'output', 'input', 'errors'],
  subscription: ['description', 'parameters', 'message', 'errors'],
  'permission-set': ['description', 'permissions', 'title', 'detail'],
  permission: ['description', 'resource', 'collection', 'action', 'lxm', 'aud', 'inheritAud']
};

const STRING_FORMATS = new Set([
  'at-identifier',
  'at-uri',
  'cid',
  'datetime',
  'did',
  'handle',
  'nsid',
  'uri',
  'language',
  'tid',
  'record-key'
]);

const PRIMARIES = new Set(['record', 'query', 'procedure', 'subscription', 'permission-set']);

// These authorities are vendored, not owned by this repository. A reference to
// them resolves against the vendored copy; anything else must be local.
const EXTERNAL_AUTHORITIES = ['com.atproto.', 'community.lexicon.media.book.'];

const NSID_RE =
  /^[a-zA-Z]([a-zA-Z0-9-]{0,62}\.)+[a-zA-Z]([a-zA-Z0-9-]{0,62})$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = { dir: DEFAULT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--dir needs a path');
      options.dir = value;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function collectLexiconFiles(root) {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    }
  }
  await walk(root);
  return files;
}

/** Check one schema node; `where` is a human-readable path for errors. */
function checkSchema(node, where, doc, documents, errors) {
  if (!isObject(node)) {
    errors.push(`${where}: schema must be an object`);
    return;
  }
  const type = node.type;
  if (typeof type !== 'string') {
    errors.push(`${where}: schema is missing a string "type"`);
    return;
  }
  if (!(type in ALLOWED_FIELDS)) {
    errors.push(`${where}: unknown schema type ${JSON.stringify(type)}`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    if (!ALLOWED_FIELDS[type].includes(key)) {
      errors.push(`${where}: ${type} does not define ${JSON.stringify(key)}`);
    }
  }

  if (type === 'string' && node.format !== undefined) {
    if (typeof node.format !== 'string' || !STRING_FORMATS.has(node.format)) {
      errors.push(`${where}: unknown string format ${JSON.stringify(node.format)}`);
    }
  }
  if (type === 'blob' && node.accept !== undefined) {
    if (!Array.isArray(node.accept) || node.accept.some((entry) => typeof entry !== 'string')) {
      errors.push(`${where}: blob accept must be an array of strings`);
    }
  }
  if (type === 'array') {
    if (node.items === undefined) errors.push(`${where}: array has no items`);
    else checkSchema(node.items, `${where}.items`, doc, documents, errors);
  }
  if (type === 'object' || type === 'params') {
    if (!isObject(node.properties)) {
      errors.push(`${where}: ${type} has no properties object`);
      return;
    }
    for (const [name, property] of Object.entries(node.properties)) {
      checkSchema(property, `${where}.${name}`, doc, documents, errors);
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required)) {
        errors.push(`${where}: required must be an array`);
      } else {
        for (const name of node.required) {
          if (!(name in node.properties)) {
            errors.push(`${where}: required ${JSON.stringify(name)} is not a property`);
          }
        }
      }
    }
    if (node.nullable !== undefined) {
      if (!Array.isArray(node.nullable)) errors.push(`${where}: nullable must be an array`);
      else {
        for (const name of node.nullable) {
          if (!(name in node.properties)) {
            errors.push(`${where}: nullable ${JSON.stringify(name)} is not a property`);
          }
        }
      }
    }
  }
  if (type === 'ref' || type === 'union') {
    const refs = type === 'ref' ? [node.ref] : node.refs;
    if (type === 'ref' && (typeof node.ref !== 'string' || node.ref === '')) {
      errors.push(`${where}: ref has no ref target`);
      return;
    }
    if (type === 'union' && !Array.isArray(node.refs)) {
      errors.push(`${where}: union has no refs array`);
      return;
    }
    for (const ref of refs) {
      if (typeof ref !== 'string' || ref === '') {
        errors.push(`${where}: ref target must be a non-empty string`);
        continue;
      }
      if (ref.startsWith('#')) {
        if (!(ref.slice(1) in doc.defs)) {
          errors.push(`${where}: local ref ${JSON.stringify(ref)} does not exist`);
        }
        continue;
      }
      const [nsid, fragment] = ref.split('#');
      if (!documents.has(nsid)) {
        if (EXTERNAL_AUTHORITIES.some((prefix) => nsid.startsWith(prefix))) continue;
        errors.push(`${where}: ref ${JSON.stringify(ref)} names an unknown lexicon`);
        continue;
      }
      if (fragment !== undefined) {
        const target = documents.get(nsid).doc;
        if (!(fragment in target.defs)) {
          errors.push(`${where}: ref ${JSON.stringify(ref)} has no such definition`);
        }
      }
    }
  }
  if (type === 'record') {
    if (typeof node.key !== 'string' || node.key === '') {
      errors.push(`${where}: record has no key type`);
    } else if (node.key !== 'tid' && node.key !== 'any' && !node.key.startsWith('literal:')) {
      errors.push(`${where}: record key ${JSON.stringify(node.key)} is not tid, any or literal:`);
    }
    if (node.record === undefined) errors.push(`${where}: record has no record schema`);
    else {
      checkSchema(node.record, `${where}.record`, doc, documents, errors);
      if (node.record.type !== 'object') errors.push(`${where}: record.record must be an object`);
    }
  }
  for (const field of ['parameters', 'input', 'output']) {
    const container = node[field];
    if (container === undefined) continue;
    if (!isObject(container)) {
      errors.push(`${where}.${field}: must be an object`);
      continue;
    }
    if (field === 'parameters') {
      checkSchema(container, `${where}.parameters`, doc, documents, errors);
      if (container.type !== 'params') errors.push(`${where}.parameters: type must be params`);
      continue;
    }
    if (typeof container.encoding !== 'string' || container.encoding === '') {
      errors.push(`${where}.${field}: encoding is required`);
    }
    if (container.schema !== undefined) {
      checkSchema(container.schema, `${where}.${field}.schema`, doc, documents, errors);
    }
  }
  if (node.errors !== undefined) {
    if (!Array.isArray(node.errors)) {
      errors.push(`${where}: errors must be an array`);
    } else {
      for (const [index, entry] of node.errors.entries()) {
        if (!isObject(entry) || typeof entry.name !== 'string' || entry.name === '') {
          errors.push(`${where}.errors[${index}]: needs a name`);
        }
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node scripts/verify-lexicons.mjs [--dir <path>]');
    return 0;
  }
  const root = path.resolve(REPO_ROOT, options.dir);
  const files = await collectLexiconFiles(root);
  if (files.length === 0) throw new Error(`no lexicon JSON files under ${root}`);

  const errors = [];
  const documents = new Map();

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
    if (!isObject(doc)) {
      errors.push(`${relative}: document must be a JSON object`);
      continue;
    }
    for (const key of Object.keys(doc)) {
      if (!['lexicon', 'id', 'description', 'defs', '$type'].includes(key)) {
        errors.push(`${relative}: unknown top-level field ${JSON.stringify(key)}`);
      }
    }
    if (doc.lexicon !== 1) {
      errors.push(`${relative}: "lexicon" must be the integer 1`);
      continue;
    }
    if (typeof doc.id !== 'string' || !NSID_RE.test(doc.id)) {
      errors.push(`${relative}: "id" is not a valid NSID`);
      continue;
    }
    if (doc.id !== pathId) {
      errors.push(`${relative}: "id" does not match the path-derived ${pathId}`);
      continue;
    }
    if (!isObject(doc.defs) || Object.keys(doc.defs).length === 0) {
      errors.push(`${relative}: "defs" must be a non-empty object`);
      continue;
    }
    if (documents.has(doc.id)) {
      errors.push(`${relative}: duplicate NSID ${doc.id}`);
      continue;
    }
    documents.set(doc.id, { doc, relative });
  }

  // Second pass: schemas can reference any other file, so every document must
  // be loaded before a ref is resolved.
  for (const [id, { doc, relative }] of documents) {
    let primaries = 0;
    for (const [name, definition] of Object.entries(doc.defs)) {
      if (!isObject(definition) || typeof definition.type !== 'string') {
        errors.push(`${relative}#${name}: definition needs a type`);
        continue;
      }
      if (PRIMARIES.has(definition.type)) {
        primaries += 1;
        if (name !== 'main') {
          errors.push(`${relative}#${name}: primary definitions must be named main`);
        }
      }
      if (definition.type === 'params') {
        errors.push(`${relative}#${name}: params cannot be a named definition`);
      }
      checkSchema(definition, `${relative}#${name}`, doc, documents, errors);
    }
    if (primaries > 1) {
      errors.push(`${relative}: at most one primary definition is allowed`);
    }
  }

  if (errors.length > 0) {
    console.error(`verify-lexicons: ${errors.length} problem(s)`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`verify-lexicons: ${documents.size} lexicon(s) valid`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`verify-lexicons: ${error.message}`);
  process.exitCode = 1;
}
