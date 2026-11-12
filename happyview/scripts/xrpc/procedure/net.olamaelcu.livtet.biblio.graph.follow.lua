-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.graph.follow — follow a DID.
--
-- The record key is an opaque TID, so uniqueness is not a property of the key.
-- Idempotence is enforced here: look the follow up by subject (matching both
-- the current `did:` and legacy `at://did` spellings) before writing. Legacy
-- rows keyed by the subject DID are also found through the old URI fallback.

local function existing_follow_uri(subject)
  local rows = db.raw(
    [[SELECT uri FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND ((record::jsonb)->>'subject' = $3
              OR (record::jsonb)->>'subject' = 'at://' || $3)
       ORDER BY uri ASC
       LIMIT 1]],
    { FOLLOW_COLLECTION, caller_did, subject }
  )
  if rows[1] ~= nil then
    return rows[1].uri
  end

  -- Pre-TID records kept the subject DID as their rkey. This lookup keeps
  -- those follows idempotent even if their stored subject is unusable.
  local legacy_uri = 'at://' .. caller_did .. '/' .. FOLLOW_COLLECTION .. '/' .. subject
  local legacy = Record.load(legacy_uri)
  if legacy ~= nil then
    return legacy._uri or legacy_uri
  end
  return nil
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
  if subject == caller_did then
    return fail(400, 'InvalidRequest', 'a reader cannot follow themselves')
  end

  local existing = existing_follow_uri(subject)
  if existing ~= nil then
    return { uri = existing, created = false }
  end

  local record = Record(FOLLOW_COLLECTION, { subject = subject, createdAt = now() })
  record:set_rkey(TID())
  local failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri, created = true }
end
