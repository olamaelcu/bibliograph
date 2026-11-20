-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getActorProfile — read the profile record.
--
-- The output's `profile` is a required object ref; a missing record answers
-- `json.null` rather than omitting the property or returning raw JSON text.
--
-- The collection is looked up under the current namespace and the one it
-- replaced: readers who signed in before the rename still carry
-- `net.olamaelcu.livtet.actor.profile`, and a chip that cannot name them is a
-- chip that reads "A reader". Newest record wins when a reader has both.

local LEGACY_PROFILE_COLLECTION = 'net.olamaelcu.livtet.actor.profile'

function handle()
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local rows = db.raw(
    [[SELECT record
        FROM happyview_records
       WHERE uri IN ('at://' || $1 || '/' || $2 || '/self',
                     'at://' || $1 || '/' || $3 || '/self')
       ORDER BY created_at DESC
       LIMIT 1]],
    { did, PROFILE_COLLECTION, LEGACY_PROFILE_COLLECTION }
  )
  return { profile = record_or_null(rows[1] and rows[1].record) }
end
