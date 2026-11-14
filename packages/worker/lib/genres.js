/**
 * The curated genre vocabulary.
 *
 * Providers hand back provider-shaped labels, not genres: OpenLibrary subjects
 * carry LCSH subdivisions (`Fiction, science fiction, general`), program tags
 * (`nyt:mass-market-monthly=2021-11-07`, `award:nebula_award=novel`) and
 * place/subject headings (`Dune (Imaginary place)`); Goodreads adds format
 * pseudo-genres (`Audiobook`, `Kindle Edition`). Storing those verbatim would
 * make the vocabulary unusable for browsing or filtering, so every label is
 * mapped to a canonical name through `SYNONYMS` and an unmapped label is
 * dropped rather than stored raw.
 *
 * Keys of `SYNONYMS` are canonical names; values are the normalized provider
 * labels that map to each one, and must stay unique across the whole map.
 */

/** How many canonical genres one edition may carry. */
export const MAX_GENRES_PER_EDITION = 12;

const SYNONYMS = Object.freeze({
  Fiction: ['fiction'],
  'Literary Fiction': ['literary fiction', 'literature'],
  'Science Fiction': [
    'science fiction',
    'science-fiction',
    'sci-fi',
    'sci fi',
    'science fiction & fantasy',
    'science fiction fantasy'
  ],
  Fantasy: ['fantasy', 'fantasy fiction', 'fantasy & magic'],
  Mystery: [
    'mystery',
    'mystery fiction',
    'mystery & detective',
    'mystery and detective stories',
    'detective and mystery stories',
    'detective and mystery fiction'
  ],
  Crime: ['crime', 'crime fiction'],
  Thriller: ['thriller', 'thrillers', 'suspense', 'suspense fiction', 'thriller & suspense'],
  Horror: ['horror', 'horror tales', 'horror fiction'],
  Romance: ['romance', 'romance fiction', 'romance novels', 'love stories'],
  'Historical Fiction': ['historical fiction'],
  'Historical Romance': ['historical romance'],
  Classics: ['classics', 'classic literature'],
  'Young Adult': ['young adult', 'young adult fiction', 'ya fiction'],
  "Children's": [
    "children's fiction",
    "children's stories",
    "children's literature",
    'juvenile fiction',
    'juvenile literature',
    'picture books'
  ],
  Nonfiction: ['nonfiction', 'non-fiction', 'non fiction'],
  Biography: [
    'biography',
    'biographies',
    'biography & autobiography',
    'autobiography',
    'memoir',
    'memoirs'
  ],
  History: ['history', 'world history', 'historiography'],
  Poetry: ['poetry', 'poems', 'verse'],
  Drama: ['drama', 'plays', 'play'],
  Adventure: ['adventure', 'adventure stories', 'adventure fiction', 'action & adventure'],
  'Graphic Novels': [
    'graphic novels',
    'comics',
    'comic books strips',
    'comics & graphic novels',
    'manga',
    'sequential art'
  ],
  Humor: ['humor', 'humour', 'comedy', 'humorous stories'],
  Satire: ['satire'],
  'Self Help': ['self-help', 'self help', 'personal development'],
  Philosophy: ['philosophy'],
  Psychology: ['psychology'],
  Science: ['science', 'popular science'],
  Nature: ['nature', 'natural history'],
  Business: ['business', 'economics'],
  Politics: ['politics', 'political science'],
  Sociology: ['sociology', 'anthropology'],
  Travel: ['travel', 'travel writing'],
  Cooking: ['cooking', 'cookbooks', 'cookery', 'food'],
  Art: ['art', 'art history'],
  Music: ['music'],
  Religion: ['religion', 'religious', 'spirituality'],
  Health: ['health', 'health & fitness', 'fitness'],
  Sports: ['sports'],
  Education: ['education'],
  Technology: ['technology', 'computers'],
  Essays: ['essays'],
  'Short Stories': ['short stories', 'short story collections'],
  Dystopian: ['dystopia', 'dystopian', 'dystopian fiction'],
  Paranormal: ['paranormal', 'paranormal fiction', 'supernatural'],
  'Urban Fantasy': ['urban fantasy'],
  'Space Opera': ['space opera'],
  Steampunk: ['steampunk'],
  Mythology: ['mythology', 'myths'],
  'Fairy Tales': ['fairy tales', 'folklore', 'folktales'],
  Western: ['western', 'western stories'],
  War: ['war', 'war stories'],
  'True Crime': ['true crime'],
  Contemporary: ['contemporary', 'contemporary fiction'],
  Erotica: ['erotica']
});

/** label (already normalized) -> canonical name. Built once, read-only. */
const CANONICAL = new Map();
for (const [canonical, labels] of Object.entries(SYNONYMS)) {
  for (const label of labels) CANONICAL.set(label, canonical);
}

/**
 * Normalize a provider label to the lookup form: lowercase, no trailing
 * parenthetical or program value, `/` as a list separator, collapsed
 * whitespace, no trailing punctuation.
 */
function normalizeLabel(value) {
  if (typeof value !== 'string') return undefined;
  let label = value
    .trim()
    .toLowerCase()
    // `Dune (Imaginary place)` -> `dune`: a parenthetical is a qualifier, never
    // part of the genre.
    .replace(/\s*\([^)]*\)\s*$/, '')
    // `nyt:mass-market-monthly=2021-11-07` -> `nyt:mass-market-monthly`, which
    // still misses the map and drops out.
    .split('=')[0]
    .replace(/\s*\/\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;]+$/, '');
  return label === '' ? undefined : label;
}

/**
 * The canonical genre for one provider label, or undefined when the label is
 * not part of the vocabulary.
 *
 * An exact match wins. Failing that, an LCSH subdivision is reduced to its
 * segments ordered longest first, and the first segment that is a known label
 * becomes the genre: `fiction, science fiction, general` -> `Science Fiction`,
 * `fiction, mystery & detective, general` -> `Mystery`, `fiction, romance,
 * general` -> `Romance`. Longest first because the specific subdivision
 * (`science fiction`) is the informative one and `fiction` the generic one;
 * equal lengths fall back to the later segment, since LCSH runs broad to
 * specific.
 */
export function canonicalGenre(label) {
  const normalized = normalizeLabel(label);
  if (!normalized) return undefined;

  const exact = CANONICAL.get(normalized);
  if (exact) return exact;

  if (!normalized.includes(',')) return undefined;
  const segments = normalized
    .split(',')
    .map((segment, index) => ({ text: segment.trim(), index }))
    .filter((segment) => segment.text !== '')
    // Longest first, and on a tie the later segment wins: an LCSH string runs
    // broad to specific (`fiction, romance, general`), so the trailing term is
    // the informative one when both are equally long.
    .sort((a, b) => b.text.length - a.text.length || b.index - a.index);
  for (const segment of segments) {
    const match = CANONICAL.get(segment.text);
    if (match) return match;
  }
  return undefined;
}

/**
 * Merge provider labels into one ordered, deduped, canonical list.
 *
 * Goodreads order is kept because it is the provider's own relevance order;
 * OpenLibrary and ISBNdb subject labels are alphabetical already but are sorted
 * here so the stored `position` never depends on a provider's key order. A
 * canonical name is emitted once, from whichever provider named it first.
 *
 * Every input may be undefined: the result is always an array.
 */
export function mergeGenres({ goodreads, openlibrary, isbndb } = {}) {
  const merged = [];
  const seen = new Set();

  const push = (label, source) => {
    const name = canonicalGenre(label);
    if (!name || seen.has(name)) return;
    seen.add(name);
    merged.push({ name, source });
  };

  for (const label of Array.isArray(goodreads) ? goodreads : []) push(label, 'goodreads');

  // Subject-based sources carry no relevance order, so they are appended
  // alphabetically after the ordered one and their own key order never reaches
  // the stored `position`.
  const pushSorted = (labels, source) => {
    const names = [];
    for (const label of Array.isArray(labels) ? labels : []) {
      const name = canonicalGenre(label);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) merged.push({ name, source });
  };

  pushSorted(openlibrary, 'openlibrary');
  pushSorted(isbndb, 'isbndb');

  return merged.slice(0, MAX_GENRES_PER_EDITION);
}
