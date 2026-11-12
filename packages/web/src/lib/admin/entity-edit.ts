/**
 * Validation for the admin contributor and publisher editors, shared by the
 * browser form and the server write path.
 *
 * Runtime imports stay relative and extension-explicit so node's test runner
 * can load this module without SvelteKit aliases. The rules mirror the worker's
 * `record-fields.js`, which is the publish-time authority: a non-empty display
 * name, bounded strings, unique non-empty identifier pairs, an http(s) image
 * URL and a full, real `YYYY-MM-DD` calendar date. Limits are reused from the
 * edition editor so both admin forms bound the shared fields identically.
 */

import { EDITION_EDIT_LIMITS } from './edition-edit.ts';

export type EntityKind = 'contributor' | 'publisher';

export type EntityEditIdentifier = { issuer: string; value: string };

export type ContributorEditInput = {
  name: string;
  nameInverted: string | null;
  identifiers: EntityEditIdentifier[];
  description: string | null;
  imageUrl: string | null;
  born: string | null;
  died: string | null;
  expectedRevision: string | null;
};

export type PublisherEditInput = {
  name: string;
  identifiers: EntityEditIdentifier[];
  description: string | null;
  imageUrl: string | null;
  started: string | null;
  ended: string | null;
  expectedRevision: string | null;
};

export type EntityEditInput = ContributorEditInput | PublisherEditInput;

export type EntityEditIssue = { path: string; message: string };
export type EntityEditParse<T extends EntityEditInput = EntityEditInput> = {
  errors: EntityEditIssue[];
  value: T | null;
};

export const ENTITY_EDIT_LIMITS = {
  name: EDITION_EDIT_LIMITS.name,
  nameInverted: EDITION_EDIT_LIMITS.name,
  description: EDITION_EDIT_LIMITS.description,
  imageUrl: EDITION_EDIT_LIMITS.coverUrl,
  date: 10,
  identifierIssuer: EDITION_EDIT_LIMITS.identifierIssuer,
  identifierValue: EDITION_EDIT_LIMITS.identifierValue,
  maxIdentifiers: EDITION_EDIT_LIMITS.maxEntityIdentifiers,
  expectedRevision: 128
} as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A full `YYYY-MM-DD` calendar date, or null.
 *
 * Rejects a partial date, a non-zero-padded one, and a syntactically valid but
 * impossible one (`2023-02-29`, `2024-13-01`, `2024-00-10`). The algorithm is
 * the worker's `isoCalendarDate`: `setUTCFullYear` keeps years below 100 out of
 * the 1900s so validation matches what publication will accept.
 */
export function strictCalendarDate(value: string): string | null {
  const text = value.trim();
  if (text === '') return null;
  const match = ISO_DATE.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
}

/**
 * Parse a browser- or API-supplied contributor or publisher edit body. Every
 * issue is collected so the form can highlight fields; the server rejects the
 * body when any remain.
 */
export function parseEntityEdit(
  kind: 'contributor',
  body: unknown
): EntityEditParse<ContributorEditInput>;
export function parseEntityEdit(
  kind: 'publisher',
  body: unknown
): EntityEditParse<PublisherEditInput>;
export function parseEntityEdit(
  kind: EntityKind,
  body: unknown
): EntityEditParse<EntityEditInput>;
export function parseEntityEdit(
  kind: EntityKind,
  body: unknown
): EntityEditParse<EntityEditInput> {
  const errors: EntityEditIssue[] = [];
  const issue = (path: string, message: string): void => {
    errors.push({ path, message });
  };

  function text(
    value: unknown,
    path: string,
    max: number,
    required = false
  ): string | null {
    if (value === undefined || value === null) {
      if (required) issue(path, 'is required');
      return null;
    }
    if (typeof value !== 'string') {
      issue(path, 'must be a string');
      return null;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      if (required) issue(path, 'is required');
      return null;
    }
    if (trimmed.length > max) {
      issue(path, `must be at most ${max} characters`);
      return null;
    }
    return trimmed;
  }

  function identifiers(value: unknown, path: string): EntityEditIdentifier[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      issue(path, 'must be an array of identifiers');
      return [];
    }
    if (value.length > ENTITY_EDIT_LIMITS.maxIdentifiers) {
      issue(path, `must contain at most ${ENTITY_EDIT_LIMITS.maxIdentifiers} identifiers`);
      return [];
    }
    const result: EntityEditIdentifier[] = [];
    const seen = new Set<string>();
    value.forEach((entry, index) => {
      const at = `${path}.${index}`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        issue(at, 'must be an identifier object');
        return;
      }
      const issuer = text(
        entry.issuer,
        `${at}.issuer`,
        ENTITY_EDIT_LIMITS.identifierIssuer,
        true
      );
      const id = text(entry.value, `${at}.value`, ENTITY_EDIT_LIMITS.identifierValue, true);
      if (issuer === null || id === null) return;
      const key = `${issuer}\u0000${id}`;
      if (seen.has(key)) {
        issue(at, 'duplicates another identifier');
        return;
      }
      seen.add(key);
      result.push({ issuer, value: id });
    });
    return result;
  }

  function image(value: unknown, path: string): string | null {
    const url = text(value, path, ENTITY_EDIT_LIMITS.imageUrl);
    if (url === null) return null;
    let protocol: string | null = null;
    try {
      protocol = new URL(url).protocol;
    } catch {
      issue(path, 'must be an absolute http(s) URL');
    }
    if (protocol !== null && protocol !== 'http:' && protocol !== 'https:') {
      issue(path, 'must be an http(s) URL');
      return null;
    }
    return url;
  }

  function date(value: unknown, path: string): string | null {
    const raw = text(value, path, ENTITY_EDIT_LIMITS.date);
    if (raw === null) return null;
    const parsed = strictCalendarDate(raw);
    if (parsed === null) {
      issue(path, 'must be a real calendar date in YYYY-MM-DD format');
      return null;
    }
    return parsed;
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ path: '', message: 'request body must be an object' }], value: null };
  }

  const fields = body as Record<string, unknown>;
  const name = text(fields.name, 'name', ENTITY_EDIT_LIMITS.name, true);
  const entityIdentifiers = identifiers(fields.identifiers, 'identifiers');
  const description = text(fields.description, 'description', ENTITY_EDIT_LIMITS.description);
  const imageUrl = image(fields.imageUrl, 'imageUrl');
  const expectedRevision = text(
    fields.expectedRevision,
    'expectedRevision',
    ENTITY_EDIT_LIMITS.expectedRevision
  );

  let value: EntityEditInput;
  if (kind === 'contributor') {
    value = {
      name: name as string,
      nameInverted: text(fields.nameInverted, 'nameInverted', ENTITY_EDIT_LIMITS.nameInverted),
      identifiers: entityIdentifiers,
      description,
      imageUrl,
      born: date(fields.born, 'born'),
      died: date(fields.died, 'died'),
      expectedRevision
    };
  } else {
    value = {
      name: name as string,
      identifiers: entityIdentifiers,
      description,
      imageUrl,
      started: date(fields.started, 'started'),
      ended: date(fields.ended, 'ended'),
      expectedRevision
    };
  }

  if (errors.length > 0) return { errors, value: null };
  return { errors: [], value };
}
