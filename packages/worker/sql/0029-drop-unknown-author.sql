-- 0029-drop-unknown-author.sql
--
-- `contributors` holds a row named exactly `Unknown Author`: the provider feeds
-- use it as the placeholder for "nobody is credited", and it accumulated 14,783
-- credits in `edition_contributors` (3.1% of the catalog) while being published
-- as an entity record like a real person. `lib/ingest.js` now drops the
-- placeholder before it becomes a row; this migration removes the rows the
-- worker already wrote.
--
-- Both deletes are observable through the outbox triggers, and that is
-- intended:
--
--   * deleting a credit fires `pds_enqueue_contributors` (0001), which queues an
--     `update` of that edition, so every affected edition is republished once
--     without the placeholder credit;
--   * deleting the contributor fires `pds_enqueue_contributor_record` (0004),
--     which queues the `delete` of its entity record.
--
-- One run therefore grows `pds_outbox` by roughly 15k rows — one per affected
-- edition plus one entity delete per removed contributor row — and
-- `pds-publish` drains them as usual. That churn is the point: the published
-- editions and the entity record must stop carrying the placeholder.
--
-- Re-runnable: after the first run there is no credit left to delete and no
-- contributor left without credits, so both statements delete nothing. The
-- contributor delete keeps a `NOT EXISTS` guard because `edition_contributors`
-- references `contributors` with `ON DELETE RESTRICT`: if a concurrent ingest
-- credits the row between the two statements, the row stays rather than failing
-- the deployment's migration replay. Ingest will not mint it again, so a
-- survivor is inert.

BEGIN;

DELETE FROM edition_contributors ec
 USING contributors c
 WHERE ec.contributor_id = c.id
   AND lower(btrim(c.name)) = 'unknown author';

DELETE FROM contributors c
 WHERE lower(btrim(c.name)) = 'unknown author'
   AND NOT EXISTS (
     SELECT 1 FROM edition_contributors ec WHERE ec.contributor_id = c.id
   );

COMMIT;
