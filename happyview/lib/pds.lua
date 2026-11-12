-- PDS write/delete wrappers shared by the procedures. Included by
-- lib/prelude.lua.
--
-- `r:save()`, `r:delete()` and `Record.save_all()` proxy to the caller's PDS
-- and raise on rejection. Every procedure funnels those calls through here so a
-- rejection becomes the same `502 UpstreamFailure` envelope instead of a Lua
-- runtime error (which HappyView would turn into a generic 500).

local function pds_failure(action, err)
  return fail(502, 'UpstreamFailure', 'the PDS rejected the ' .. action .. ': ' .. tostring(err))
end

local function pds_save(record)
  local ok, err = pcall(function() return record:save() end)
  if ok then return nil end
  return pds_failure('write', err)
end

local function pds_delete(record)
  local ok, err = pcall(function() return record:delete() end)
  if ok then return nil end
  return pds_failure('delete', err)
end

local function pds_save_all(records)
  local ok, err = pcall(function() return Record.save_all(records) end)
  if ok then return nil end
  return pds_failure('batch', err)
end

-- Load several records in one parallel batch. Returns the array (with nil
-- holes for missing URIs), or nil plus the error.
local function pds_load_all(uris)
  local ok, records = pcall(function() return Record.load_all(uris) end)
  if not ok then return nil, records end
  return records, nil
end
