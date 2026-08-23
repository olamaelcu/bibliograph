/**
 * Walks valibot schema objects (as produced by @atcute/lex-cli) and produces
 * human-readable summaries for documentation rendering. One place that
 * knows how to introspect valibot so pages stay free of nested type checks.
 *
 * Valibot runtime shape (relevant here):
 *   - Wrapping outer: { kind: 'schema', type: 'object'|'optional'|'array'|...,
 *     shape? wrapped? item? options? default?, ~run, ~standard }
 *   - The prototype chain carries `kind` and `type` and is shared across many
 *     instances, so we have to look at instance own properties to know
 *     whether shape/wrapped/item/etc. apply to this node.
 *   - Primitive nodes (string/integer/boolean/...) are bare instances whose
 *     `kind` and `type` come from the prototype. They have no own properties
 *     beyond ~run/~standard.
 *   - Constraints live on the wrapped node for primitives.
 */

export interface FieldSummary {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: string;
  constraints?: string[];
}

export interface ErrorSummary {
  name: string;
  description?: string;
}

export interface SchemaSummary {
  kind: string;
  description?: string;
  fields?: FieldSummary[];
}

/** Pull the JSDoc-style description off a schema node (any wrapper level). */
function describe(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as { description?: string };
  if (typeof s.description === 'string' && s.description.length > 0) return s.description;
  const inner = (schema as { wrapped?: { description?: string } }).wrapped;
  if (inner && typeof inner.description === 'string' && inner.description.length > 0) {
    return inner.description;
  }
  return undefined;
}

interface ConstraintLike {
  kind?: string;
  type?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  value?: unknown;
}

/** Constraint-driven type label for primitive nodes. */
function labelFromConstraints(constraints: ConstraintLike[] | undefined): string | undefined {
  if (!constraints || constraints.length === 0) return undefined;
  // First "constraint"-kind entry's type encodes the primitive.
  for (const c of constraints) {
    if (c.kind !== 'constraint') continue;
    switch (c.type) {
      case 'string_length':
      case 'string_graphemes':
      case 'regex':
        return 'string';
      case 'integer_range':
        return 'integer';
      case 'array_length':
        return 'array';
      case 'literal_value':
        return `literal: ${JSON.stringify(c.value)}`;
      default:
        return c.type;
    }
  }
  return undefined;
}

/** Constraint strings for display (ranges, lengths). */
function pipeConstraints(constraints: unknown): string[] | undefined {
  if (!Array.isArray(constraints)) return undefined;
  const out: string[] = [];
  for (const c of constraints as ConstraintLike[]) {
    if (c.kind !== 'constraint') continue;
    switch (c.type) {
      case 'string_length':
        out.push(`${c.minLength ?? 0}–${c.maxLength ?? '∞'} chars`);
        break;
      case 'string_graphemes':
        out.push(`${c.minLength ?? 0}–${c.maxLength ?? '∞'} graphemes`);
        break;
      case 'integer_range':
        out.push(`${c.min ?? '∞'} ≤ n ≤ ${c.max ?? '∞'}`);
        break;
      case 'array_length':
        out.push(`${c.min ?? 0}–${c.max ?? '∞'} items`);
        break;
      case 'literal_value':
        out.push(`literal: ${JSON.stringify(c.value)}`);
        break;
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Detect `v.optional(...)` wrapping. */
function unwrapOptional(schema: unknown): { inner: unknown; isOptional: boolean } {
  if (!schema || typeof schema !== 'object') return { inner: schema, isOptional: false };
  const s = schema as { kind?: string; type?: string; wrapped?: unknown };
  if (s.kind === 'schema' && s.type === 'optional' && s.wrapped) {
    return { inner: s.wrapped, isOptional: true };
  }
  return { inner: schema, isOptional: false };
}

/** Walk the valibot schema and produce a short human-readable type label. */
function labelFor(schema: unknown, depth = 0): string {
  if (!schema || depth > 5) return 'unknown';
  const s = schema as {
    kind?: string;
    type?: string;
    item?: unknown;
    options?: unknown[];
    literal?: unknown;
    constraints?: ConstraintLike[];
    wrapped?: unknown;
    shape?: unknown;
  };
  switch (s.type) {
    case 'object':
      return 'object';
    case 'record':
      return 'record';
    case 'datetime':
      return 'datetime';
    case 'array': {
      const item = s.item;
      return `array<${labelFor(item, depth + 1)}>`;
    }
    case 'union': {
      const opts = s.options;
      return Array.isArray(opts)
        ? `one of ${opts.map((o) => labelFor(o, depth + 1)).join(' | ')}`
        : 'union';
    }
    case 'literal':
      return `literal: ${JSON.stringify(s.literal)}`;
    case 'enum':
      return 'enum';
    case 'uri':
      return 'uri';
  }
  // Primitives like `string`/`integer`/`boolean`/etc. don't have a known
  // explicit `type` value at this level — but the prototype chain or own
  // properties may carry it. Read whichever we can.
  const fromProtoOrOwn = (s as { type?: string }).type;
  if (fromProtoOrOwn && fromProtoOrOwn !== 'optional' && fromProtoOrOwn !== 'schema') {
    return fromProtoOrOwn;
  }
  // Fall back to the constraint array for primitives.
  return labelFromConstraints(s.constraints) ?? 'unknown';
}

/**
 * Resolve an object schema's `shape` and infer required-ness (anything not
 * wrapped in `v.optional(...)` is required). Returns a sorted field list.
 */
function summarizeObject(schema: unknown): SchemaSummary {
  const s = schema as { type?: string; kind?: string; shape?: Record<string, unknown> };
  if (s.type !== 'object' || !s.shape) {
    return { kind: s.kind ?? s.type ?? 'unknown', description: describe(schema) };
  }
  const names = Object.keys(s.shape).sort();
  const fields: FieldSummary[] = names.map((name) => {
    const fieldSchema = s.shape![name];
    const { inner, isOptional } = unwrapOptional(fieldSchema);
    const type = labelFor(inner);
    const description = describe(fieldSchema) ?? describe(inner);
    const constraints =
      pipeConstraints((inner as { constraints?: unknown }).constraints) ??
      pipeConstraints((fieldSchema as { constraints?: unknown }).constraints);
    const literalValue = (inner as { literal?: unknown }).literal;
    const defaultValue = literalValue !== undefined ? JSON.stringify(literalValue) : undefined;
    return { name, type, required: !isOptional, description, defaultValue, constraints };
  });
  return { kind: 'object', fields, description: describe(schema) };
}

/**
 * Top-level summary for an XRPC schema's params/output/input block.
 */
export function summarizeSchema(schema: unknown): SchemaSummary {
  if (!schema) return { kind: 'none' };
  const s = schema as { type?: string; kind?: string };
  if (s.type === 'object' || (s.kind === 'schema' && s.type === 'object')) {
    return summarizeObject(schema);
  }
  return { kind: s.kind ?? s.type ?? 'unknown', description: describe(schema) };
}

/**
 * Pull the lex errors block off a query/procedure schema.
 */
export function getErrors(schema: unknown): ErrorSummary[] {
  const errors = (schema as { errors?: Array<{ name?: string; description?: string }> })?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((e) => typeof e?.name === 'string')
    .map((e) => ({ name: e.name as string, description: e.description }));
}

/** Keys dropped from the cleaned raw-schema dump (valibot runtime noise). */
const SCHEMA_DROP_KEYS = new Set([
  '~run',
  '~standard',
  'wrapped',
  'kind',
  'default',
]);

/**
 * Strip valibot runtime noise from a schema object so the raw-schema dump
 * shows the structural shape (NSID, params, output, input, fields, types,
 * constraints) without `~run`, `~standard`, `wrapped`, `kind`, or `default`.
 *
 * Optional wrappers (`v.optional(...)`) are collapsed — the inner schema
 * replaces the wrapper so the user sees the effective type rather than the
 * two-level `wrapped: { constraints: [...] }` indirection.
 *
 * Returns a new object/array; does not mutate the input.
 */
export function cleanSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  const s = schema as Record<string, unknown>;
  // Collapse `v.optional(...)`. The outer schema wrapper carries no info
  // we want to show beyond the inner schema.
  if (s.kind === 'schema' && s.type === 'optional' && 'wrapped' in s) {
    return cleanSchema(s.wrapped);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (SCHEMA_DROP_KEYS.has(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}
