-- @include lib/prelude.lua
function handle()
  local did = params.did
  if did == nil then return fail(400, 'InvalidRequest', 'did is required') end
  local uri = 'at://' .. did .. '/' .. PROFILE_COLLECTION .. '/self'
  local rows = db.raw('SELECT record FROM happyview_records WHERE uri = $1 LIMIT 1', { uri })
  return { profile = rows[1] and rows[1].record or nil }
end
