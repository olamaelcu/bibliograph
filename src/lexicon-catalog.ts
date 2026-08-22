import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEXICONS_DIR = join(PROJECT_ROOT, 'lexicons');

export interface LexiconParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  default?: string;
  knownValues?: string[];
}

export interface LexiconProperty {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface LexiconOutput {
  encoding: string;
  kind: string;
  properties: LexiconProperty[];
}

export interface LexiconError {
  name: string;
  description?: string;
}

export interface LexiconRecordProperty {
  name: string;
  /** Resolved type, e.g. `string`, `integer`, `ref expandedBook`, `array<ref genre>`, `blob`. */
  type: string;
  required: boolean;
  description?: string;
  /** Human-readable constraints, e.g. `max 300 graphemes`, `min 1`, `values: reading, to-read`. */
  constraints: string[];
}

export interface LexiconRecord {
  /** Full lexicon NSID, e.g. `net.olamaelcu.livtet.biblio.book`. */
  id: string;
  /** Last segment of the NSID, e.g. `book`. */
  name: string;
  type: 'record';
  description?: string;
  /** Record key constraint, e.g. `any`, `tid`. */
  key: string;
  properties: LexiconRecordProperty[];
  /** Path relative to the project root, e.g. `lexicons/net/.../book.json`. */
  lexiconPath: string;
}

export interface LexiconEndpoint {
  /** Full lexicon NSID, e.g. `net.olamaelcu.livtet.biblio.getBook`. */
  id: string;
  /** Last segment of the NSID, e.g. `getBook`. */
  name: string;
  type: 'query' | 'procedure';
  description?: string;
  params: LexiconParam[];
  output?: LexiconOutput;
  errors: LexiconError[];
  /** Path relative to the project root, e.g. `lexicons/net/.../getBook.json`. */
  lexiconPath: string;
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function describeType(prop: JsonObject): string {
  const type = typeof prop.type === 'string' ? prop.type : 'unknown';
  if (type === 'ref' && typeof prop.ref === 'string') {
    const short = prop.ref.split('#')[0].split('.').pop() ?? prop.ref;
    return `ref ${short}`;
  }
  if (type === 'array' && isObject(prop.items)) {
    return `array<${describeType(prop.items)}>`;
  }
  return type;
}

function extractProperties(
  props: unknown,
  requiredList: unknown,
): LexiconProperty[] {
  if (!isObject(props)) return [];
  const required = new Set(asStringArray(requiredList));
  const result: LexiconProperty[] = [];
  for (const [name, value] of Object.entries(props)) {
    if (!isObject(value)) continue;
    result.push({
      name,
      type: describeType(value),
      required: required.has(name),
      description: typeof value.description === 'string' ? value.description : undefined,
    });
  }
  return result;
}

function collectJsonFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
}



function parseLexicon(file: string): LexiconEndpoint | null {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  if (!isObject(raw.defs) || !isObject(raw.defs.main)) return null;

  const main = raw.defs.main;
  const type = main.type;
  if (type !== 'query' && type !== 'procedure') return null;

  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = id.split('.').pop() ?? id;

  const params: LexiconParam[] = [];
  const paramDefs = isObject(main.parameters) ? main.parameters : undefined;
  if (paramDefs) {
    const required = new Set(asStringArray(paramDefs.required));
    const properties = isObject(paramDefs.properties) ? paramDefs.properties : undefined;
    if (properties) {
      for (const [pname, pvalue] of Object.entries(properties)) {
        if (!isObject(pvalue)) continue;
        params.push({
          name: pname,
          type: describeType(pvalue),
          required: required.has(pname),
          description: typeof pvalue.description === 'string' ? pvalue.description : undefined,
          default: pvalue.default != null ? String(pvalue.default) : undefined,
          knownValues: Array.isArray(pvalue.knownValues)
            ? pvalue.knownValues.filter((x): x is string => typeof x === 'string')
            : undefined,
        });
      }
    }
  }

  let output: LexiconOutput | undefined;
  const outputDef = isObject(main.output) ? main.output : undefined;
  if (outputDef) {
    const schema = isObject(outputDef.schema) ? outputDef.schema : undefined;
    output = {
      encoding: typeof outputDef.encoding === 'string' ? outputDef.encoding : 'application/json',
      kind: schema ? describeType(schema) : 'unknown',
      properties:
        schema && schema.type === 'object' ? extractProperties(schema.properties, schema.required) : [],
    };
  }

  const errors: LexiconError[] = [];
  if (Array.isArray(main.errors)) {
    for (const e of main.errors) {
      if (!isObject(e)) continue;
      errors.push({
        name: typeof e.name === 'string' ? e.name : 'Error',
        description: typeof e.description === 'string' ? e.description : undefined,
      });
    }
  }

  return {
    id,
    name,
    type: type as 'query' | 'procedure',
    description: typeof raw.description === 'string' ? raw.description : undefined,
    params,
    output,
    errors,
    lexiconPath: file.slice(PROJECT_ROOT.length),
  };
}

/**
 * Resolve a record/param property to a display type plus human-readable
 * constraints (grapheme limits, ranges, known values, blob accept rules).
 */
function describeRecordProp(
  prop: JsonObject,
): { type: string; constraints: string[] } {
  const type = typeof prop.type === 'string' ? prop.type : 'unknown';
  const constraints: string[] = [];

  const format = typeof prop.format === 'string' ? prop.format : undefined;
  const maxGraphemes = typeof prop.maxGraphemes === 'number' ? prop.maxGraphemes : undefined;
  const minimum = typeof prop.minimum === 'number' ? prop.minimum : undefined;
  const maximum = typeof prop.maximum === 'number' ? prop.maximum : undefined;
  const knownValues = asStringArray(prop.knownValues);
  const accept = asStringArray(prop.accept);
  const maxSize = typeof prop.maxSize === 'number' ? prop.maxSize : undefined;

  if (format) constraints.push(`format ${format}`);
  if (maxGraphemes != null) constraints.push(`max ${maxGraphemes} graphemes`);
  if (minimum != null) constraints.push(`min ${minimum}`);
  if (maximum != null) constraints.push(`max ${maximum}`);
  if (knownValues.length) constraints.push(`values: ${knownValues.join(', ')}`);
  if (accept.length) constraints.push(`accept ${accept.join(', ')}`);
  if (maxSize != null) constraints.push(`max ${Math.round(maxSize / 1_000_000)}MB`);

  if (type === 'ref' && typeof prop.ref === 'string') {
    return { type: `ref ${richerRefName(prop.ref)}`, constraints };
  }
  if (type === 'array' && isObject(prop.items)) {
    const items = describeRecordProp(prop.items);
    return { type: `array<${items.type}>`, constraints: [...constraints, ...items.constraints] };
  }
  return { type, constraints };
}

/**
 * A short, human-friendly name for a lexicon ref: `defs#readingStatus` →
 * `readingStatus`, `net.olamaelcu.livtet.biblio.work` → `work`.
 */
function richerRefName(ref: string): string {
  const hash = ref.split('#');
  if (hash.length > 1 && hash[1]) return hash[1];
  const seg = hash[0].split('.').pop();
  return seg || ref;
}

function parseLexiconRecord(file: string): LexiconRecord | null {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  if (!isObject(raw.defs) || !isObject(raw.defs.main)) return null;
  const main = raw.defs.main;
  if (main.type !== 'record') return null;

  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = id.split('.').pop() ?? id;

  const record = isObject(main.record) ? main.record : undefined;
  const required = new Set(asStringArray(record?.required));
  const properties: LexiconRecordProperty[] = [];
  const propDefs = record && isObject(record.properties) ? record.properties : undefined;
  if (propDefs) {
    for (const [pname, pvalue] of Object.entries(propDefs)) {
      if (!isObject(pvalue)) continue;
      const { type, constraints } = describeRecordProp(pvalue);
      properties.push({
        name: pname,
        type,
        required: required.has(pname),
        description: typeof pvalue.description === 'string' ? pvalue.description : undefined,
        constraints,
      });
    }
  }

  return {
    id,
    name,
    type: 'record',
    description: typeof raw.description === 'string' ? raw.description : undefined,
    key: typeof main.key === 'string' ? main.key : 'any',
    properties,
    lexiconPath: file.slice(PROJECT_ROOT.length),
  };
}

/**
 * Record collections written by the AppView itself (community catalog) and the
 * user-owned records (shelves, book shelvings, actor profiles). Everything
 * else is written by clients to the user's own PDS and surfaced via
 * Jetstream indexing (`user_records`).
 */
export const catalogRecordNsids: ReadonlySet<string> = new Set([
  'community.lexicon.book.edition',
  'community.lexicon.book.contributor',
  // App-private user-owned records:
  'net.olamaelcu.livtet.biblio.shelf',
  'net.olamaelcu.livtet.biblio.bookShelving',
  'net.olamaelcu.livtet.biblio.actor',
]);

/** All xrpc `query`/`procedure` endpoints, sorted by NSID. Built once at module load. */
export const lexiconEndpoints: LexiconEndpoint[] = (() => {
  const files: string[] = [];
  collectJsonFiles(LEXICONS_DIR, files);
  const endpoints = files
    .map(parseLexicon)
    .filter((e): e is LexiconEndpoint => e !== null);
  endpoints.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return endpoints;
})();

export const queryCount = lexiconEndpoints.filter((e) => e.type === 'query').length;
export const procedureCount = lexiconEndpoints.filter((e) => e.type === 'procedure').length;

/** All `record`-type lexicons (firehose-eligible), sorted by NSID. Built once at module load. */
export const recordLexicons: LexiconRecord[] = (() => {
  const files: string[] = [];
  collectJsonFiles(LEXICONS_DIR, files);
  const records = files
    .map(parseLexiconRecord)
    .filter((r): r is LexiconRecord => r !== null);
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return records;
})();
