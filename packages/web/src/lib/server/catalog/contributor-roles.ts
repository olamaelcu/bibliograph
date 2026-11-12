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
