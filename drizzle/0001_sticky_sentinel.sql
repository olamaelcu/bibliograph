-- Widen timestamp columns that carry historical pre-1900 unix seconds. Postgres
-- `integer` is INT4 (±2.1e9, ≈ year 1900 cutoff) so OL records for books
-- published before 1900 hit "value out of range for type integer" on insert.
-- The two views below select these columns and must be dropped before the
-- ALTER then recreated with the same SQL afterwards.

DROP VIEW IF EXISTS "book_import_issues";--> statement-breakpoint
DROP VIEW IF EXISTS "work_import_issues";--> statement-breakpoint
ALTER TABLE "books" ALTER COLUMN "publish_date" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "works" ALTER COLUMN "original_publish_date" SET DATA TYPE bigint;--> statement-breakpoint
CREATE VIEW "book_import_issues" AS ( SELECT b.pk,
    b.title,
    b.work_pk,
    b.format_pk,
    b.publish_date,
    b.description,
    b.cover_url,
    b.cid,
    b.created_at,
    b.updated_at,
    b.release_status,
    b.released_at,
    ii.open_issues
   FROM books b
     JOIN ( SELECT import_issues.entity_pk,
            COALESCE(json_agg(json_build_object('pk', import_issues.pk, 'field', import_issues.field, 'incomingValue', import_issues.incoming_value, 'storedValue', import_issues.stored_value, 'source', import_issues.source, 'createdAt', import_issues.created_at) ORDER BY import_issues.created_at, import_issues.pk), '[]'::json) AS open_issues
            FROM import_issues
           WHERE import_issues.entity_type = 'book'::text AND import_issues.status = 'open'::text
           GROUP BY import_issues.entity_pk) ii ON ii.entity_pk = b.pk);--> statement-breakpoint
CREATE VIEW "work_import_issues" AS ( SELECT w.pk,
    w.title,
    w.description,
    w.original_publish_date,
    w.cid,
    w.created_at,
    w.updated_at,
    w.release_status,
    w.released_at,
    ii.open_issues
   FROM works w
     JOIN ( SELECT import_issues.entity_pk,
            COALESCE(json_agg(json_build_object('pk', import_issues.pk, 'field', import_issues.field, 'incomingValue', import_issues.incoming_value, 'storedValue', import_issues.stored_value, 'source', import_issues.source, 'createdAt', import_issues.created_at) ORDER BY import_issues.created_at, import_issues.pk), '[]'::json) AS open_issues
            FROM import_issues
           WHERE import_issues.entity_type = 'work'::text AND import_issues.status = 'open'::text
           GROUP BY import_issues.entity_pk) ii ON ii.entity_pk = w.pk);
