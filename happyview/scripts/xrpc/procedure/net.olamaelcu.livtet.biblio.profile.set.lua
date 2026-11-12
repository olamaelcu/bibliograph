-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.profile.set — merge fields into the profile.
--
-- The profile record lives at the literal rkey 'self'; the getActorProfile
-- query reads that key. Only the fields the input carries are touched, so a
-- display-name change cannot wipe the avatar CID.

-- { field, max length } — avatarCid has no length limit, so it carries none.
local FIELDS = {
  { 'displayName', 640 },
  { 'description', 256 },
  { 'avatarCid' },
}

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local changed = {}
  local has_field = false

  for _, field in ipairs(FIELDS) do
    local key, max_length = field[1], field[2]
    local value = input[key]
    if value ~= nil then
      if type(value) ~= 'string' then
        return fail(400, 'InvalidRequest', '`' .. key .. '` must be a string')
      end
      if max_length ~= nil and #value > max_length then
        return fail(400, 'InvalidRequest', '`' .. key .. '` must be at most ' .. max_length .. ' characters')
      end
      changed[key] = value
      has_field = true
    end
  end

  if not has_field then
    return fail(400, 'InvalidRequest', 'provide at least one of displayName, description or avatarCid')
  end

  local stamp = now()
  local uri = 'at://' .. caller_did .. '/' .. PROFILE_COLLECTION .. '/self'
  local record = Record.load(uri)

  if record ~= nil then
    for key, value in pairs(changed) do record[key] = value end
    record.updatedAt = stamp
  else
    changed.createdAt = stamp
    changed.updatedAt = stamp
    record = Record(PROFILE_COLLECTION, changed)
    record:set_rkey('self')
  end

  local failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri }
end
