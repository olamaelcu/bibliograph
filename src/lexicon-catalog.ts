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
