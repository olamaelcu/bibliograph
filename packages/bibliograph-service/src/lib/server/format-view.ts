import { PUBLISHER_DID } from './did';

export type BookFormat =
  | 'hardcover'
  | 'paperback'
  | 'mass_market_paperback'
  | 'ebook'
  | 'audiobook'
  | 'board_book'
  | 'spiral_bound';

interface FormatMeta {
  description: string;
  emoji: string;
  unit: 'pages' | 'percent' | 'seconds';
}

const FORMATS: Record<BookFormat, FormatMeta> = {
  hardcover: { description: 'Hardcover', emoji: 'book', unit: 'pages' },
  paperback: { description: 'Paperback', emoji: 'book-open', unit: 'pages' },
  mass_market_paperback: {
    description: 'Mass Market Paperback',
    emoji: 'book-open',
    unit: 'pages',
  },
  ebook: { description: 'Ebook', emoji: 'smartphone', unit: 'percent' },
  audiobook: { description: 'Audiobook', emoji: 'headphones', unit: 'seconds' },
  board_book: { description: 'Board Book', emoji: 'book', unit: 'pages' },
  spiral_bound: { description: 'Spiral Bound', emoji: 'notebook', unit: 'pages' },
};

/**
 * Provider binding strings are free text: Open Library's `physical_format`,
 * ISBNDb's `binding`. Normalize the common spellings to the four values the
 * AppView exposes, and leave anything unrecognized out rather than inventing a
 * fifth format.
 */
export function normalizeBookFormat(
  value: string | null | undefined,
): BookFormat | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized.includes('hardcover') ||
    normalized.includes('hard back') ||
    normalized.includes('hardback')
  ) {
    return 'hardcover';
  }
  if (
    normalized.includes('mass market') ||
    normalized.includes('mass-market')
  ) {
    return 'mass_market_paperback';
  }
  if (
    normalized.includes('paperback') ||
    normalized.includes('softcover') ||
    normalized.includes('soft cover')
  ) {
    return 'paperback';
  }
  if (
    normalized.includes('ebook') ||
    normalized.includes('e-book') ||
    normalized.includes('electronic') ||
    normalized.includes('kindle')
  ) {
    return 'ebook';
  }
  if (normalized.includes('audio')) return 'audiobook';
  if (normalized.includes('board book') || normalized.includes('board-book')) {
    return 'board_book';
  }
  if (normalized.includes('spiral')) return 'spiral_bound';
  return undefined;
}

/** Build the `bookView.format` value for a stored format slug. */
export function formatViewFor(
  value: string | null | undefined,
): {
  format: string;
  uri: string;
  description: string;
  emoji: string;
  unit: string;
} | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  const known = normalizeBookFormat(raw);
  const format = known ?? raw.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!format) return undefined;
  const meta = known
    ? FORMATS[known]
    : { description: titleCase(format), emoji: 'book', unit: 'pages' as const };
  return {
    format,
    uri: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.format/${format}`,
    description: meta.description,
    emoji: meta.emoji,
    unit: meta.unit,
  };
}

function titleCase(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
