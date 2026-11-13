-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.graph.unfollow — delete a follow by subject DID.
--
-- The rkey is opaque, so the records are found by subject across every spelling
-- a stored subject has taken — the current `did:`, the legacy `at://did`, and a
-- full AT-URI under that DID — plus the old subject-DID URI fallback for legacy
-- rows whose subject field is unusable. Every match is deleted; a subject with
-- no matching follow is a 404.

local function follow_uris(subject)
  local rows = db.raw(
    [[SELECT uri FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND ((record::jsonb)->>'subject' = $3
              OR (record::jsonb)->>'subject' = 'at://' || $3
              OR (record::jsonb)->>'subject' LIKE 'at://' || $3 || '/%')
       ORDER BY uri ASC]],
    { FOLLOW_COLLECTION, caller_did, subject }
  )

  local uris = {}
  local seen = {}
  for _, row in ipairs(rows) do
    if row.uri ~= nil and not seen[row.uri] then
      seen[row.uri] = true
      uris[#uris + 1] = row.uri
    end
  end

  -- Legacy record at rkey = subject DID, even when its subject field is bad.
  local legacy_uri = 'at://' .. caller_did .. '/' .. FOLLOW_COLLECTION .. '/' .. subject
  if not seen[legacy_uri] and Record.load(legacy_uri) ~= nil then
    uris[#uris + 1] = legacy_uri
  end
  return uris
end

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local subject = string_field(input.subject)
  if subject == nil then
    return fail(400, 'InvalidRequest', '`subject` must be a non-empty DID string')
  end
  if not is_did(subject) then
    return fail(400, 'InvalidRequest', '`subject` must be a DID of the form did:<method>:<identifier>')
  end

  local uris = follow_uris(subject)
  if #uris == 0 then
    return fail(404, 'NotFound', 'no follow record for ' .. subject)
  end

  local records, err = pds_load_all(uris)
  if records == nil then
    return fail(502, 'UpstreamFailure', 'could not load follow records: ' .. tostring(err))
  end

  local deleted_uri = nil
  for i = 1, #uris do
    local record = records[i]
    if record ~= nil then
      local failure = pds_delete(record)
      if failure ~= nil then return failure end
      if deleted_uri == nil then deleted_uri = record._uri end
    end
  end

  if deleted_uri == nil then
    return fail(404, 'NotFound', 'no follow record for ' .. subject)
  end
  return { uri = deleted_uri }
end
