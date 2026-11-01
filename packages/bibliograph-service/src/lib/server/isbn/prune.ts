import type { EditionItem } from '../search/types';
import { isbnFromIdentifier, normaliseIsbn } from './merge';

/**
 * Pruning a search result down to the ISBN that belongs to *this* edition.
 *
 * A title search returns the whole print history: hardbacks, paperbacks,
 * reissues, translations, study guides. Each of those has its own ISBN, so the
 * question is never "which ISBN is for this book" but "which candidate record
 * is the same edition". The gates below are deliberately narrow — a wrong ISBN
 * is worse than no ISBN, because it makes a reader's shelf point at a
 * different physical object.
 *
 * A candidate survives only when every known field agrees. When two ISBNs
 * survive at the same score the answer is `ambiguous` and nothing is written.
 */

export interface TargetEdition {
  title: string;
  /** Contributor names of record; empty means "cannot verify" (see below). */
  authors: readonly string[];
  publishedYear?: number | null;
  pages?: number | null;
}

export interface CandidateBook {
  source: string;
  title?: string;
  authors?: readonly string[];
  publishedYear?: number | null;
  pages?: number | null;
  isbns: readonly string[];
}

export interface ScoredCandidate {
  source: string;
  isbn: string;
  title?: string;
  score: number;
  accepted: boolean;
  /** Why it was dropped; absent when accepted. */
  reject?: string;
}

export type PruneKind = 'found' | 'ambiguous' | 'none';

export interface PruneResult {
  kind: PruneKind;
  /** Set only when exactly one ISBN survived at the top score. */
  isbn?: string;
  survivors: ScoredCandidate[];
  rejected: ScoredCandidate[];
}

const ARTICLES: Record<string, true> = { a: true, an: true, the: true };

/** Strip accents so "Brontë" and "Bronte" compare equal. */
function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Reduce a title to what two providers can agree on: no accents, no
 * punctuation, no leading article, no subtitle, single-spaced, lowercase.
 *
 * Subtitles are cut at `:`/`;`/`(` — the markers providers actually use — and
 * deliberately *not* at a dash: "Author — Title" and "Title — Subtitle" are
 * indistinguishable, and a wrong cut would make two different books compare
 * equal. Leaving the dash in only ever causes a safe mismatch.
 */
export function normaliseTitle(raw: string): string {
  const withoutSubtitle = raw.split(/[:;(]/)[0] ?? raw;
  const words = stripDiacritics(withoutSubtitle)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && ARTICLES[words[0]!] === true) words.shift();
  return words.join(' ');
}

/** Surname-ish tokens of a contributor name: last word, plus a particle form. */
export function surnameTokens(raw: string): string[] {
  const parts = stripDiacritics(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return [];
  const surname = parts[parts.length - 1]!;
  // "Ursula K. Le Guin" → the last token is `guin` and `le` is the particle.
  if (parts.length >= 3 && parts[parts.length - 2]!.length <= 3) {
    return [surname, `${parts[parts.length - 2]} ${surname}`];
  }
  return [surname];
}

/** Levenshtein distance, giving up once it exceeds `cap`. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Score one candidate record against the edition we are enriching.
 *
 * 4 = title matches exactly after normalisation, 3 = one edit away, 2 = two
 * edits away, 0 = reject. Only candidates with a score go on to the field gates.
 */
export function scoreCandidate(
  target: TargetEdition,
  candidate: CandidateBook,
): Omit<ScoredCandidate, 'isbn'> & { isbn?: string } {
  const isbn = candidate.isbns
    .map(normaliseIsbn)
    .find((value) => value.length === 13 || value.length === 10);
  if (!isbn) {
    return { source: candidate.source, title: candidate.title, score: 0, accepted: false, reject: 'no_isbn' };
  }

  if (!candidate.title) {
    return { source: candidate.source, isbn, score: 0, accepted: false, reject: 'no_title' };
  }

  const targetTitle = normaliseTitle(target.title);
  const candidateTitle = normaliseTitle(candidate.title);
  const distance = editDistance(targetTitle, candidateTitle, 2);
  const score = distance === 0 ? 4 : distance === 1 ? 3 : distance === 2 ? 2 : 0;
  if (score === 0) {
    return { source: candidate.source, isbn, title: candidate.title, score, accepted: false, reject: 'title_mismatch' };
  }

  // An author is required: unrelated books share titles far more often than they
  // share an author. Without a name to compare we cannot tell, and "cannot tell"
  // must never turn into a written ISBN.
  const targetSurnames = new Set(target.authors.flatMap(surnameTokens));
  if (targetSurnames.size === 0) {
    return { source: candidate.source, isbn, title: candidate.title, score, accepted: false, reject: 'author_unknown' };
  }
  const candidateSurnames = new Set((candidate.authors ?? []).flatMap(surnameTokens));
  const overlap = [...targetSurnames].some((surname) => candidateSurnames.has(surname));
  if (!overlap) {
    return { source: candidate.source, isbn, title: candidate.title, score, accepted: false, reject: 'author_mismatch' };
  }

  if (target.publishedYear && candidate.publishedYear) {
    const delta = Math.abs(target.publishedYear - candidate.publishedYear);
    if (delta > 1) {
      return {
        source: candidate.source,
        isbn,
        title: candidate.title,
        score,
        accepted: false,
        reject: `year_delta_${delta}`,
      };
    }
  }

  // Page count is a strong edition-level signal when both sides have it.
  if (target.pages && candidate.pages) {
    const ratio = Math.abs(target.pages - candidate.pages) / target.pages;
    if (ratio > 0.1) {
      return { source: candidate.source, isbn, title: candidate.title, score, accepted: false, reject: 'pages_mismatch' };
    }
  }

  return { source: candidate.source, isbn, title: candidate.title, score, accepted: true };
}

/**
 * Reduce a candidate set to at most one ISBN.
 *
 * Survivors are grouped by ISBN and keep their best score. A single ISBN at the
 * top score is `found`; a tie at the top is `ambiguous` — the caller records it
 * for review instead of guessing.
 */
export function pruneCandidates(target: TargetEdition, candidates: readonly CandidateBook[]): PruneResult {
  const scored = candidates.map((candidate) => scoreCandidate(target, candidate));
  const rejected = scored.filter((candidate) => !candidate.accepted) as ScoredCandidate[];
  const accepted = scored.filter(
    (candidate): candidate is ScoredCandidate & { isbn: string } =>
      candidate.accepted && typeof candidate.isbn === 'string',
  );

  if (accepted.length === 0) return { kind: 'none', survivors: [], rejected };

  const bestByIsbn = new Map<string, ScoredCandidate>();
  for (const candidate of accepted) {
    const previous = bestByIsbn.get(candidate.isbn);
    if (!previous || candidate.score > previous.score) bestByIsbn.set(candidate.isbn, candidate);
  }
  const survivors = [...bestByIsbn.values()].sort((a, b) => b.score - a.score);
  const top = survivors[0]!.score;
  const atTop = survivors.filter((candidate) => candidate.score === top);

  if (atTop.length === 1) return { kind: 'found', isbn: atTop[0]!.isbn, survivors, rejected };
  return { kind: 'ambiguous', survivors, rejected };
}

/**
 * Turn a search hit into a candidate.
 *
 * `names` maps contributor uri → name: the search mappers store contributors as
 * strong refs, so the names have to come from the contributors table.
 */
export function candidateFromEditionItem(
  source: string,
  item: EditionItem,
  names: ReadonlyMap<string, string>,
): CandidateBook {
  return {
    source,
    title: item.title,
    authors: (item.contributors ?? [])
      .map((contribution) => names.get(contribution.subject?.uri ?? ''))
      .filter((name): name is string => typeof name === 'string'),
    publishedYear: item.publishedYear ?? null,
    isbns: (item.identifiers ?? [])
      .map((identifier) => isbnFromIdentifier(identifier))
      .filter((value): value is string => value !== null),
  };
}
