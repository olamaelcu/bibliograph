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

```bash
cd packages/worker
DATABASE_URL=… node scripts/normalize-isbndb-author-names.mjs --limit 50
DATABASE_URL=… node scripts/normalize-isbndb-author-names.mjs --apply
```

The report separates:

- **candidates** — parseable inverted names that would be rewritten;
- **unchanged** — already in the target shape;
- **skipped** — organizations, multi-author strings, dates, extra commas and
  anything else the parser refuses to guess about. They are left exactly as
  stored;
- **conflicts** — another contributor already owns the target
  `(lower(name), identifiers)` identity. The row is skipped. v1 never merges or
  deletes contributor rows; resolving a conflict stays a curation decision;
- **already identified** — rows with a non-empty `name_inverted`.

Applying is idempotent: each row is updated only while its name still matches
the scan and `name_inverted` is still empty. The script writes `name` and
`name_inverted` only; `id`, `at_uri`, `created_at` and every edition link are
untouched. Each changed row queues its contributor record and every linked
edition for republication through the existing triggers.

The parser is ISBNdb-specific and intentionally conservative: no global name
normalization is applied to other providers or to the manual contributor editor.
