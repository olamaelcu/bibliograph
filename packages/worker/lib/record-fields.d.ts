/**
 * Declarations for `record-fields.js`, which is plain JavaScript.
 *
 * The web package imports `canonicalIdentifiersJson` (the stored form of an
 * entity's identifier bag), and its `checkJs` would otherwise type-check the
 * module. Keep these signatures in step with the implementation; the worker
 * itself runs the `.js` and never reads this file.
 */

export type Identifier = { issuer: string; value: string; url?: string };

export function nonEmptyString(value: unknown): string | undefined;

export function clippedText(
  value: unknown,
  options: { maxGraphemes: number; maxBytes: number }
): string | undefined;

export function identifier(value: unknown): Identifier | undefined;

export function identifierArray(value: unknown): Identifier[];

export function canonicalIdentifiers(value: unknown): Identifier[];

export function canonicalIdentifiersJson(value: unknown): string;

export function httpUrl(value: unknown): string | undefined;

export function isoCalendarDate(value: unknown): string | undefined;

export function createdAtIso(value: string | number | Date): string | undefined;
