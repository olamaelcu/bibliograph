-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.graph.isFollowing — is `follower` following
-- `followed`?
--
-- The follow lexicon types `subject` as a DID, but legacy records stored the
-- full `at://<did>` form, and a follow of a specific record stored that record's
-- own AT-URI. Match all three spellings against the indexed full-subject
-- expression instead of normalizing the column in the predicate.

function handle()
  local follower, err = required_did(params.follower, 'follower')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local followed, err = required_did(params.followed, 'followed')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local rows = db.raw(
    [[SELECT 1 AS found FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND ((record::jsonb)->>'subject' = $3
              OR (record::jsonb)->>'subject' = 'at://' || $3
              OR (record::jsonb)->>'subject' LIKE 'at://' || $3 || '/%')
       LIMIT 1]],
    { FOLLOW_COLLECTION, follower, followed }
  )
  return { following = rows[1] ~= nil }
end
