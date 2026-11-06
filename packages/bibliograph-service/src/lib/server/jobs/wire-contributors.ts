import { wireContributors, type Contributor } from '../book-wire';
import { contributorUrisFor, loadContributorRefs } from '../contributor-refs';
import type { ContributionEntry } from '../search/types';
import type { DbExecutor } from '../stats';

/**
 * Queue payloads are cast from `unknown`, so a malformed entry must be dropped
 * rather than reach `wireContributors`' unguarded `subject.uri`/`role` reads.
 */
function usable(entry: ContributionEntry | null | undefined): entry is ContributionEntry {
  return (
    typeof entry?.subject?.uri === 'string' &&
    entry.subject.uri.length > 0 &&
    typeof entry.role === 'string'
  );
}

/**
 * Contributor entries for record values, resolved from the strongRefs a row
 * stores.
 *
 * Edition and work rows only keep `{ subject: { uri, cid }, role }`: the name
 * lives on the `contributors` row so a rename is detectable. The lexicon inlines
 * the name, so every record value built from a row expands the refs first — the
 * join is `loadContributorRefs` and the expansion `wireContributors`, the same
 * pair the response boundary uses, so a job hashes exactly what gets served.
 *
 * Batch ingestion holds one contribution list per item, so resolving them one by
 * one would turn a batch into N round trips. The executor is injected because the
 * jobs are exercised against a fake database.
 */
export async function wireContributorsForAll(
  db: DbExecutor,
  groups: ReadonlyArray<readonly ContributionEntry[] | null | undefined>,
): Promise<Contributor[][]> {
  const uris = new Set<string>();
  for (const group of groups) {
    for (const uri of contributorUrisFor(group ?? undefined)) uris.add(uri);
  }
  const refs = await loadContributorRefs([...uris], db);
  return groups.map((group) => wireContributors((group ?? []).filter(usable), refs));
}

/** {@link wireContributorsForAll} for a single list (one row, one job step). */
export async function wireContributorsFor(
  db: DbExecutor,
  entries: readonly ContributionEntry[] | null | undefined,
): Promise<Contributor[]> {
  const [out] = await wireContributorsForAll(db, [entries]);
  return out ?? [];
}
