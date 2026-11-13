/*
 * ISBNdb author-name handling.
 *
 * ISBNdb's `book.authors` values are either display names ("Ursula K. Le
 * Guin") or inverted catalog names ("Le Guin, Ursula K."). Inverted values are
 * stored verbatim today, which leaves the catalog sorting on the surname while
 * displaying "Last, First". This parser owns the one place an ISBNdb author is
 * rewritten, so no other provider and no manual editor path is affected.
 *
 * The rules are deliberately conservative: a name is rewritten only when the
 * comma form is unambiguous. Organizations, multi-author strings, names with
 * dates or numbers, and multi-comma values that are not a known suffix are
 * returned as `null`, meaning "keep the provider string unchanged".
 */

// Bidi/format marks appear in provider strings (`Garvey, Marcus,‏`). They are
// invisible and never meaningful in a name.
const FORMAT_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
const NBSP = /\u00a0/g;

// Characters that mean this is not one personal name: multiple authors,
// organizations, cataloging notes or dates. Apostrophes and hyphens are name
// punctuation and are allowed. `\ufffd` is a replacement character from a
// broken encoding; a name that lost bytes cannot be normalized safely.
const UNSAFE = /[0-9;&()[\]{}\/\\<>=@#*+_|~^%$:"“”\ufffd]/;

// `nameInverted` is the normalized comma form; only whitespace and invisible
// characters are collapsed, never the name tokens themselves.
function normalize(value) {
  return value.replace(FORMAT_CHARS, '').replace(NBSP, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(part) {
  return part.split(' ').filter(Boolean);
}

// Suffixes are compared without periods or spaces: `Ph. D.`, `Ph.D.` and
// `PhD` are the same token. Roman numerals stay case-sensitive so a given name
// like `Vi` is not mistaken for a generational suffix.
const ROMAN_SUFFIX = /^(II|III|IV|V|VI)$/;
const SUFFIX_KEYS = new Set([
  'jr',
  'sr',
  'phd',
  'md',
  'esq',
  'dds',
  'dmd',
  'dvm',
  'jd',
  'rn',
  'cpa',
  'edd',
  'psyd',
  'dphil',
  'llb',
  'llm',
  'lld',
  'scd',
  'od'
]);

function compact(token) {
  return token.replace(/[\s.]/g, '');
}

function suffixOf(token) {
  if (ROMAN_SUFFIX.test(compact(token))) return token;
  return SUFFIX_KEYS.has(compact(token).toLowerCase()) ? token : undefined;
}

// Name particles. The original case is always preserved; the set is only used
// to recognize a particle trailing the given-name side (`"Andrade, Carlos
// Drummond de"`) so it can move in front of the surname. Particles already at
// the start of the surname (`"van Gogh"`, `"Le Guin"`) need no rewriting.
const PARTICLES = new Set([
  'de',
  'del',
  'della',
  'delle',
  'degli',
  'dei',
  'der',
  'den',
  'des',
  'di',
  'da',
  'dal',
  'du',
  'dos',
  'das',
  'do',
  'la',
  'le',
  'les',
  'van',
  'von',
  'ten',
  'ter',
  'bin',
  'ibn',
  'al',
  'el',
  'af',
  'av',
  'zu',
  'zum',
  'zur',
  'auf',
  'vom',
  'aan',
  'st'
]);

function particleKey(token) {
  return compact(token).toLowerCase();
}

function isParticle(token) {
  return PARTICLES.has(particleKey(token));
}

// A token that looks like a surname in a corporate/institutional name. Checked
// on the given-name side, where these tokens appear in provider strings such as
// `"Institute of Electrical and Electronics Engineers, Inc. Staff"`. The
// surname side is not checked: `"Press, Eyal"` is a real person.
const ORGANIZATION_KEYS = new Set([
  'inc',
  'llc',
  'ltd',
  'co',
  'corp',
  'corporation',
  'company',
  'press',
  'books',
  'book',
  'publishing',
  'publishers',
  'publisher',
  'media',
  'group',
  'association',
  'society',
  'institute',
  'institution',
  'university',
  'college',
  'school',
  'faculty',
  'department',
  'dept',
  'committee',
  'council',
  'board',
  'ministry',
  'agency',
  'services',
  'studio',
  'studios',
  'editions',
  'verlag',
  'gmbh',
  'plc',
  'staff',
  'editors',
  'editor',
  'foundation',
  'trust',
  'partners',
  'partnership',
  'limited',
  'llp'
]);

function isOrganizationToken(token) {
  return ORGANIZATION_KEYS.has(compact(token).toLowerCase());
}

// Institutional names whose first comma segment is the organization: `"Books,
// Hephaestus"`, `"Publishing, Workwoman"`. Narrow on purpose: `"Press, Eyal"`
// is a person and even `"Book, John"` exists.
const ORGANIZATION_SURNAME_KEYS = new Set([
  'books',
  'publishing',
  'publishers',
  'publisher',
  'editions',
  'verlag',
  'staff',
  'editors'
]);

// Titles belong before a given name, never after it in a comma form. `"Hoby,
// Thomas Sir"` is a cataloging artifact, not `"Thomas Sir Hoby"`.
const TITLE_KEYS = new Set([
  'sir',
  'dame',
  'lady',
  'lord',
  'saint',
  'dr',
  'doctor',
  'prof',
  'professor',
  'rev',
  'reverend'
]);

function isTitleToken(token) {
  return TITLE_KEYS.has(compact(token).toLowerCase());
}

// Tokens that signal a concatenated or collective author list rather than a
// personal name. `"Smith, John et al."` must not become `"John et al. Smith"`.
const NON_NAME_TOKENS = new Set(['et', 'and', 'others', 'various', 'anonymous', 'unknown']);

function isNonNameToken(token) {
  return NON_NAME_TOKENS.has(compact(token).toLowerCase());
}

// A single name token: starts with a letter, then letters, combining marks,
// apostrophes, hyphens or a trailing abbreviation period. `W.`, `O'Brien`,
// `Phillips-Fein` and `St.` pass; `1939-`, `(Jr.)` and `Inc` would too but are
// filtered elsewhere where relevant.
const NAME_TOKEN = /^\p{L}[\p{L}\p{M}'’.\-]*$/u;

function isNameToken(token) {
  return NAME_TOKEN.test(token);
}

// `K.` and `J.R.` are initials; `James.` is a word with a stray period and the
// name is too malformed to reorder (`"Pope-Hennessy, James."`).
const INITIAL = /^\p{L}\.$/u;
const DOTTED_INITIALS = /^(?:\p{L}\.){2,}$/u;

function hasMalformedTrailingPeriod(tokens) {
  const last = tokens[tokens.length - 1] ?? '';
  if (!last.endsWith('.')) return false;
  return !INITIAL.test(last) && !DOTTED_INITIALS.test(last);
}

/**
 * Parse one ISBNdb author string.
 *
 * @param {unknown} value
 * @returns {{name: string, nameInverted: string} | null} `null` when the value
 *   is not an unambiguous inverted personal name and must stay as-is.
 */
export function parseIsbndbAuthor(value) {
  if (typeof value !== 'string') return null;
  const normalized = normalize(value);
  if (normalized === '' || !normalized.includes(',')) return null;
  if (UNSAFE.test(normalized)) return null;
  // `"Vatsyayana , A.N.D. Haksar"` has a translator appended, not a name.
  if (normalized.includes(' ,')) return null;

  // Empty segments can only come from stray commas or stripped invisible
  // characters (`"Garvey, Marcus,‏"`); they carry no name information.
  const parts = normalized
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const surnameTokens = tokens(parts[0]);
  if (surnameTokens.length === 0) return null;
  if (surnameTokens.some((token) => !isNameToken(token) || isNonNameToken(token))) return null;
  if (
    surnameTokens.length === 1 &&
    ORGANIZATION_SURNAME_KEYS.has(compact(surnameTokens[0]).toLowerCase())
  ) {
    return null;
  }
  if (suffixOf(surnameTokens[0]) || surnameTokens.slice(1).some((token) => suffixOf(token))) {
    // A suffix before the given name (`"Jr., John"`, `"King Jr., Martin"`) is
    // malformed; leave it for a human rather than reordering it.
    return null;
  }

  const suffixes = [];
  const givenSegments = [];
  for (const part of parts.slice(1)) {
    const suffix = suffixOf(part);
    if (suffix !== undefined) {
      suffixes.push(suffix);
    } else {
      givenSegments.push(part);
    }
  }
  // More than one given-name segment is ambiguous (`"Smith, John, Mary"`,
  // `"Takaki, Ronald T., 1939-"`). Dates and cataloger notes are already
  // rejected by UNSAFE; the rest is left alone.
  if (givenSegments.length !== 1) return null;

  const givenTokens = tokens(givenSegments[0]);
  if (givenTokens.length === 0) return null;
  if (
    givenTokens.some(
      (token) =>
        !isNameToken(token) ||
        isOrganizationToken(token) ||
        isNonNameToken(token) ||
        isTitleToken(token)
    )
  ) {
    return null;
  }

  // A suffix inside the given-name side (`"King, Martin Luther Jr."`) moves
  // after the surname like a comma-separated one.
  while (givenTokens.length > 1) {
    const suffix = suffixOf(givenTokens[givenTokens.length - 1]);
    if (suffix === undefined) break;
    suffixes.unshift(suffix);
    givenTokens.pop();
  }
  if (givenTokens.some((token) => suffixOf(token))) return null;
  if (hasMalformedTrailingPeriod(givenTokens)) return null;

  // Trailing particles belong to the surname: `"Andrade, Carlos Drummond de"`
  // becomes `"Carlos Drummond de Andrade"`. Keep at least one given-name token
  // so a surname-less value such as `"Waal, de"` is not mangled.
  const movedParticles = [];
  while (givenTokens.length > 1) {
    const last = givenTokens[givenTokens.length - 1];
    if (!isParticle(last)) break;
    const first = surnameTokens[0];
    if (isParticle(first) && particleKey(first) === particleKey(last)) {
      // `"van Berg, Jan van"` already has the particle in front.
      givenTokens.pop();
      continue;
    }
    movedParticles.unshift(last);
    givenTokens.pop();
  }
  if (givenTokens.length === 0) return null;
  surnameTokens.unshift(...movedParticles);

  const display = [...givenTokens, ...surnameTokens, ...suffixes].join(' ');
  if (display === '') return null;

  return { name: display, nameInverted: parts.join(', ') };
}
