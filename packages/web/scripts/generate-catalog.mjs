#!/usr/bin/env node
// Generate the XRPC catalogue the landing page renders, straight from the
// lexicons in `happyview/lexicons`. Hand-maintaining the page would drift from
// the deployed surface the first time a parameter changed; this way the page
// documents exactly what `mise run hv-deploy` uploads.
//
// Output: src/lib/xrpc-catalog.json (gitignored). Runs as part of `dev`,
// `build` and `check`, so the file can never be stale in a build.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
// HappyView's uploaded surface plus the book lexicons imported from
// lexicon.community PR #18 (edition, resolveEditions, searchEditions and the
// shared defs/review). The books-wg submodule stays for upstream provenance but
// is no longer a catalog input: its pin predates the PR.
const lexiconsDirs = [
  join(here, '..', '..', '..', 'happyview', 'lexicons')
];
const outFile = join(here, '..', 'src', 'lib', 'xrpc-catalog.json');

/** Render a lexicon type as one readable label. */
function typeLabel(schema) {
  if (!schema) return 'unknown';
  if (schema.type === 'array') return `array<${typeLabel(schema.items)}>`;
  if (schema.type === 'ref') return schema.ref ?? 'ref';
  if (schema.type === 'union') return 'union';
  return schema.type ?? 'unknown';
}

/** Flatten a `properties`/`required` pair into rows the page can table. */
function fields(schema) {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type: typeLabel(property),
    required: required.has(name),
    description: property.description ?? null,
    format: property.format ?? null,
    default: property.default ?? null,
    values: property.enum ?? property.knownValues ?? null,
    minimum: property.minimum ?? null,
    maximum: property.maximum ?? null,
    maxLength: property.maxLength ?? null
  }));
}

async function findLexicons(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

const queries = [];
const procedures = [];
const records = [];

const seen = new Set();

for (const dir of lexiconsDirs) {
  for (const file of await findLexicons(dir)) {
    const lexicon = JSON.parse(await readFile(file, 'utf8'));
    // Keep one entry per NSID; a directory may later repeat a shared lexicon.
    if (seen.has(lexicon.id)) continue;
    seen.add(lexicon.id);

    const main = lexicon.defs?.main;
    const description = main?.description ?? lexicon.description ?? '';

    if (main?.type === 'query') {
      queries.push({
        id: lexicon.id,
        description,
        params: fields(main.parameters)
      });
    } else if (main?.type === 'procedure') {
      procedures.push({
        id: lexicon.id,
        description,
        input: fields(main.input?.schema),
        output: fields(main.output?.schema)
      });
    } else if (main?.type === 'record') {
      records.push({
        id: lexicon.id,
        key: main.key ?? 'tid',
        description
      });
    }
  }
}

const byId = (a, b) => a.id.localeCompare(b.id);
queries.sort(byId);
procedures.sort(byId);
records.sort(byId);

const catalog = { queries, procedures, records };
await writeFile(outFile, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(
  `catalog: ${queries.length} queries, ${procedures.length} procedures, ` +
    `${records.length} record types → ${outFile.replace(`${here}..\\`, '')}`
);
