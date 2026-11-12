/**
 * Contributor roles are ONIX Codelist 17 codes in
 * `community.lexicon.media.book.defs#contributor` (lexicon.community PR #18).
 * `knownValues` lists all 124 codes from Issue 75, but the list is open, so a
 * provider-specific token is preserved unchanged instead of being rejected.
 *
 * Rows written before the PR stored the old kebab-case tokens. Those remain
 * readable: normalize them at every boundary that emits a lexicon value. The
 * catalog column keeps whatever the caller supplied, so old and new rows can
 * coexist without a database migration.
 */
export const DEFAULT_CONTRIBUTOR_ROLE = 'A01'; // By (author)

/** Legacy kebab-case tokens this catalog wrote before adopting ONIX codes. */
export const LEGACY_CONTRIBUTOR_ROLES = {
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
export function normalizeContributorRole(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token === '') return DEFAULT_CONTRIBUTOR_ROLE;
  if (ONIX_CODE.test(token)) return token;
  return LEGACY_CONTRIBUTOR_ROLES[token.toLowerCase()] ?? token;
}
