-- Core helpers shared by every endpoint: collection constants, the error
-- envelope, parameter coercion, JSON column decoding, and at-uri/strongRef
-- validation. Included by lib/prelude.lua; see the contract note there.

-- Activity collections and the fixed reading-status shelves.
local SHELF_COLLECTION = 'net.olamaelcu.livtet.biblio.shelf'
local BOOK_STATUS = 'net.olamaelcu.livtet.biblio.bookStatus'
local SHELF_ITEM = 'net.olamaelcu.livtet.biblio.shelfItem'
local FOLLOW_COLLECTION = 'net.olamaelcu.livtet.biblio.follow'
local REVIEW_COLLECTION = 'community.lexicon.media.book.review'
local READING_GOAL = 'net.olamaelcu.livtet.biblio.readingGoal'
local PROFILE_COLLECTION = 'net.olamaelcu.livtet.actor.profile'

local FIXED_SHELVES = {
  ['reading'] = 'Currently Reading',
  ['read'] = 'Read',
  ['to-read'] = 'To Read',
  ['dnf'] = 'Did Not Finish',
}

-- A fixed reading-status rkey, or nil. Mirrors the FIXED_SHELVES keys so a
-- status can be turned back into the shelf URI it belongs to.
local function fixed_status(value)
  if type(value) == 'string' and FIXED_SHELVES[value] ~= nil then return value end
  return nil
end

-- Upper bound for a decoded OFFSET and for any keyset page size. A cursor is
-- client-controlled; without a cap, `{"o": 1e300}` would ask Postgres to walk
-- an unbounded row count.
local MAX_OFFSET = 1000000000

-- Lexicon errors are returned as a wrapper the edge gateway unwraps into a
-- non-200 response. Success bodies pass through unchanged.
local function fail(status, err, message)
  return {
    __bib_http = {
      status = status,
      body = { error = err, message = message or err },
    },
  }
end

-- Clamp a numeric parameter (query params arrive as strings). Non-finite input
-- falls back to `default`; the result is floored and clamped to [min, max].
local function clamp_int(value, default, min, max)
  local n = tonumber(value)
  if n == nil or n ~= n then n = default end
  n = math.floor(n)
  if min ~= nil and n < min then n = min end
  if max ~= nil and n > max then n = max end
  return n
end

-- HappyView stores `record` and the catalog read model's columns as text.
-- `json_value` decodes a text JSON column, returning `fallback` for anything
-- that is not a string, is invalid JSON, or is SQL NULL. It never returns the
-- raw undecodable string.
local function json_value(raw, fallback)
  if type(raw) == 'string' then
    local ok, decoded = pcall(json.decode, raw)
    if ok then return decoded end
    return fallback
  end
  if raw == nil then return fallback end
  return raw
end

-- A record-shaped value: an object table, or an empty table when the column is
-- missing or malformed.
local function record_value(raw)
  local value = json_value(raw, nil)
  if type(value) == 'table' then return value end
  return {}
end

-- A record-shaped value for a required object ref: the decoded object, or
-- `json.null` when the record does not exist (or is malformed).
local function record_or_null(raw)
  local value = json_value(raw, nil)
  if type(value) == 'table' then return value end
  return json.null
end

-- `did:<method>:<identifier>` as atproto writes one.
local function is_did(value)
  if type(value) ~= 'string' then return false end
  return string.match(value, '^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$') ~= nil
end

-- An NSID: at least two dot-separated segments of letters, digits and hyphens;
-- the first segment starts with a letter and no segment ends with a hyphen.
local function is_nsid(value)
  if type(value) ~= 'string' or #value < 3 or #value > 317 then return false end
  if value:match('%.%.') or value:sub(1, 1) == '.' or value:sub(-1) == '.' then return false end
  local segments = 0
  for segment in value:gmatch('[^.]+') do
    segments = segments + 1
    if #segment > 63 then return false end
    if segments == 1 then
      if not segment:match('^%a[%a%d%-]*$') or segment:match('%-$') then return false end
    else
      if not segment:match('^[%a%d][%a%d%-]*$') or segment:match('%-$') then return false end
    end
  end
  return segments >= 2
end

-- A record key: 1-512 characters from the atproto rkey alphabet; `.` and `..`
-- are reserved and rejected.
local function is_rkey(value)
  if type(value) ~= 'string' or #value < 1 or #value > 512 then return false end
  if value == '.' or value == '..' then return false end
  return value:match('^[%w%._~:%-]+$') ~= nil
end

-- Split `at://<did>/<collection>/<rkey>` into its parts. Returns nil for
-- anything else: a bare DID, a fragment/query, extra path segments, a non-NSID
-- collection, or an invalid rkey.
local function at_uri_parts(uri)
  if type(uri) ~= 'string' then return nil end
  local rest = string.match(uri, '^at://(.+)$')
  if rest == nil then return nil end
  local did, coll, rkey = string.match(rest, '^([^/]+)/([^/]+)/([^/]+)$')
  if did == nil then return nil end
  if not is_did(did) or not is_nsid(coll) or not is_rkey(rkey) then return nil end
  return did, coll, rkey
end

-- A non-empty string, or nil for anything else (missing, JSON null, wrong type).
local function string_field(value)
  if type(value) == 'string' and value ~= '' then return value end
  return nil
end

-- An integral JSON number, or nil. Rejects floats such as 1.5.
local function integer_field(value)
  if type(value) == 'number' and value == math.floor(value) then return value end
  return nil
end

-- Required query parameters. Each returns `value, nil` on success or
-- `nil, message` when the value is missing, empty, or malformed. Empty strings
-- are invalid for every required string field.
local function required_string(value, name)
  local s = string_field(value)
  if s == nil then return nil, '`' .. name .. '` is required' end
  return s, nil
end

local function required_did(value, name)
  local s, err = required_string(value, name)
  if s == nil then return nil, err end
  if not is_did(s) then return nil, '`' .. name .. '` must be a DID' end
  return s, nil
end

local function required_at_uri(value, name)
  local s, err = required_string(value, name)
  if s == nil then return nil, err end
  if at_uri_parts(s) == nil then return nil, '`' .. name .. '` must be an AT-URI' end
  return s, nil
end

-- Validate a `com.atproto.repo.strongRef`. Returns a fresh {uri=..., cid=...}
-- table so the caller can assign it to a record field, or nil when the value
-- is not a strongRef with a usable at-uri (and a cid, when require_cid).
local function strong_ref(value, require_cid)
  if type(value) ~= 'table' then return nil end
  local uri = string_field(value.uri)
  if uri == nil then return nil end
  local _, _, rkey = at_uri_parts(uri)
  if rkey == nil then return nil end
  local cid = string_field(value.cid)
  if cid == nil and require_cid then return nil end
  local ref = { uri = uri }
  if cid ~= nil then ref.cid = cid end
  return ref
end

-- Copy the `allowed` keys of an input object onto `target`, leaving the keys
-- the input omits untouched. This is what makes the metadata/merge procedures
-- partial updates. Returns how many keys were copied.
local function merge_fields(target, update, allowed)
  local copied = 0
  if type(update) ~= 'table' then return copied end
  for _, key in ipairs(allowed) do
    local value = update[key]
    local kind = type(value)
    if kind == 'string' or kind == 'number' or kind == 'boolean' or kind == 'table' then
      target[key] = value
      copied = copied + 1
    end
  end
  return copied
end

-- A shallow copy of a record field that may be a JSON object.
local function copy_table(value)
  local out = {}
  if type(value) == 'table' then
    for key, item in pairs(value) do out[key] = item end
  end
  return out
end
