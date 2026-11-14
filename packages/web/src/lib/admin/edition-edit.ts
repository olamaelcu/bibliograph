/**
 * Validation for the admin edition editor, shared by the browser form and the
 * server write path. Runtime imports stay relative and extension-explicit so
 * node's test runner can load this module without SvelteKit aliases.
 */

import { isKnownContributorRole, normalizeContributorRole } from '../contributor-roles.ts';

export type EditionEditIdentifierInfo = {
  format: string | null;
  language: string | null;
  publishedDate: string | null;
  pages: number | null;
  description: string | null;
};

export type EditionEditIdentifier = {
  issuer: string;
  value: string;
  /** Absent = leave any stored claim untouched; null or all-empty = clear it. */
  info?: EditionEditIdentifierInfo | null;
  /** Absent = leave the stored publisher links untouched; `[]` clears them. */
  publishers?: EditionEditPublisher[];
};

export type EditionEditContributor = {
  id: number | null;
  name: string | null;
  identifiers: EditionEditIdentifier[];
  role: string;
  ref: string | null;
};

export type EditionEditPublisher = {
  id: number | null;
  name: string | null;
  identifiers: EditionEditIdentifier[];
};

export type EditionEditSeries = { name: string; position?: string; display?: string };

export type EditionEditInput = {
  title: string;
  subtitle: string | null;
  durationSeconds: number | null;
  chapters: number | null;
  series: EditionEditSeries | null;
  bookEdition: string | null;
  coverUrl: string | null;
  identifiers: EditionEditIdentifier[];
  contributors: EditionEditContributor[];
  expectedRevision: string | null;
};

export type EditionEditIssue = { path: string; message: string };
export type EditionEditParse = { errors: EditionEditIssue[]; value: EditionEditInput | null };

export const EDITION_EDIT_LIMITS = {
  title: 500,
  subtitle: 500,
  language: 35,
  format: 100,
  bookEdition: 200,
  description: 20_000,
  coverUrl: 2_048,
  seriesName: 300,
  seriesPosition: 50,
  seriesDisplay: 100,
  name: 300,
  identifierIssuer: 100,
  identifierValue: 500,
  ref: 2_048,
  maxInteger: 2_147_483_647,
  maxIdentifiers: 50,
  maxContributors: 100,
  maxPublishers: 20,
  maxEntityIdentifiers: 50
} as const;

/** YYYY, YYYY-MM or YYYY-MM-DD, as the lexicon's publishedDate permits. */
const PUBLISHED_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const AT_URI = /^at:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+$/;
// Structural BCP 47 well-formedness: a 2–8 letter primary language subtag,
// optional script/region/variants/extensions/private use, or private use
// alone. Intl.getCanonicalLocales is still the authority for canonicalisation
// and rejects forms it cannot parse. This checks well-formedness, not IANA
// registration: a syntactically valid but unregistered word such as
// "English" canonicalises to "english" and is accepted.
const BCP47_TAG =
  /^(?:[a-z]{2,8}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?|x(?:-[a-z0-9]{1,8})+)$/i;
const BCP47_ERROR =
  'must be a well-formed BCP 47 language tag such as en, en-US or zh-Hant-TW';

function publishedDateProblem(value: string): string | null {
  if (!PUBLISHED_DATE.test(value)) return 'use YYYY, YYYY-MM or YYYY-MM-DD';
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || year < 1000) return 'year must be four digits';
  if (month === undefined) return null;
  if (day === undefined) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return 'that calendar day does not exist';
  }
  return null;
}

/**
 * Parse a browser- or API-supplied edit body. Every issue is collected so the
 * form can highlight fields; the server rejects the body when any remain.
 */
export function parseEditionEdit(body: unknown): EditionEditParse {
  const errors: EditionEditIssue[] = [];
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

  function integer(value: unknown, path: string): number | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : Number.NaN;
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > EDITION_EDIT_LIMITS.maxInteger
    ) {
      issue(path, `must be a non-negative integer up to ${EDITION_EDIT_LIMITS.maxInteger}`);
      return null;
    }
    return parsed;
  }

  function entityId(value: unknown, path: string): number | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      issue(path, 'must be a positive row id');
      return null;
    }
    return parsed;
  }

  /** Domain-keyed language tag: canonical BCP 47 or an issue on `path`. */
  function languageTag(value: unknown, path: string): string | null {
    const raw = text(value, path, EDITION_EDIT_LIMITS.language);
    if (raw === null) return null;
    if (!BCP47_TAG.test(raw)) {
      issue(path, BCP47_ERROR);
      return null;
    }
    try {
      const canonical = Intl.getCanonicalLocales(raw)[0];
      if (canonical === undefined) {
        issue(path, BCP47_ERROR);
        return null;
      }
      return canonical;
    } catch {
      issue(path, BCP47_ERROR);
      return null;
    }
  }

  function publishedDateField(value: unknown, path: string): string | null {
    const raw = text(value, path, 10);
    if (raw === null) return null;
    const problem = publishedDateProblem(raw);
    if (problem !== null) {
      issue(path, problem);
      return null;
    }
    return raw;
  }

  /**
   * One identifier's shape claim. `undefined` keeps the stored claim (the key is
   * left out of the result), `null` clears it and an object replaces it field by
   * field — the write path diffs the three cases.
   */
  function identifierInfo(
    value: unknown,
    path: string
  ): EditionEditIdentifierInfo | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      issue(path, 'must be an object or null');
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return {
      format: text(record.format, `${path}.format`, EDITION_EDIT_LIMITS.format),
      language: languageTag(record.language, `${path}.language`),
      publishedDate: publishedDateField(record.publishedDate, `${path}.publishedDate`),
      pages: integer(record.pages, `${path}.pages`),
      description: text(record.description, `${path}.description`, EDITION_EDIT_LIMITS.description)
    };
  }

  /**
   * One identifier's publisher links. Absent keeps the stored links; an array
   * replaces them, and an empty array clears them.
   */
  function publisherList(value: unknown, path: string): EditionEditPublisher[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      issue(path, 'must be an array');
      return undefined;
    }
    if (value.length > EDITION_EDIT_LIMITS.maxPublishers) {
      issue(path, `must contain at most ${EDITION_EDIT_LIMITS.maxPublishers} publishers`);
      return undefined;
    }
    const result: EditionEditPublisher[] = [];
    value.forEach((entry, index) => {
      const at = `${path}.${index}`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        issue(at, 'must be a publisher object');
        return;
      }
      const publisher = entry as Record<string, unknown>;
      const id = entityId(publisher.id, `${at}.id`);
      const name =
        id === null ? text(publisher.name, `${at}.name`, EDITION_EDIT_LIMITS.name, true) : null;
      const publisherIdentifiers =
        publisher.identifiers === undefined
          ? []
          : identifiers(
              publisher.identifiers,
              `${at}.identifiers`,
              EDITION_EDIT_LIMITS.maxEntityIdentifiers
            );
      result.push({ id, name, identifiers: publisherIdentifiers });
    });
    return result;
  }

  function identifiers(
    value: unknown,
    path: string,
    maxCount: number,
    required = false
  ): EditionEditIdentifier[] {
    if (!Array.isArray(value)) {
      if (required) issue(path, 'must be an array with at least one identifier');
      return [];
    }
    if (value.length > maxCount) {
      issue(path, `must contain at most ${maxCount} identifiers`);
      return [];
    }
    const result: EditionEditIdentifier[] = [];
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
        EDITION_EDIT_LIMITS.identifierIssuer,
        true
      );
      const value = text(
        entry.value,
        `${at}.value`,
        EDITION_EDIT_LIMITS.identifierValue,
        true
      );
      if (issuer === null || value === null) return;
      const key = `${issuer}\u0000${value}`;
      if (seen.has(key)) {
        issue(at, 'duplicates another identifier');
        return;
      }
      seen.add(key);
      const info = identifierInfo(entry.info, `${at}.info`);
      const publishers = publisherList(entry.publishers, `${at}.publishers`);
      result.push({
        issuer,
        value,
        ...(info === undefined ? {} : { info }),
        ...(publishers === undefined ? {} : { publishers })
      });
    });
    if (required && result.length === 0 && errors.every((error) => !error.path.startsWith(path))) {
      issue(path, 'must contain at least one identifier');
    }
    return result;
  }

  function role(value: unknown, path: string): string {
    const normalized = normalizeContributorRole(typeof value === 'string' ? value : '');
    if (!isKnownContributorRole(normalized))
      issue(path, 'must be a known ONIX Codelist 17 code (for example A01, B06 or E03)');
    return normalized;
  }

  function ref(value: unknown, path: string): string | null {
    const valueText = text(value, path, EDITION_EDIT_LIMITS.ref);
    if (valueText === null) return null;
    if (!AT_URI.test(valueText)) {
      issue(path, 'must be an at:// record URI');
      return null;
    }
    return valueText;
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ path: '', message: 'request body must be an object' }], value: null };
  }

  const fields = body as Record<string, unknown>;
  const title = text(fields.title, 'title', EDITION_EDIT_LIMITS.title, true);
  const subtitle = text(fields.subtitle, 'subtitle', EDITION_EDIT_LIMITS.subtitle);
  const bookEdition = text(fields.bookEdition, 'bookEdition', EDITION_EDIT_LIMITS.bookEdition);
  const coverUrl = text(fields.coverUrl, 'coverUrl', EDITION_EDIT_LIMITS.coverUrl);
  if (coverUrl !== null) {
    let protocol: string | null = null;
    try {
      protocol = new URL(coverUrl).protocol;
    } catch {
      issue('coverUrl', 'must be an absolute http(s) URL');
    }
    if (protocol !== null && protocol !== 'http:' && protocol !== 'https:') {
      issue('coverUrl', 'must be an http(s) URL');
    }
  }

  const durationSeconds = integer(fields.durationSeconds, 'durationSeconds');
  const chapters = integer(fields.chapters, 'chapters');

  let series: EditionEditSeries | null = null;
  if (fields.series !== undefined && fields.series !== null) {
    const rawSeries = fields.series;
    if (rawSeries === null || typeof rawSeries !== 'object' || Array.isArray(rawSeries)) {
      issue('series', 'must be an object with a name');
    } else {
      const seriesFields = rawSeries as Record<string, unknown>;
      const name = text(seriesFields.name, 'series.name', EDITION_EDIT_LIMITS.seriesName);
      const position = text(
        seriesFields.position,
        'series.position',
        EDITION_EDIT_LIMITS.seriesPosition
      );
      const display = text(
        seriesFields.display,
        'series.display',
        EDITION_EDIT_LIMITS.seriesDisplay
      );
      if (name === null) {
        if (position !== null || display !== null) issue('series.name', 'is required');
      } else {
        series = {
          name,
          ...(position !== null ? { position } : {}),
          ...(display !== null ? { display } : {})
        };
      }
    }
  }

  const editionIdentifiers = identifiers(
    fields.identifiers,
    'identifiers',
    EDITION_EDIT_LIMITS.maxIdentifiers,
    true
  );

  const contributors: EditionEditContributor[] = [];
  if (!Array.isArray(fields.contributors)) {
    issue('contributors', 'must be an array with at least one contributor');
  } else if (fields.contributors.length === 0) {
    issue('contributors', 'must contain at least one contributor');
  } else if (fields.contributors.length > EDITION_EDIT_LIMITS.maxContributors) {
    issue(
      'contributors',
      `must contain at most ${EDITION_EDIT_LIMITS.maxContributors} contributors`
    );
  } else {
    fields.contributors.forEach((entry, index) => {
      const at = `contributors.${index}`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        issue(at, 'must be a contributor object');
        return;
      }
      const contributor = entry as Record<string, unknown>;
      const id = entityId(contributor.id, `${at}.id`);
      const name =
        id === null
          ? text(contributor.name, `${at}.name`, EDITION_EDIT_LIMITS.name, true)
          : text(contributor.name, `${at}.name`, EDITION_EDIT_LIMITS.name);
      const contributorRole = role(contributor.role, `${at}.role`);
      const contributorRef = ref(contributor.ref, `${at}.ref`);
      const contributorIdentifiers =
        contributor.identifiers === undefined
          ? []
          : identifiers(
              contributor.identifiers,
              `${at}.identifiers`,
              EDITION_EDIT_LIMITS.maxEntityIdentifiers
            );
      contributors.push({
        id,
        name,
        identifiers: contributorIdentifiers,
        role: contributorRole,
        ref: contributorRef
      });
    });
  }

  const expectedRevision = text(fields.expectedRevision, 'expectedRevision', 128);

  if (errors.length > 0) return { errors, value: null };

  return {
    errors: [],
    value: {
      title: title as string,
      subtitle,
      durationSeconds,
      chapters,
      series,
      bookEdition,
      coverUrl,
      identifiers: editionIdentifiers,
      contributors,
      expectedRevision
    }
  };
}
