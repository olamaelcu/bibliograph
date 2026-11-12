-- Shared helpers, prepended to every query script by deploy.ts.
--
-- HappyView's v2 script contract: `handle()`, globals `params`/`input`/`env`,
-- `db.raw(sql, {args})`, `json`, and `toarray`. Query parameters are strings.

SHELF_COLLECTION = 'net.olamaelcu.livtet.biblio.shelf'
BOOK_STATUS = 'net.olamaelcu.livtet.biblio.bookStatus'
SHELF_ITEM = 'net.olamaelcu.livtet.biblio.shelfItem'
FOLLOW_COLLECTION = 'net.olamaelcu.livtet.biblio.follow'
REVIEW_COLLECTION = 'community.lexicon.media.book.review'
READING_GOAL = 'net.olamaelcu.livtet.biblio.readingGoal'
PROFILE_COLLECTION = 'net.olamaelcu.livtet.actor.profile'

FIXED_SHELVES = {
  ['reading'] = 'Currently Reading',
  ['read'] = 'Read',
  ['to-read'] = 'To Read',
  ['dnf'] = 'Did Not Finish',
}

-- Lexicon errors are returned as a wrapper the edge gateway unwraps into a
-- non-200 response. Success bodies pass through unchanged.
function fail(status, err, message)
  return {
    __bib_http = {
      status = status,
      body = { error = err, message = message or err },
    },
  }
end

function int(value, default, min, max)
  local n = tonumber(value)
  if n == nil then n = default end
  n = math.floor(n)
  if min ~= nil and n < min then n = min end
  if max ~= nil and n > max then n = max end
  return n
end

local B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

local function b64url_encode(s)
  local out = {}
  local i = 1
  while i <= #s do
    local a = string.byte(s, i) or 0
    local b = string.byte(s, i + 1)
    local c = string.byte(s, i + 2)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    local c1 = math.floor(n / 262144) % 64
    local c2 = math.floor(n / 4096) % 64
    local c3 = math.floor(n / 64) % 64
    local c4 = n % 64
    out[#out + 1] = string.sub(B64, c1 + 1, c1 + 1)
    out[#out + 1] = string.sub(B64, c2 + 1, c2 + 1)
    if b ~= nil then out[#out + 1] = string.sub(B64, c3 + 1, c3 + 1) end
    if c ~= nil then out[#out + 1] = string.sub(B64, c4 + 1, c4 + 1) end
    i = i + 3
  end
  return table.concat(out)
end

local B64_INDEX = {}
for i = 1, #B64 do B64_INDEX[string.sub(B64, i, i)] = i - 1 end

local function b64url_decode(s)
  local out = {}
  local i = 1
  while i <= #s do
    local v1 = B64_INDEX[string.sub(s, i, i)]
    local v2 = B64_INDEX[string.sub(s, i + 1, i + 1)]
    local v3 = B64_INDEX[string.sub(s, i + 2, i + 2)]
    local v4 = B64_INDEX[string.sub(s, i + 3, i + 3)]
    if v1 == nil or v2 == nil then return nil end
    local n = v1 * 262144 + v2 * 4096 + (v3 or 0) * 64 + (v4 or 0)
    out[#out + 1] = string.char(math.floor(n / 65536) % 256)
    if v3 ~= nil then out[#out + 1] = string.char(math.floor(n / 256) % 256) end
    if v4 ~= nil then out[#out + 1] = string.char(n % 256) end
    i = i + 4
  end
  return table.concat(out)
end

function encode_cursor(value)
  return b64url_encode(json.encode(value))
end

function decode_cursor(raw)
  if raw == nil or raw == '' then return {} end
  local ok, decoded = pcall(function() return json.decode(b64url_decode(raw)) end)
  if ok and type(decoded) == 'table' then return decoded end
  return {}
end

-- HappyView stores `record` as JSON text; parse it for view builders.
function record_value(raw)
  if type(raw) == 'string' then
    local ok, decoded = pcall(json.decode, raw)
    if ok and type(decoded) == 'table' then return decoded end
    return {}
  end
  return raw or {}
end

local function rkey_of(uri)
  if uri == nil then return '' end
  return string.match(uri, '([^/]+)$') or ''
end

local function did_of(uri)
  if uri == nil then return nil end
  return string.match(uri, '^at://([^/]+)')
end

-- One shelf record (or a derived fixed shelf) as `defs#shelfView`.
function shelf_view(uri, record)
  -- `record` arrives as the text column; parse it or every custom shelf
  -- renders as its rkey (the fixed shelves hide this, they match on rkey).
  record = record_value(record)
  local rkey = rkey_of(uri)
  local view = {
    ['$type'] = 'net.olamaelcu.livtet.biblio.defs#shelfView',
    uri = uri,
    name = FIXED_SHELVES[rkey] or (record and record.name) or rkey,
  }
  if record then
    if record.description ~= nil then view.description = record.description end
    if record.createdAt ~= nil then view.createdAt = record.createdAt end
    if record.updatedAt ~= nil then view.updatedAt = record.updatedAt end
  end
  return view
end

function shelf_view_for_uri(uri)
  if uri == nil then return nil end
  local rows = db.raw(
    'SELECT record FROM happyview_records WHERE uri = $1 AND collection = $2 LIMIT 1',
    { uri, SHELF_COLLECTION }
  )
  return shelf_view(uri, rows[1] and rows[1].record)
end

-- Parse a JSON text column (HappyView's Any driver cannot decode jsonb).
function json_value(raw, fallback)
  if type(raw) == 'string' then
    local ok, decoded = pcall(json.decode, raw)
    if ok then return decoded end
  end
  if raw == nil then return fallback end
  return raw
end

-- `community.lexicon.media.book.defs#editionView` from appview_book_lua.
-- Contributor roles are ONIX Codelist 17 codes (lexicon.community PR #18);
-- rows ingested before that change stored the old kebab-case tokens. Keep this
-- table in sync with packages/worker/lib/contributor-roles.js.
local LEGACY_CONTRIBUTOR_ROLES = {
  author = 'A01',
  ['co-author'] = 'A01',
  editor = 'B01',
  translator = 'B06',
  narrator = 'E03',
  illustrator = 'A12',
  photographer = 'A08',
  foreword = 'A23',
  preface = 'A15',
  penciller = 'A07',
  inker = 'A46',
  colorist = 'A47',
  letterer = 'A48',
  ['posthumous-completer'] = 'Z05'
}

local function contributor_role(value)
  if type(value) ~= 'string' then return 'A01' end
  local token = value:match('^%s*(.-)%s*$')
  if token == '' then return 'A01' end
  if token:match('^%u%d%d$') then return token end
  return LEGACY_CONTRIBUTOR_ROLES[token:lower()] or token
end

function edition_view(uri)
  if uri == nil then return nil end
  local rows = db.raw('SELECT * FROM appview_book_lua WHERE uri = $1 LIMIT 1', { uri })
  local row = rows[1]
  if row == nil then return nil end

  local contributors = {}
  for _, entry in ipairs(json_value(row.contributors, {})) do
    local contributor = { displayName = entry.name, role = contributor_role(entry.role) }
    if entry.identifiers ~= nil and #entry.identifiers > 0 then contributor.identifiers = entry.identifiers end
    if entry.ref ~= nil and entry.ref ~= json.null then contributor.ref = entry.ref end
    contributors[#contributors + 1] = contributor
  end

  local view = {
    title = row.title,
    identifiers = json_value(row.identifiers, {}),
    contributors = toarray(contributors),
    createdAt = row.created_at,
  }
  if row.subtitle ~= nil then view.subtitle = row.subtitle end
  if row.language ~= nil then view.language = row.language end
  if row.published_date ~= nil then view.publishedDate = row.published_date end
  if row.format ~= nil then view.format = row.format end
  if row.pages ~= nil then view.pages = row.pages end
  if row.duration_seconds ~= nil then view.durationSeconds = row.duration_seconds end
  if row.chapters ~= nil then view.chapters = row.chapters end
  local series = json_value(row.series, nil)
  if series ~= nil then view.series = series end
  if row.book_edition ~= nil then view.bookEdition = row.book_edition end
  if row.description ~= nil then view.description = row.description end
  if row.cover_url ~= nil then view.coverUrl = row.cover_url end
  local publisher = json_value(row.publisher, nil)
  if publisher ~= nil then view.publisher = publisher end
  return view
end

function book_view(uri)
  local edition = edition_view(uri)
  if edition == nil then return nil end
  return { uri = uri, edition = edition }
end

local function status_for_shelf(shelf_uri)
  local rkey = rkey_of(shelf_uri)
  if FIXED_SHELVES[rkey] ~= nil then return rkey end
  return nil
end

-- `defs#bookShelfView` for one bookStatus row; nil when the book is unknown.
function book_shelf_view(row)
  local record = record_value(row.record)
  local book_ref = record.book and record.book.uri
  local book = book_view(book_ref)
  if book == nil then return nil end

  local metadata = record.metadata or {}
  if metadata.status == nil then metadata.status = status_for_shelf(record.shelf) end
  if metadata.status == nil then return nil end

  local shelf = shelf_view_for_uri(record.shelf)
  if shelf == nil then return nil end

  local view = {
    ['$type'] = 'net.olamaelcu.livtet.biblio.defs#bookShelfView',
    uri = row.uri,
    shelf = shelf,
    book = book,
    metadata = metadata,
    did = row.did,
  }
  if record.createdAt ~= nil then view.createdAt = record.createdAt end
  if record.updatedAt ~= nil then view.updatedAt = record.updatedAt end
  return view
end

-- `defs#shelfItemView` for one shelfItem row; nil when the book is unknown.
function shelf_item_view(row)
  local record = record_value(row.record)
  local book_ref = record.book and record.book.uri
  local book = book_view(book_ref)
  if book == nil then return nil end
  local shelf = shelf_view_for_uri(record.shelf)
  if shelf == nil then return nil end

  local view = {
    ['$type'] = 'net.olamaelcu.livtet.biblio.defs#shelfItemView',
    uri = row.uri,
    shelf = shelf,
    book = book,
    metadata = record.metadata or {},
    did = row.did,
  }
  if record.createdAt ~= nil then view.createdAt = record.createdAt end
  if record.updatedAt ~= nil then view.updatedAt = record.updatedAt end
  return view
end

function review_view(row)
  return {
    ['$type'] = 'net.olamaelcu.livtet.biblio.defs#reviewView',
    uri = row.uri,
    did = row.did,
    record = record_value(row.record),
  }
end

function paged(rows, limit, build, cursor_for)
  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view = build(rows[i])
    if view ~= nil then out[#out + 1] = view end
  end
  local cursor = nil
  if #rows > limit then cursor = cursor_for(rows[limit]) end
  return toarray(out), cursor
end

-- ---------------------------------------------------------------------------
-- Helpers shared by the XRPC write procedures (scripts/xrpc/procedure/).
--
-- The procedures validate their own input: `input` is whatever JSON the caller
-- posted, so every value is checked for the type the record schema needs
-- before a `Record` is built. These helpers keep that validation identical
-- across the fifteen endpoints.
-- ---------------------------------------------------------------------------

-- Split `at://<did>/<collection>/<rkey>` into its three parts. Returns nil for
-- anything else (a bare DID, a URI with a fragment, four segments, ...).
function at_uri_parts(uri)
  if type(uri) ~= 'string' then return nil end
  local did, coll, rkey = string.match(uri, '^at://([^/]+)/([^/]+)/([^/]+)$')
  if did == nil then return nil end
  return did, coll, rkey
end

-- A DID as atproto writes one: did:<method>:<identifier>.
function is_did(value)
  if type(value) ~= 'string' then return false end
  return string.match(value, '^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$') ~= nil
end

-- A non-empty string, or nil for anything else (missing, JSON null, wrong type).
function string_field(value)
  if type(value) == 'string' and value ~= '' then return value end
  return nil
end

-- An integral JSON number, or nil. Rejects floats such as 1.5.
function integer_field(value)
  if type(value) == 'number' and value == math.floor(value) then return value end
  return nil
end

-- Validate a `com.atproto.repo.strongRef`. Returns a fresh {uri=..., cid=...}
-- table so the caller can assign it to a record field, or nil when the value
-- is not a strongRef with a usable at-uri (and a cid, when require_cid).
function strong_ref(value, require_cid)
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
function merge_fields(target, update, allowed)
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
function copy_table(value)
  local out = {}
  if type(value) == 'table' then
    for key, item in pairs(value) do out[key] = item end
  end
  return out
end
