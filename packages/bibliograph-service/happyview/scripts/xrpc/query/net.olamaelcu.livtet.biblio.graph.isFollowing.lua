-- @include lib/prelude.lua
function handle()
  local follower = params.follower
  local followed = params.followed
  if follower == nil or followed == nil then
    return fail(400, 'InvalidRequest', 'follower and followed are required')
  end
  local rows = db.raw(
    [[SELECT 1 AS found FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND split_part(regexp_replace((record::jsonb)->>'subject', '^at://', ''), '/', 1) = $3
       LIMIT 1]],
    { FOLLOW_COLLECTION, follower, followed }
  )
  return { following = rows[1] ~= nil }
end
