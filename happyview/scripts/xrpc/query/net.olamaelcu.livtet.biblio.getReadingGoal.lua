-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getReadingGoal — read the reading goal record.
--
-- Same object-ref rule as getActorProfile: decode the stored JSON text, and
-- answer `json.null` when there is no record.

function handle()
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local uri = 'at://' .. did .. '/' .. READING_GOAL .. '/current'
  local rows = db.raw('SELECT record FROM happyview_records WHERE uri = $1 LIMIT 1', { uri })
  return { goal = record_or_null(rows[1] and rows[1].record) }
end
