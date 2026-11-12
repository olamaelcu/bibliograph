-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.update — rename / re-describe a shelf.
--
-- Load → mutate → save, so fields the input omits keep their stored value and
-- createdAt is carried over by the loaded record. A missing or foreign shelf is
-- 404/403 before any field is touched.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf, failure = owned_shelf(input.shelf)
  if failure ~= nil then return failure end

  local name = nil
  if input.name ~= nil then
    local err
    name, err = required_string(input.name, 'name')
    if err ~= nil then
      return fail(400, 'InvalidRequest', err)
    end
    if #name > 128 then
      return fail(400, 'InvalidRequest', '`name` must be at most 128 characters')
    end
  end

  local description = nil
  if input.description ~= nil then
    if type(input.description) ~= 'string' then
      return fail(400, 'InvalidRequest', '`description` must be a string')
    end
    description = input.description
  end

  local record = shelf.record
  local updated = false
  if name ~= nil then
    record.name = name
    updated = true
  end
  if description ~= nil then
    record.description = description
    updated = true
  end
  record.updatedAt = now()

  failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri, updated = updated }
end
