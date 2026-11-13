# Catalog backfills

One-off rewrite scripts live in `packages/worker/scripts/`. They connect with
`DATABASE_URL`, use the same library code as the worker, and are **dry runs by
default**. Nothing runs automatically during deploy; an operator runs them on
purpose and reads the dry-run report first.

They never talk to the PDS and never write `pds_outbox`. The catalog triggers
queue the affected records, and `pds-publish` drains them like any other edit.

```bash
cd packages/worker
DATABASE_URL=postgres://bibliograph:…@localhost:5432/bibliograph \
  node scripts/<script>.mjs            # dry run
DATABASE_URL=… node scripts/<script>.mjs --apply
```

On an installed host the scripts ship beside the worker payload:

```bash
sudo bash -c 'set -a; . /etc/bibliograph/worker.env; set +a; \
  node /usr/lib/bibliograph-worker/scripts/normalize-isbndb-author-names.mjs'
```

## ISBNdb author names

ISBNdb returns `book.authors` sometimes as a display name (`Ursula K. Le Guin`)
and sometimes inverted (`Le Guin, Ursula K.`). The worker now parses inverted
names before ingest (`packages/worker/lib/isbndb-names.js`) and stores the
original inverted form in `contributors.name_inverted`. This backfill applies
the same parser to rows stored before that change.

Selection: contributors whose `name` contains a comma and whose `name_inverted`
is NULL/empty. `--include-identified` also scans rows that already have a
`name_inverted`; those are reported but never overwritten, so a curated value is
safe. `--limit N` bounds the scan; `--sample N` changes the example count.

`--merge-conflicts` turns a name collision into a merge instead of a skip: the
inverted row is folded into one existing display-order contributor. Merges are
still dry-run by default and only write with `--apply`. Without the flag the
old skip behavior is unchanged.

```bash
cd packages/worker
DATABASE_URL=… node scripts/normalize-isbndb-author-names.mjs --limit 50
DATABASE_URL=… node scripts/normalize-isbndb-author-names.mjs --apply
DATABASE_URL=… node scripts/normalize-isbndb-author-names.mjs --merge-conflicts --apply
```

The report separates:

- **renames** — parseable inverted names that would be rewritten in place;
- **merges** — name collisions that `--merge-conflicts` would fold into an
  existing display-order contributor (see below);
- **unchanged** — already in the target shape;
- **skipped** — organizations, multi-author strings, dates, extra commas and
  anything else the parser refuses to guess about. They are left exactly as
  stored;
- **conflicts** — collisions left unresolved: without `--merge-conflicts`, every
  collision; with it, only ambiguous targets or targets that cannot safely take
  the source (they are reported and skipped, never guessed at);
- **already identified** — rows with a non-empty `name_inverted`.

Applying is idempotent: each row is updated only while its name still matches
the scan and `name_inverted` is still empty. Renames write `name` and
`name_inverted` only; `id`, `at_uri`, `created_at` and every edition link are
untouched. Each changed row queues its contributor record and every linked
edition for republication through the existing triggers.

### Merges

For a collision, the target is recomputed under `SELECT … FOR UPDATE` locks.
An exact identifier-bag match wins; otherwise exactly one display-order row is
accepted. Two or more candidates without an exact match are ambiguous and are
reported rather than merged. A target without an `at_uri` cannot absorb a
published source.

A merge keeps the target's `id`, `at_uri` and `created_at`, unions identifiers
by `(issuer, value)` (filling missing `url` metadata), fills an empty target
`name_inverted` with the source's inverted form (a curated value is never
overwritten), repoints every `edition_contributors` row with its position, role
and ref intact, and only then deletes the source row. The source's published
contributor record is queued for deletion; the target record and every affected
edition are queued for update. Nothing writes `pds_outbox` directly.

Each merge runs in a savepoint. A unique violation or a trigger failure rolls
the whole merge back (including repointed links) and is reported, so a re-run
can retry it after the cause is fixed. Merges are idempotent: a completed merge
leaves no selected source row.

The parser is ISBNdb-specific and intentionally conservative: no global name
normalization is applied to other providers or to the manual contributor editor.
Rows that already have duplicate catalogue links for one edition are rare; the
contributor trigger cannot expand such a link set in a single statement, so a
merge touching one is rolled back and reported rather than forced.
