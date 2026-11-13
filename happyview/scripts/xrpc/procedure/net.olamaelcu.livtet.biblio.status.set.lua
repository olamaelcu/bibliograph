-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.status.set — set one edition's reading status.
--
-- The record's rkey is not an index: the writer mints a TID per (reader,
-- edition), so the caller's row is found by the `book.uri` it names. On an
-- existing record the metadata is merged, createdAt is kept and updatedAt is
-- bumped; a missing one is created at a fresh TID. An optional `shelf` must
-- exist and belong to the caller; the read views drop references to shelves
-- they cannot resolve.

local STATUSES = { ['to-read'] = true, reading = true, read = true, dnf = true }
local PROGRESS = { 'startedAt', 'finishedAt', 'position', 'notes', 'emoji' }

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local book = strong_ref(input.book, true)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef {uri, cid} with an at:// uri')
  end

  local status = string_field(input.status)
  if status == nil or not STATUSES[status] then
    return fail(400, 'InvalidRequest', '`status` must be one of to-read, reading, read, dnf')
  end

  local shelf_uri = nil
  if input.shelf ~= nil then
    local shelf, failure = owned_shelf(input.shelf)
    if failure ~= nil then return failure end
    shelf_uri = shelf.uri
  end

  local provided = nil
  if input.metadata ~= nil then
    local err
    provided, err = status_metadata(input.metadata)
    if err ~= nil then
      return fail(400, 'InvalidRequest', err)
    end
  end

  local stamp = now()
  -- Resolve the caller's record by the book it names. A predicate on the record
  -- key would find only the seeded edition-keyed rows and would mint a second
  -- status for every book the app wrote under a TID.
  local found = db.raw(
    [[SELECT uri FROM happyview_records
       WHERE collection = $1 AND did = $2 AND (record::jsonb)->'book'->>'uri' = $3
       ORDER BY uri ASC
       LIMIT 1]],
    { BOOK_STATUS, caller_did, book.uri }
  )
  local record = nil
  if found[1] ~= nil then record = Record.load(found[1].uri) end

  if record ~= nil then
    local metadata = copy_table(record.metadata)
    merge_fields(metadata, provided, PROGRESS)
    metadata.status = status
    record.book = book
    record.metadata = metadata
    if shelf_uri ~= nil then record.shelf = shelf_uri end
    record.updatedAt = stamp
  else
    local metadata = copy_table(provided)
    metadata.status = status
    local data = {
      book = book,
      metadata = metadata,
      createdAt = stamp,
      updatedAt = stamp,
    }
    if shelf_uri ~= nil then data.shelf = shelf_uri end
    record = Record(BOOK_STATUS, data)
    record:set_rkey(TID())
  end

  local failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri, status = status }
end
