-- Partial unique index for `import_issues` dedup.
-- The import hot path does a SELECT-before-INSERT in `flagIssue` to dedup
-- identical open issues. That SELECT currently bypasses the `entity_idx`
-- (COALESCE(incoming_value,'') = COALESCE(?, '')) and seq-scans 2,684 rows
-- 33k times during a partial import. The ON CONFLICT path eliminates the
-- SELECT entirely; this index is what makes the conflict target concrete.
--
-- The index is partial (WHERE status='open') so resolved issues are
-- exempt: a record can be re-flagged after the previous issue is
-- resolved. `incoming_value` is excluded because callers may pass NULL
-- (the prior COALESCE NULL-handling is preserved as a SELECT fallback in
-- src/import/issues.ts).
--
-- Pre-existing rows may have duplicates of (entity_type, entity_pk, field,
-- source) where status='open' — the prior SELECT-before-INSERT path was a
-- best-effort dedup that could fail under concurrent inserts. Dedupe them
-- here by keeping the row with the lowest `pk` per group, then build the
-- unique index.
DELETE FROM "import_issues" a
USING "import_issues" b
WHERE a.status = 'open'
  AND b.status = 'open'
  AND a.entity_type = b.entity_type
  AND a.entity_pk = b.entity_pk
  AND a.field = b.field
  AND a.source = b.source
  AND a.pk > b.pk;
--> statement-breakpoint
CREATE UNIQUE INDEX "import_issues_open_dedup" ON "import_issues" ("entity_type","entity_pk","field","source") WHERE "import_issues"."status" = 'open';
