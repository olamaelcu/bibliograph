-- `getEditionsByContributor` filtered with an `EXISTS (SELECT 1 FROM
-- jsonb_array_elements(contributors) …)`, which no index can serve: a call whose
-- rows were not near the top of `editions_created_at_idx` walked the whole 888MB
-- table (measured on lescayes: 11.7s for a 1008-edition contributor, and ten
-- concurrent 34s calls waiting on DataFileRead). Expressed as jsonb containment
-- (`contributors @> '[{"subject":{"uri":…}}]'`) the same match is indexable.
-- jsonb_path_ops is the right operator class here because only `@>` is used — it
-- is smaller and more specific than jsonb_ops, exactly as editions_identifiers_gin
-- (0005) chose for the same reason.
CREATE INDEX IF NOT EXISTS "editions_contributors_gin"
  ON "editions" USING GIN ("contributors" jsonb_path_ops);
