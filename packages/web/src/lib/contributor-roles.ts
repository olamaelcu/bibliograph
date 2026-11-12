/**
 * Contributor roles are ONIX Codelist 17 codes in
 * `community.lexicon.media.book.defs#contributor` (lexicon.community PR #18).
 * Rows written before the PR carry the old kebab-case tokens; map those when
 * emitting a lexicon value. The catalog column keeps both forms, so no
 * migration is needed.
 *
 * Keep in sync with `packages/worker/lib/contributor-roles.js`.
 */
export const DEFAULT_CONTRIBUTOR_ROLE = 'A01'; // By (author)

// The editor is stricter than the wire format: only the lexicon's
// `defs#contributor.role.knownValues` are accepted. Keep this list in sync
// with happyview/lexicons/community/lexicon/media/book/defs.json; the worker
// normalizer intentionally stays open for ingest.
const ONIX_ROLE_CODES = `
  A01 A02 A03 A04 A05 A06 A07 A08 A09 A10 A11 A12 A13 A14 A15 A16 A17 A18 A19 A20
  A21 A22 A23 A24 A25 A26 A27 A28 A29 A30 A31 A32 A33 A34 A35 A36 A37 A38 A39 A40
  A41 A42 A43 A44 A45 A46 A47 A48 A49 A50 A51 A52 A56 A99
  B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 B13 B14 B15 B16 B17 B18 B19 B20
  B21 B22 B23 B24 B25 B26 B27 B28 B29 B30 B31 B32 B33 B34 B35 B36 B99
  C01 C02 C03 C04 C99
  D01 D02 D03 D04 D99
  E01 E02 E03 E04 E05 E06 E07 E08 E09 E10 E11 E99
  F01 F02 F99
  Z01 Z02 Z03 Z04 Z05 Z06 Z98 Z99
`
  .trim()
  .split(/\s+/);

export const KNOWN_CONTRIBUTOR_ROLES: ReadonlySet<string> = new Set(ONIX_ROLE_CODES);

const LEGACY_CONTRIBUTOR_ROLES: Record<string, string> = {
  author: 'A01', // By (author)
  'co-author': 'A01', // ONIX has no co-author code; multiple A01s express it
  editor: 'B01', // Edited by
  translator: 'B06', // Translated by
  narrator: 'E03', // Narrator
  illustrator: 'A12', // Illustrated by
  photographer: 'A08', // By (photographer)
  foreword: 'A23', // Foreword by
  preface: 'A15', // Preface by
  penciller: 'A07', // By (artist)
  inker: 'A46', // Inker
  colorist: 'A47', // Colorist
  letterer: 'A48', // Letterer
  'posthumous-completer': 'Z05' // Posthumously completed by
};

const ONIX_CODE = /^[A-Z]\d{2}$/;

/** Canonical ONIX code for a stored or supplied contributor role. */
export function normalizeContributorRole(value: string | null | undefined): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token === '') return DEFAULT_CONTRIBUTOR_ROLE;
  if (ONIX_CODE.test(token)) return token;
  return LEGACY_CONTRIBUTOR_ROLES[token.toLowerCase()] ?? token;
}

/** Whether a stored or supplied role normalises to a lexicon-known ONIX code. */
export function isKnownContributorRole(value: string | null | undefined): boolean {
  return KNOWN_CONTRIBUTOR_ROLES.has(normalizeContributorRole(value));
}
