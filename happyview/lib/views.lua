-- View builders for the lexicon's embedded objects, plus the per-request
-- lookup cache. Included by lib/prelude.lua.
--
-- A request builds one `view_cache()` in `handle()` and threads it through the
-- builders. It must never be stored at module scope: HappyView evaluates module
-- scope once and reuses it across requests.

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

-- Contributor roles are ONIX Codelist 17 codes (lexicon.community PR #18);
-- rows ingested before that change stored the old kebab-case tokens. Keep this
-- table in sync with packages/worker/lib/contributor-roles.js.
local function contributor_role(value)
  if type(value) ~= 'string' then return 'A01' end
  local token = value:match('^%s*(.-)%s*$')
  if token == '' then return 'A01' end
  if token:match('^%u%d%d$') then return token end
  return LEGACY_CONTRIBUTOR_ROLES[token:lower()] or token
end

local function rkey_of(uri)
  if uri == nil then return '' end
  return string.match(uri, '([^/]+)$') or ''
end

local function did_of(uri)
  if uri == nil then return nil end
  return string.match(uri, '^at://([^/]+)')
end

-- Per-request cache for the two lookups a page repeats across rows: the
-- catalog edition and a shelf record. A `false` entry records a miss so a
-- missing record is not queried twice either.
local function view_cache()
  return { editions = {}, shelves = {} }
end

-- `community.lexicon.media.book.defs#editionView` from appview_book_lua.
-- Explicit columns: the view is a text projection and `SELECT *` would fetch
-- the unused `publishers`/`rkey` columns too.
local function edition_view(uri, cache)
  if uri == nil then return nil end
  if cache ~= nil then
    local hit = cache.editions[uri]
    if hit ~= nil then
      if hit == false then return nil end
      return hit
    end
  end

  local rows = db.raw(
    [[SELECT uri, title, subtitle, language, published_date, format, pages,
             duration_seconds, chapters, series, book_edition, description,
             cover_url, created_at, contributors, publisher, identifiers
        FROM appview_book_lua WHERE uri = $1 LIMIT 1]],
    { uri }
  )
  local row = rows[1]
  if row == nil then
    if cache ~= nil then cache.editions[uri] = false end
    return nil
  end

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

  if cache ~= nil then cache.editions[uri] = view end
  return view
end

local function book_view(uri, cache)
  local edition = edition_view(uri, cache)
  if edition == nil then return nil end
  return { uri = uri, edition = edition }
end

-- One shelf record (or a derived fixed shelf) as `defs#shelfView`.
local function shelf_view(uri, record)
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

local function shelf_view_for_uri(uri, cache)
  if uri == nil then return nil end
  if cache ~= nil then
    local hit = cache.shelves[uri]
    if hit ~= nil then
      if hit == false then return nil end
      return hit
    end
  end
  local rows = db.raw(
    'SELECT record FROM happyview_records WHERE uri = $1 AND collection = $2 LIMIT 1',
    { uri, SHELF_COLLECTION }
  )
  local view = shelf_view(uri, rows[1] and rows[1].record)
  if cache ~= nil then cache.shelves[uri] = view or false end
  return view
end

local function status_for_shelf(shelf_uri)
  local rkey = rkey_of(shelf_uri)
  if FIXED_SHELVES[rkey] ~= nil then return rkey end
  return nil
end

-- The shelf a bookStatus row is filed under. Current rows carry `shelf`; rows
-- written while it was optional carry only a status, so the shelf is the fixed
-- reading-status shelf that status names.
local function shelf_uri_of(row, record)
  local shelf = record.shelf
  if type(shelf) == 'string' and shelf ~= '' then return shelf end
  local status = fixed_status(record.metadata and record.metadata.status)
  if status == nil or type(row.did) ~= 'string' then return nil end
  return 'at://' .. row.did .. '/' .. SHELF_COLLECTION .. '/' .. status
end

-- `defs#bookShelfView` for one bookStatus row; nil when the book is unknown.
local function book_shelf_view(row, cache)
  local record = record_value(row.record)
  local book_ref = record.book and record.book.uri
  local book = book_view(book_ref, cache)
  if book == nil then return nil end

  local shelf_uri = shelf_uri_of(row, record)
  local metadata = record.metadata or {}
  if metadata.status == nil then metadata.status = status_for_shelf(shelf_uri) end
  if metadata.status == nil then return nil end

  local shelf = shelf_view_for_uri(shelf_uri, cache)
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
local function shelf_item_view(row, cache)
  local record = record_value(row.record)
  local book_ref = record.book and record.book.uri
  local book = book_view(book_ref, cache)
  if book == nil then return nil end
  local shelf = shelf_view_for_uri(record.shelf, cache)
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

-- Either shelf view, chosen by the row's collection. A `bookStatus` row and a
-- `shelfItem` row both say "this book is on that shelf"; only the first also
-- carries a reading status.
local function shelf_entry_view(row, cache)
  if row.collection == SHELF_ITEM then return shelf_item_view(row, cache) end
  return book_shelf_view(row, cache)
end

local function review_view(row)
  return {
    ['$type'] = 'net.olamaelcu.livtet.biblio.defs#reviewView',
    uri = row.uri,
    did = row.did,
    record = record_value(row.record),
  }
end
