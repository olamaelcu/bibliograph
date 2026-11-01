// Presentation-free helpers shared by the record detail pages
// (editions, works, contributors).
//
// The pages render the same skeleton — hero, metadata card, label toggle — so
// the shapes used to feed them live here once. Anything that only one kind can
// produce (edition cover, work subjects, contributor lifespan) stays in that
// page and is passed in as data.

import type {
  ContributorValue,
  Contribution,
  DetailValue,
  EditionValue,
  Identifier,
  PublisherValue,
  WorkValue,
} from "$lib/types/record-detail";

/** A pill in the hero: neutral tags by default, `danger` renders a badge. */
export type Chip = { label: string; tone?: "neutral" | "brand" | "danger" };

/** Someone shown in the hero byline — avatar initials plus their role. */
export type Person = { uri: string; role?: string };

/**
 * One row of a metadata column. `meta` renders as `<code>` before the text, so
 * a contributor reads "author · ol.A396182A".
 */
export type BodyItem = {
  text: string;
  href?: string;
  code?: boolean;
  initials?: string;
  meta?: string;
};

export type BodyColumn = { title: string; items: BodyItem[]; empty?: string };

/** Record key of an at:// URI (the last path segment). */
export function rkeyFromUri(uri: string): string {
  const at = uri.lastIndexOf("/");
  return at >= 0 ? uri.slice(at + 1) : uri;
}

export function identifierLabel(id: Identifier): string {
  const tail = id.uri.includes(":")
    ? id.uri.split(":").slice(1).join(":")
    : id.uri;
  return `${tail} · ${id.resource}`;
}

/**
 * Avatar fallback. Contributor records carry no display name in a `contributors`
 * array, so the rkey leaf is the only hint we have: slugged rkeys give the
 * person's initials (`gb.a-langston-hughes` → `LH`), opaque ones the first two
 * characters (`ol.A396182A` → `A3`).
 */
export function initialsFromUri(uri: string): string {
  const leaf = rkeyFromUri(uri).split(".").pop() ?? rkeyFromUri(uri);
  const words = leaf.split("-").filter(Boolean);
  // "a-langston-hughes" keeps an article-like prefix; drop it before taking initials.
  const named = words[0]?.length === 1 && words.length > 1 ? words.slice(1) : words;
  const [first, second] = named;
  if (first && second) {
    return (first.charAt(0) + second.charAt(0)).toUpperCase();
  }
  return leaf.slice(0, 2).toUpperCase();
}

/** Hero byline for a record's `contributors` array. */
export function peopleFromContributions(
  contributions: Contribution[],
): Person[] {
  return contributions.map((c) => ({ uri: c.subject.uri, role: c.role }));
}

export function contributorItems(contributions: Contribution[]): BodyItem[] {
  return contributions.map((c) => ({
    initials: initialsFromUri(c.subject.uri),
    meta: c.role,
    text: rkeyFromUri(c.subject.uri),
    href: `/contributors/${rkeyFromUri(c.subject.uri)}`,
  }));
}

export function identifierItems(identifiers: Identifier[]): BodyItem[] {
  return identifiers.map((id) => ({ text: identifierLabel(id), code: true }));
}

export function isEditionValue(
  value: DetailValue | undefined,
): value is EditionValue {
  return value?.$type === "community.lexicon.book.edition";
}

export function isWorkValue(value: DetailValue | undefined): value is WorkValue {
  return value?.$type === "community.lexicon.book.work";
}

export function isContributorValue(
  value: DetailValue | undefined,
): value is ContributorValue {
  return value?.$type === "community.lexicon.book.contributor";
}

export function isPublisherValue(
  value: DetailValue | undefined,
): value is PublisherValue {
  return value?.$type === "community.lexicon.book.publisher";
}
