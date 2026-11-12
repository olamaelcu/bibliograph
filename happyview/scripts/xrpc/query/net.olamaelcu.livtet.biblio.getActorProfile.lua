-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getActorProfile — read the profile record.
--
-- The output's `profile` is a required object ref; a missing record answers
-- `json.null` rather than omitting the property or returning raw JSON text.

function handle()
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local uri = 'at://' .. did .. '/' .. PROFILE_COLLECTION .. '/self'
  local rows = db.raw('SELECT record FROM happyview_records WHERE uri = $1 LIMIT 1', { uri })
  return { profile = record_or_null(rows[1] and rows[1].record) }
end
