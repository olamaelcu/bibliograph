-- Lua 5.1 test harness for the HappyView scripts.
--
-- HappyView runs Lua 5.4, but the scripts avoid 5.4-only syntax so the local
-- `lua5.1` interpreter can exercise them. This harness mirrors hv-deploy's
-- `-- @include` expansion, stubs the runtime globals (`json`, `db.raw`,
-- `Record`, `now`, `TID`, `toarray`) and asserts the cursor, decoding,
-- validation, cache and graph contracts.
--
-- Run: ./happyview/test/run.sh    (syntax-checks luac5.1 -p first)

local root = arg[1] or '.'
local module_root = root .. '/happyview'

-- ---------------------------------------------------------------------------
-- Minimal JSON stub: enough for cursors and record text columns.
-- ---------------------------------------------------------------------------

local json_null = setmetatable({}, { __tostring = function() return 'null' end })
local array_mt = {}

local function toarray(value)
  return setmetatable(value or {}, array_mt)
end

local function is_array(value)
  if getmetatable(value) == array_mt then return true end
  local n = 0
  for key in pairs(value) do
    if type(key) ~= 'number' then return false end
    n = n + 1
  end
  for i = 1, n do
    if value[i] == nil then return false end
  end
  return n > 0
end

local json_escapes = {
  ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
  ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encode_string(value)
  return '"' .. value:gsub('[%c\\"]', function(char)
    return json_escapes[char] or string.format('\\u%04x', string.byte(char))
  end) .. '"'
end

local function encode_value(value)
  local kind = type(value)
  if value == json_null or value == nil then return 'null' end
  if kind == 'boolean' then return value and 'true' or 'false' end
  if kind == 'number' then
    if value ~= value or value == math.huge or value == -math.huge then
      error('cannot encode non-finite number')
    end
    if value == math.floor(value) and math.abs(value) < 1e15 then
      return string.format('%d', value)
    end
    return string.format('%.17g', value)
  end
  if kind == 'string' then return encode_string(value) end
  if kind ~= 'table' then error('cannot encode ' .. kind) end

  local parts = {}
  if is_array(value) then
    for i = 1, #value do parts[#parts + 1] = encode_value(value[i]) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys = {}
  for key in pairs(value) do keys[#keys + 1] = key end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  for _, key in ipairs(keys) do
    parts[#parts + 1] = encode_string(tostring(key)) .. ':' .. encode_value(value[key])
  end
  return '{' .. table.concat(parts, ',') .. '}'
end

local function decode_json(text)
  local pos = 1

  local function fail(message)
    error('json: ' .. message .. ' at byte ' .. pos)
  end

  local function skip_whitespace()
    local _, finish = text:find('^[ \t\r\n]*', pos)
    pos = finish + 1
  end

  local parse_value

  local function parse_string()
    if text:sub(pos, pos) ~= '"' then fail('expected string') end
    pos = pos + 1
    local out = {}
    while true do
      local char = text:sub(pos, pos)
      if char == '' then fail('unterminated string') end
      if char == '"' then
        pos = pos + 1
        return table.concat(out)
      end
      if char == '\\' then
        local escape = text:sub(pos + 1, pos + 1)
        local simple = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }
        if simple[escape] ~= nil then
          out[#out + 1] = simple[escape]
          pos = pos + 2
        elseif escape == 'u' then
          local hex = text:sub(pos + 2, pos + 5)
          out[#out + 1] = string.char(tonumber(hex, 16))
          pos = pos + 6
        else
          fail('unsupported escape')
        end
      else
        out[#out + 1] = char
        pos = pos + 1
      end
    end
  end

  local function parse_number()
    local start = pos
    if text:sub(pos, pos) == '-' then pos = pos + 1 end
    while text:sub(pos, pos):match('%d') do pos = pos + 1 end
    if text:sub(pos, pos) == '.' then
      pos = pos + 1
      while text:sub(pos, pos):match('%d') do pos = pos + 1 end
    end
    local exponent = text:sub(pos, pos)
    if exponent == 'e' or exponent == 'E' then
      pos = pos + 1
      local sign = text:sub(pos, pos)
      if sign == '+' or sign == '-' then pos = pos + 1 end
      while text:sub(pos, pos):match('%d') do pos = pos + 1 end
    end
    local number = tonumber(text:sub(start, pos - 1))
    if number == nil then fail('bad number') end
    return number
  end

  local function parse_object()
    pos = pos + 1
    local out = {}
    skip_whitespace()
    if text:sub(pos, pos) == '}' then
      pos = pos + 1
      return out
    end
    while true do
      skip_whitespace()
      local key = parse_string()
      skip_whitespace()
      if text:sub(pos, pos) ~= ':' then fail('expected colon') end
      pos = pos + 1
      out[key] = parse_value()
      skip_whitespace()
      local char = text:sub(pos, pos)
      if char == '}' then
        pos = pos + 1
        return out
      end
      if char ~= ',' then fail('expected comma') end
      pos = pos + 1
    end
  end

  local function parse_array()
    pos = pos + 1
    local out = toarray({})
    skip_whitespace()
    if text:sub(pos, pos) == ']' then
      pos = pos + 1
      return out
    end
    while true do
      out[#out + 1] = parse_value()
      skip_whitespace()
      local char = text:sub(pos, pos)
      if char == ']' then
        pos = pos + 1
        return out
      end
      if char ~= ',' then fail('expected comma') end
      pos = pos + 1
    end
  end

  parse_value = function()
    skip_whitespace()
    local char = text:sub(pos, pos)
    if char == '{' then return parse_object() end
    if char == '[' then return parse_array() end
    if char == '"' then return parse_string() end
    if char == 't' and text:sub(pos, pos + 3) == 'true' then pos = pos + 4; return true end
    if char == 'f' and text:sub(pos, pos + 4) == 'false' then pos = pos + 5; return false end
    if char == 'n' and text:sub(pos, pos + 3) == 'null' then pos = pos + 4; return json_null end
    if char == '-' or char:match('%d') then return parse_number() end
    fail('unexpected character')
  end

  local value = parse_value()
  skip_whitespace()
  if pos <= #text then fail('trailing data') end
  return value
end

json = {
  null = json_null,
  encode = function(value) return encode_value(value) end,
  decode = function(text) return decode_json(text) end,
}

-- ---------------------------------------------------------------------------
-- Include expansion (mirrors happyview/bin/hv-deploy:expand).
-- ---------------------------------------------------------------------------

local function read_file(path)
  local handle, err = io.open(path, 'r')
  if handle == nil then error('cannot read ' .. path .. ': ' .. tostring(err)) end
  local body = handle:read('*a')
  handle:close()
  return body
end

local function expand(base, body, seen)
  seen = seen or {}
  local out = {}
  for line in (body .. '\n'):gmatch('([^\n]*)\n') do
    local include = line:match('^%s*%-%-%s*@include%s+(.+)$')
    if include == nil then
      out[#out + 1] = line
    else
      local path = base .. '/' .. include:match('^%s*(.-)%s*$')
      if not seen[path] then
        seen[path] = true
        out[#out + 1] = expand(base, read_file(path), seen)
      end
    end
  end
  return table.concat(out, '\n')
end

-- ---------------------------------------------------------------------------
-- Runtime stubs.
-- ---------------------------------------------------------------------------

local function new_env()
  local env = {
    json = json,
    toarray = toarray,
    params = {},
    now = function() return '2026-01-01T00:00:00.000Z' end,
    TID = function() return '3n0000000000a' end,
    log = function() end,
  }
  return setmetatable(env, { __index = _G })
end

local function make_record_api(seed)
  local store = seed or {}
  local options = {}
  local load_all_calls = {}
  local methods = {}

  function methods:save()
    if options.save_error then error(options.save_error) end
    options.saved = (options.saved or 0) + 1
    if self._uri == nil then
      self._uri = 'at://' .. (options.caller_did or 'did:plc:test') .. '/'
        .. (self._collection or 'unknown') .. '/' .. (self._rkey or 'r0')
    end
    store[self._uri] = self
    return self
  end

  function methods:delete()
    if options.delete_error then error(options.delete_error) end
    options.deleted = (options.deleted or 0) + 1
    store[self._uri] = nil
  end

  function methods:set_rkey(key) self._rkey = key end

  local function new_record(collection, data)
    local record = { _collection = collection }
    for key, value in pairs(data or {}) do record[key] = value end
    return setmetatable(record, { __index = methods })
  end

  local Record = setmetatable({}, {
    __call = function(_, collection, data) return new_record(collection, data) end,
  })
  function Record.load(uri) return store[uri] end
  function Record.load_all(uris)
    load_all_calls[#load_all_calls + 1] = uris
    if options.load_all_error then error(options.load_all_error) end
    local out = {}
    for index, uri in ipairs(uris) do out[index] = store[uri] end
    return out
  end
  function Record.save_all(records)
    if options.save_all_error then error(options.save_all_error) end
    options.saved_all = #records
  end

  return { Record = Record, store = store, options = options, load_all_calls = load_all_calls }
end

local function seed_record(api, uri, collection, data)
  local record = api.Record(collection, data)
  record._uri = uri
  api.store[uri] = record
  return record
end

local function count_store(store)
  local count = 0
  for _ in pairs(store) do count = count + 1 end
  return count
end

local function load_helpers()
  local env = new_env()
  env.db = { raw = function() return {} end }
  env.Record = make_record_api().Record
  local body = expand(module_root, read_file(module_root .. '/lib/prelude.lua')) .. [[

return {
  MAX_OFFSET = MAX_OFFSET,
  fail = fail,
  clamp_int = clamp_int,
  json_value = json_value,
  record_value = record_value,
  record_or_null = record_or_null,
  is_did = is_did,
  is_nsid = is_nsid,
  is_rkey = is_rkey,
  at_uri_parts = at_uri_parts,
  string_field = string_field,
  integer_field = integer_field,
  required_string = required_string,
  required_did = required_did,
  required_at_uri = required_at_uri,
  strong_ref = strong_ref,
  merge_fields = merge_fields,
  copy_table = copy_table,
  encode_cursor = encode_cursor,
  decode_cursor = decode_cursor,
  decode_offset = decode_offset,
  offset_cursor = offset_cursor,
  view_cache = view_cache,
  edition_view = edition_view,
  book_view = book_view,
  shelf_view = shelf_view,
  shelf_view_for_uri = shelf_view_for_uri,
  book_shelf_view = book_shelf_view,
  shelf_item_view = shelf_item_view,
  review_view = review_view,
  shelf_ref = shelf_ref,
  owned_shelf = owned_shelf,
  edition_ref = edition_ref,
  shelf_item_metadata = shelf_item_metadata,
  status_metadata = status_metadata,
  pds_save = pds_save,
  pds_delete = pds_delete,
  pds_save_all = pds_save_all,
  pds_load_all = pds_load_all,
}
]]
  local chunk, err = loadstring(body, '@helpers')
  if chunk == nil then error(err) end
  setfenv(chunk, env)
  return chunk(), env
end

local helpers, helpers_env = load_helpers()

local function script_path(kind, name)
  return 'happyview/scripts/xrpc/' .. kind .. '/net.olamaelcu.livtet.biblio.' .. name .. '.lua'
end

local function run_endpoint(kind, name, options)
  options = options or {}
  local calls = {}
  local env = new_env()
  env.params = options.params or {}
  env.input = options.input
  env.caller_did = options.caller_did
  local api = options.RecordAPI or make_record_api()
  env.Record = api.Record
  local responder = options.responder or function() return {} end
  env.db = {
    raw = function(sql, args)
      calls[#calls + 1] = { sql = sql, args = args }
      return responder(sql, args, #calls) or {}
    end,
  }
  local path = script_path(kind, name)
  local body = expand(module_root, read_file(root .. '/' .. path))
  local chunk, err = loadstring(body, '@' .. path)
  if chunk == nil then error(err) end
  setfenv(chunk, env)
  chunk()
  if type(env.handle) ~= 'function' then error('no handle() in ' .. path) end
  return env.handle(), calls, env, api
end

-- ---------------------------------------------------------------------------
-- Assertions and runner.
-- ---------------------------------------------------------------------------

local tests = {}
local function test(name, body) tests[#tests + 1] = { name = name, body = body } end

local function fail_test(message) error(message, 2) end

local function assert_true(value, message)
  if not value then fail_test(message or 'expected truthy value') end
end

local function assert_nil(value, message)
  if value ~= nil then fail_test(message or 'expected nil, got ' .. tostring(value)) end
end

local function assert_equal(actual, expected, message)
  if actual ~= expected then
    fail_test((message or 'values differ') .. ': expected ' .. tostring(expected) .. ', got ' .. tostring(actual))
  end
end

local function assert_contains(haystack, needle, message)
  if not haystack:find(needle, 1, true) then
    fail_test((message or 'missing substring') .. ' `' .. needle .. '` in:\n' .. haystack)
  end
end

local function assert_absent(haystack, needle, message)
  if haystack:find(needle, 1, true) then
    fail_test((message or 'unexpected substring') .. ' `' .. needle .. '` in:\n' .. haystack)
  end
end

-- ---------------------------------------------------------------------------
-- Tests: cursors and offset math.
-- ---------------------------------------------------------------------------

test('cursor round-trips and malformed cursors start at the beginning', function()
  local cursor = helpers.encode_cursor({ o = 42, u = 'at://did:plc:abc/coll/r' })
  assert_equal(type(cursor), 'string')
  local decoded = helpers.decode_cursor(cursor)
  assert_equal(decoded.o, 42)
  assert_equal(decoded.u, 'at://did:plc:abc/coll/r')
  assert_equal(next(helpers.decode_cursor('not-base64!')), nil)
  assert_equal(next(helpers.decode_cursor('')), nil)
  assert_equal(next(helpers.decode_cursor(nil)), nil)
end)

test('offset cursors advance by the emitted page size', function()
  assert_equal(helpers.decode_cursor(helpers.offset_cursor(0, 25)).o, 25)
  assert_equal(helpers.decode_cursor(helpers.offset_cursor(25, 25)).o, 50)
  assert_equal(helpers.decode_offset('3'), 3)
  assert_equal(helpers.decode_offset('-3'), 0)
  assert_equal(helpers.decode_offset('2.9'), 2)
  assert_equal(helpers.decode_offset(nil), 0)
  assert_equal(helpers.decode_offset(0 / 0), 0)
  assert_equal(helpers.decode_offset('nan'), 0)
  assert_equal(helpers.decode_offset('1e400'), helpers.MAX_OFFSET)
  assert_equal(helpers.decode_offset(helpers.MAX_OFFSET + 1), helpers.MAX_OFFSET)
end)

test('every offset endpoint advances by limit, not limit + 1', function()
  local cases = {
    { name = 'getReviewsByBook', params = { book = 'at://did:plc:x/community.lexicon.media.book.edition/abc' } },
    { name = 'listReviewsByActor', params = { did = 'did:plc:x' } },
    { name = 'listShelfItems', params = { shelf = 'at://did:plc:x/net.olamaelcu.livtet.biblio.shelf/read' } },
    { name = 'listShelfItemsByBook', params = { book = 'at://did:plc:x/community.lexicon.media.book.edition/abc', did = 'did:plc:x' } },
    { name = 'getShelvingOfBook', params = { book = 'at://did:plc:x/community.lexicon.media.book.edition/abc', did = 'did:plc:x' } },
  }

  for _, case in ipairs(cases) do
    case.params.limit = '2'
    local rows = {
      { uri = 'at://did:plc:x/coll/a', did = 'did:plc:x', record = '{}', created_at = '2026-01-03T00:00:00.000Z' },
      { uri = 'at://did:plc:x/coll/b', did = 'did:plc:x', record = '{}', created_at = '2026-01-02T00:00:00.000Z' },
      { uri = 'at://did:plc:x/coll/c', did = 'did:plc:x', record = '{}', created_at = '2026-01-01T00:00:00.000Z' },
    }
    local response = run_endpoint('query', case.name, {
      params = case.params,
      responder = function() return rows end,
    })
    assert_true(response.cursor ~= nil, case.name .. ' should emit a cursor')
    assert_equal(helpers.decode_cursor(response.cursor).o, 2, case.name .. ' cursor offset')

    local next_params = {}
    for key, value in pairs(case.params) do next_params[key] = value end
    next_params.cursor = response.cursor
    local _, calls = run_endpoint('query', case.name, {
      params = next_params,
      responder = function() return { rows[1] } end,
    })
    local args = calls[1].args
    assert_equal(args[#args], 2, case.name .. ' next OFFSET')
  end
end)

-- ---------------------------------------------------------------------------
-- Tests: listBooksOnShelf keyset cursor (P0).
-- ---------------------------------------------------------------------------

test('listBooksOnShelf selects created_at and emits a {t,u} cursor', function()
  local shelf = 'at://did:plc:x/net.olamaelcu.livtet.biblio.shelf/reading'
  local rows = {
    { uri = 'at://did:plc:x/net.olamaelcu.livtet.biblio.bookStatus/a', did = 'did:plc:x', record = '{}', created_at = '2026-01-03T00:00:00.000Z' },
    { uri = 'at://did:plc:x/net.olamaelcu.livtet.biblio.bookStatus/b', did = 'did:plc:x', record = '{}', created_at = '2026-01-02T00:00:00.000Z' },
    { uri = 'at://did:plc:x/net.olamaelcu.livtet.biblio.bookStatus/c', did = 'did:plc:x', record = '{}', created_at = '2026-01-01T00:00:00.000Z' },
  }
  local response, calls = run_endpoint('query', 'listBooksOnShelf', {
    params = { shelf = shelf, limit = '2' },
    responder = function() return rows end,
  })

  assert_contains(calls[1].sql, 'SELECT uri, did, record, created_at', 'created_at must be selected')
  assert_contains(calls[1].sql, '(created_at, uri) < ($4, $5)', 'keyset predicate')
  assert_true(response.cursor ~= nil, 'page with a probe row emits a cursor')
  local decoded = helpers.decode_cursor(response.cursor)
  assert_equal(decoded.t, '2026-01-02T00:00:00.000Z', 'cursor timestamp comes from the last scanned row')
  assert_equal(decoded.u, 'at://did:plc:x/net.olamaelcu.livtet.biblio.bookStatus/b')

  local _, next_calls = run_endpoint('query', 'listBooksOnShelf', {
    params = { shelf = shelf, limit = '2', cursor = response.cursor },
    responder = function() return { rows[3] } end,
  })
  assert_equal(next_calls[1].args[4], '2026-01-02T00:00:00.000Z', 'cursor.t is bound')
  assert_equal(next_calls[1].args[5], 'at://did:plc:x/net.olamaelcu.livtet.biblio.bookStatus/b', 'cursor.u is bound')
end)

-- ---------------------------------------------------------------------------
-- Tests: decoding and parameter/URI validation.
-- ---------------------------------------------------------------------------

test('json_value and record_value never return raw undecodable text', function()
  assert_equal(helpers.json_value('{bad', 'fallback'), 'fallback')
  assert_equal(helpers.json_value(nil, 'fallback'), 'fallback')
  assert_equal(helpers.json_value('{"a":1}', nil).a, 1)

  local empty = helpers.record_value('{bad')
  assert_equal(type(empty), 'table')
  assert_equal(next(empty), nil)
  local from_string = helpers.record_value('"text"')
  assert_equal(type(from_string), 'table')
  assert_equal(next(from_string), nil)

  assert_true(helpers.record_or_null('{bad') == json.null)
  assert_true(helpers.record_or_null(nil) == json.null)
  assert_equal(helpers.record_or_null('{"a":1}').a, 1)
end)

test('required params reject nil and empty strings', function()
  assert_equal(helpers.required_string('x', 'name'), 'x')
  local value, err = helpers.required_string('', 'name')
  assert_nil(value)
  assert_true(err ~= nil)

  value, err = helpers.required_did('did:plc:abc', 'did')
  assert_equal(value, 'did:plc:abc')
  assert_nil(err)
  value, err = helpers.required_did('', 'did')
  assert_nil(value)
  assert_true(err ~= nil)
  value, err = helpers.required_did('not-a-did', 'did')
  assert_nil(value)
  assert_true(err ~= nil)

  value, err = helpers.required_at_uri('', 'uri')
  assert_nil(value)
  assert_true(err ~= nil)
  value, err = helpers.required_at_uri('not-a-uri', 'uri')
  assert_nil(value)
  assert_true(err ~= nil)
end)

test('at_uri_parts validates DID, NSID and rkey', function()
  local did, coll, rkey = helpers.at_uri_parts('at://did:plc:abc/net.olamaelcu.livtet.biblio.shelf/read')
  assert_equal(did, 'did:plc:abc')
  assert_equal(coll, 'net.olamaelcu.livtet.biblio.shelf')
  assert_equal(rkey, 'read')

  assert_true(helpers.at_uri_parts('at://did:web:pds.127-0-0-1.sslip.io/net.olamaelcu.livtet.actor.profile/self') ~= nil)
  assert_true(helpers.at_uri_parts('at://did:plc:abc/net.olamaelcu.livtet.biblio.shelfItem/3abc-e1') ~= nil)
  assert_true(helpers.at_uri_parts('at://did:plc:abc/net.olamaelcu.livtet.biblio.bookStatus/3abc') ~= nil)
  assert_true(helpers.at_uri_parts('at://did:plc:abc/net.olamaelcu.livtet.biblio.readingGoal/current') ~= nil)
  assert_true(helpers.at_uri_parts('at://did:plc:abc/coll/rkey#frag') == nil, 'fragment')
  assert_true(helpers.at_uri_parts('at://did:plc:abc/coll/rkey?x=1') == nil, 'query')
  assert_true(helpers.at_uri_parts('at://did:plc:abc/coll/rkey/extra') == nil, 'extra segment')
  assert_true(helpers.at_uri_parts('at://did:plc:abc/coll/') == nil, 'empty rkey')
  assert_true(helpers.at_uri_parts('at://notadid/coll/rkey') == nil, 'bad DID')
  assert_true(helpers.at_uri_parts('at://did:plc:abc/notansid/rkey') == nil, 'bad NSID')
  assert_true(helpers.at_uri_parts('at://did:plc:abc/coll/..') == nil, 'reserved rkey')
  assert_true(helpers.at_uri_parts('at://did:plc:abc/coll/bad key') == nil, 'space in rkey')
  assert_true(helpers.at_uri_parts(nil) == nil)
end)

test('clamp_int floors, defaults and rejects NaN', function()
  assert_equal(helpers.clamp_int('10', 5, 1, 100), 10)
  assert_equal(helpers.clamp_int('0', 5, 1, 100), 1)
  assert_equal(helpers.clamp_int('2.9', 5, 1, 100), 2)
  assert_equal(helpers.clamp_int(nil, 5, 1, 100), 5)
  assert_equal(helpers.clamp_int('nan', 5, 1, 100), 5)
  assert_equal(helpers.clamp_int('1000', 5, 1, 100), 100)
end)

-- ---------------------------------------------------------------------------
-- Tests: per-request view cache.
-- ---------------------------------------------------------------------------

test('view caches deduplicate edition and shelf lookups', function()
  local edition_queries, shelf_queries = 0, 0
  helpers_env.db = {
    raw = function(sql, args)
      if sql:find('appview_book_lua', 1, true) then
        edition_queries = edition_queries + 1
        if args[1] == 'at://missing' then return {} end
        return { { uri = args[1], title = 'Title', identifiers = '[]', contributors = '[]', created_at = '2026-01-01T00:00:00.000Z' } }
      end
      shelf_queries = shelf_queries + 1
      return { { record = '{"name":"Shelf"}' } }
    end,
  }

  local cache = helpers.view_cache()
  local first = helpers.edition_view('at://edition/1', cache)
  local again = helpers.edition_view('at://edition/1', cache)
  assert_true(first == again, 'same edition returns the cached table')
  assert_equal(edition_queries, 1)

  assert_nil(helpers.edition_view('at://missing', cache))
  assert_nil(helpers.edition_view('at://missing', cache))
  assert_equal(edition_queries, 2, 'a cached miss is not queried twice')

  local shelf_uri = 'at://did:plc:x/net.olamaelcu.livtet.biblio.shelf/read'
  local shelf_one = helpers.shelf_view_for_uri(shelf_uri, cache)
  local shelf_two = helpers.shelf_view_for_uri(shelf_uri, cache)
  assert_true(shelf_one == shelf_two)
  assert_equal(shelf_queries, 1)

  local rows = {
    { uri = 'u1', did = 'did:plc:x', record = '{"book":{"uri":"at://edition/2"},"shelf":"' .. shelf_uri .. '","metadata":{"status":"read"}}' },
    { uri = 'u2', did = 'did:plc:x', record = '{"book":{"uri":"at://edition/2"},"shelf":"' .. shelf_uri .. '","metadata":{"status":"read"}}' },
  }
  local request_cache = helpers.view_cache()
  local editions_before, shelves_before = edition_queries, shelf_queries
  assert_true(helpers.book_shelf_view(rows[1], request_cache) ~= nil)
  assert_true(helpers.book_shelf_view(rows[2], request_cache) ~= nil)
  assert_equal(edition_queries, editions_before + 1, 'edition looked up once per request')
  assert_equal(shelf_queries, shelves_before + 1, 'shelf looked up once per request')
end)

test('listShelvesWithBooks reuses one edition lookup across shelves', function()
  local edition_uri = 'at://did:plc:x/community.lexicon.media.book.edition/e1'
  local counts = { edition = 0, entries = 0, shelf = 0 }
  local shelf_rows = {
    { uri = 'at://did:plc:x/net.olamaelcu.livtet.biblio.shelf/s1', did = 'did:plc:x', record = '{"name":"S1"}' },
    { uri = 'at://did:plc:x/net.olamaelcu.livtet.biblio.shelf/s2', did = 'did:plc:x', record = '{"name":"S2"}' },
    { uri = 'at://did:plc:x/net.olamaelcu.livtet.biblio.shelf/s3', did = 'did:plc:x', record = '{"name":"S3"}' },
  }

  local response = run_endpoint('query', 'listShelvesWithBooks', {
    params = { limit = '2' },
    responder = function(sql, args)
      if sql:find('appview_book_lua', 1, true) then
        counts.edition = counts.edition + 1
        return { { title = 'Title', identifiers = '[]', contributors = '[]', created_at = '2026-01-01T00:00:00.000Z' } }
      end
      if sql:find("(record::jsonb)->>'shelf'", 1, true) and sql:find('collection = $1 AND did = $2', 1, true) then
        counts.entries = counts.entries + 1
        return { {
          uri = 'at://did:plc:x/net.olamaelcu.livtet.biblio.bookStatus/e1',
          did = 'did:plc:x',
          record = '{"book":{"uri":"' .. edition_uri .. '"},"shelf":"' .. args[3] .. '","metadata":{"status":"read"}}',
        } }
      end
      if sql:find('SELECT record FROM happyview_records', 1, true) then
        counts.shelf = counts.shelf + 1
        return { { record = '{"name":"Shelf"}' } }
      end
      return shelf_rows
    end,
  })

  assert_equal(#response.shelves, 2)
  assert_equal(counts.entries, 2)
  assert_equal(counts.shelf, 2)
  assert_equal(counts.edition, 1, 'edition is cached across both shelves')
end)

-- ---------------------------------------------------------------------------
-- Tests: graph totals and follow predicates (P1).
-- ---------------------------------------------------------------------------

test('listFollowees derives did from subject and pages on TID rkey', function()
  local follow_rows = {
    { uri = 'u1', did = 'did:plc:d', record = '{"createdAt":"2026-01-01T00:00:00.000Z"}', created_at = '2026-02-01T00:00:00.000Z', rkey = '3n0000000000a', subject = 'did:plc:a' },
    { uri = 'u2', did = 'did:plc:d', record = '{}', created_at = '2026-02-02T00:00:00.000Z', rkey = '3n0000000000b', subject = 'at://did:plc:b' },
    { uri = 'u3', did = 'did:plc:d', record = '{}', created_at = '2026-02-03T00:00:00.000Z', rkey = '3n0000000000c', subject = 'did:plc:c' },
  }
  local responder = function(sql)
    if sql:find('count(*)', 1, true) then return { { n = 7 } } end
    return follow_rows
  end

  local response, calls = run_endpoint('query', 'graph.listFollowees', {
    params = { did = 'did:plc:d', limit = '2' },
    responder = responder,
  })

  assert_equal(response.total, 7, 'total is present on a full page')
  assert_equal(response.followees[1].did, 'did:plc:a')
  assert_equal(response.followees[2].did, 'did:plc:b', 'legacy at://did is normalized')
  assert_equal(response.followees[2].followedAt, '2026-02-02T00:00:00.000Z', 'falls back to selected created_at')
  assert_equal(response.cursor, '3n0000000000b', 'cursor is the last TID rkey')

  assert_contains(calls[1].sql, 'created_at')
  assert_contains(calls[1].sql, 'rkey')
  assert_contains(calls[1].sql, "->>'subject'")
  assert_absent(calls[1].sql, 'subject_did')
  assert_absent(calls[1].sql, 'split_part')

  local cursor_response, cursor_calls = run_endpoint('query', 'graph.listFollowees', {
    params = { did = 'did:plc:d', limit = '2', cursor = '3n0000000000a' },
    responder = responder,
  })
  assert_equal(cursor_response.total, 7, 'total is present on later pages')
  assert_equal(cursor_calls[1].args[3], '3n0000000000a')

  local legacy_cursor_calls
  _, legacy_cursor_calls = run_endpoint('query', 'graph.listFollowees', {
    params = { did = 'did:plc:d', limit = '2', cursor = 'did:plc:a' },
    responder = responder,
  })
  assert_equal(legacy_cursor_calls[1].args[3], '', 'a pre-TID DID cursor restarts the page')

  local empty_response = run_endpoint('query', 'graph.listFollowees', {
    params = { did = 'did:plc:d' },
    responder = function(sql)
      if sql:find('count(*)', 1, true) then return { { n = 0 } } end
      return {}
    end,
  })
  assert_equal(empty_response.total, 0, 'empty page still has total')
end)

test('listFollowers always emits total and matches did:/at:// subjects', function()
  local follow_rows = {
    { uri = 'u1', did = 'did:plc:a', record = '{"createdAt":"2026-01-01T00:00:00.000Z"}', created_at = '2026-02-01T00:00:00.000Z' },
    { uri = 'u2', did = 'did:plc:b', record = '{}', created_at = '2026-02-02T00:00:00.000Z' },
    { uri = 'u3', did = 'did:plc:c', record = '{}', created_at = '2026-02-03T00:00:00.000Z' },
  }
  local responder = function(sql)
    if sql:find('count(*)', 1, true) then return { { n = 9 } } end
    return follow_rows
  end

  local response, calls = run_endpoint('query', 'graph.listFollowers', {
    params = { did = 'did:plc:d', limit = '2' },
    responder = responder,
  })

  assert_equal(response.total, 9)
  assert_equal(response.followers[2].followedAt, '2026-02-02T00:00:00.000Z')
  assert_equal(response.cursor, 'did:plc:b')
  assert_contains(calls[1].sql, 'created_at')
  assert_contains(calls[1].sql, "'at://'")
  assert_absent(calls[1].sql, 'split_part')

  local cursor_response = run_endpoint('query', 'graph.listFollowers', {
    params = { did = 'did:plc:d', limit = '2', cursor = 'did:plc:a' },
    responder = responder,
  })
  assert_equal(cursor_response.total, 9, 'total survives the cursor page')
end)

test('isFollowing matches both subject spellings without split_part', function()
  local response, calls = run_endpoint('query', 'graph.isFollowing', {
    params = { follower = 'did:plc:a', followed = 'did:plc:b' },
    responder = function() return { { found = 1 } } end,
  })
  assert_true(response.following)
  assert_contains(calls[1].sql, "'at://'")
  assert_absent(calls[1].sql, 'split_part')
  assert_absent(calls[1].sql, 'regexp_replace')
end)

-- ---------------------------------------------------------------------------
-- Tests: follow writes now use TID rkeys and look up by subject.
-- ---------------------------------------------------------------------------

test('graph.follow writes a fresh TID rkey and is idempotent by subject', function()
  local api = make_record_api()
  local responder = function(sql, args)
    local out = {}
    for _, record in pairs(api.store) do
      if record._collection == 'net.olamaelcu.livtet.biblio.follow' then
        local subject = record.subject
        if subject == args[3] or subject == 'at://' .. args[3] then
          out[#out + 1] = { uri = record._uri }
        end
      end
    end
    return out
  end

  local first = run_endpoint('procedure', 'graph.follow', {
    input = { subject = 'did:plc:target' },
    caller_did = 'did:plc:caller',
    responder = responder,
    RecordAPI = api,
  })
  assert_true(first.created)
  local rkey = first.uri:match('([^/]+)$')
  assert_equal(#rkey, 13, 'rkey is a 13-character TID')
  assert_true(rkey ~= 'did:plc:target', 'rkey is not the subject DID')
  assert_equal(api.options.saved, 1)
  assert_equal(count_store(api.store), 1)
  assert_equal(api.store[first.uri].subject, 'did:plc:target')

  local second = run_endpoint('procedure', 'graph.follow', {
    input = { subject = 'did:plc:target' },
    caller_did = 'did:plc:caller',
    responder = responder,
    RecordAPI = api,
  })
  assert_equal(second.created, false)
  assert_equal(second.uri, first.uri)
  assert_equal(api.options.saved, 1, 'second call does not save')
  assert_equal(count_store(api.store), 1, 'still exactly one follow')
end)

test('graph.follow keeps DID and self-follow validation', function()
  local api = make_record_api()
  local bad = run_endpoint('procedure', 'graph.follow', {
    input = { subject = 'not-a-did' },
    caller_did = 'did:plc:caller',
    responder = function() error('no SQL expected') end,
    RecordAPI = api,
  })
  assert_equal(bad.__bib_http.status, 400)

  local self = run_endpoint('procedure', 'graph.follow', {
    input = { subject = 'did:plc:caller' },
    caller_did = 'did:plc:caller',
    responder = function() error('no SQL expected') end,
    RecordAPI = api,
  })
  assert_equal(self.__bib_http.status, 400)
end)

test('graph.follow matches a legacy at://did subject', function()
  local api = make_record_api()
  local legacy_uri = 'at://did:plc:caller/net.olamaelcu.livtet.biblio.follow/did:plc:target'
  seed_record(api, legacy_uri, 'net.olamaelcu.livtet.biblio.follow', { subject = 'at://did:plc:target' })

  local response = run_endpoint('procedure', 'graph.follow', {
    input = { subject = 'did:plc:target' },
    caller_did = 'did:plc:caller',
    responder = function() return { { uri = legacy_uri } } end,
    RecordAPI = api,
  })
  assert_equal(response.created, false)
  assert_equal(response.uri, legacy_uri)
  assert_nil(api.options.saved)
end)

test('graph.follow finds a legacy subject-DID rkey follow via its URI', function()
  local api = make_record_api()
  local legacy_uri = 'at://did:plc:caller/net.olamaelcu.livtet.biblio.follow/did:plc:target'
  seed_record(api, legacy_uri, 'net.olamaelcu.livtet.biblio.follow', { subject = 'not-a-did' })

  local response = run_endpoint('procedure', 'graph.follow', {
    input = { subject = 'did:plc:target' },
    caller_did = 'did:plc:caller',
    responder = function() return {} end,
    RecordAPI = api,
  })
  assert_equal(response.created, false)
  assert_equal(response.uri, legacy_uri)
  assert_nil(api.options.saved)
end)

test('graph.unfollow finds by subject and deletes the TID record', function()
  local api = make_record_api()
  local target = 'did:plc:target'
  local tid_uri = 'at://did:plc:caller/net.olamaelcu.livtet.biblio.follow/3n0000000000a'
  seed_record(api, tid_uri, 'net.olamaelcu.livtet.biblio.follow', { subject = target })

  local response, calls = run_endpoint('procedure', 'graph.unfollow', {
    input = { subject = target },
    caller_did = 'did:plc:caller',
    responder = function(sql)
      assert_contains(sql, "->>'subject'")
      assert_contains(sql, "'at://'")
      return { { uri = tid_uri } }
    end,
    RecordAPI = api,
  })

  assert_equal(response.uri, tid_uri)
  assert_equal(api.options.deleted, 1)
  assert_nil(api.store[tid_uri])
end)

test('graph.unfollow deletes every matching row', function()
  local api = make_record_api()
  local target = 'did:plc:target'
  local tid_uri = 'at://did:plc:caller/net.olamaelcu.livtet.biblio.follow/3n0000000000a'
  local legacy_uri = 'at://did:plc:caller/net.olamaelcu.livtet.biblio.follow/did:plc:target'
  seed_record(api, tid_uri, 'net.olamaelcu.livtet.biblio.follow', { subject = target })
  seed_record(api, legacy_uri, 'net.olamaelcu.livtet.biblio.follow', { subject = 'at://' .. target })

  local response = run_endpoint('procedure', 'graph.unfollow', {
    input = { subject = target },
    caller_did = 'did:plc:caller',
    responder = function() return { { uri = tid_uri }, { uri = legacy_uri } } end,
    RecordAPI = api,
  })

  assert_equal(response.uri, tid_uri)
  assert_equal(api.options.deleted, 2, 'both the TID and legacy rows are deleted')
  assert_nil(api.store[tid_uri])
  assert_nil(api.store[legacy_uri])
end)

test('graph.unfollow finds a legacy subject-DID rkey record via its URI', function()
  local api = make_record_api()
  local legacy_uri = 'at://did:plc:caller/net.olamaelcu.livtet.biblio.follow/did:plc:target'
  seed_record(api, legacy_uri, 'net.olamaelcu.livtet.biblio.follow', { subject = 'not-a-did' })

  local response = run_endpoint('procedure', 'graph.unfollow', {
    input = { subject = 'did:plc:target' },
    caller_did = 'did:plc:caller',
    responder = function() return {} end,
    RecordAPI = api,
  })
  assert_equal(response.uri, legacy_uri)
  assert_equal(api.options.deleted, 1)
end)

test('graph.unfollow answers 404 when nothing matches', function()
  local response = run_endpoint('procedure', 'graph.unfollow', {
    input = { subject = 'did:plc:target' },
    caller_did = 'did:plc:caller',
    responder = function() return {} end,
    RecordAPI = make_record_api(),
  })
  assert_equal(response.__bib_http.status, 404)
end)

-- ---------------------------------------------------------------------------
-- Tests: record-shaped outputs.
-- ---------------------------------------------------------------------------

test('getActorProfile and getReadingGoal return decoded objects or json.null', function()
  local profile = run_endpoint('query', 'getActorProfile', {
    params = { did = 'did:plc:abc' },
    responder = function() return { { record = '{"displayName":"Ada","createdAt":"x","updatedAt":"y"}' } } end,
  })
  assert_equal(type(profile.profile), 'table')
  assert_equal(profile.profile.displayName, 'Ada')

  local malformed = run_endpoint('query', 'getActorProfile', {
    params = { did = 'did:plc:abc' },
    responder = function() return { { record = '{bad' } } end,
  })
  assert_true(malformed.profile == json.null)

  local missing = run_endpoint('query', 'getActorProfile', {
    params = { did = 'did:plc:abc' },
    responder = function() return {} end,
  })
  assert_true(missing.profile == json.null)

  local invalid = run_endpoint('query', 'getActorProfile', {
    params = { did = '' },
    responder = function() return {} end,
  })
  assert_equal(invalid.__bib_http.status, 400)

  local goal = run_endpoint('query', 'getReadingGoal', {
    params = { did = 'did:plc:abc' },
    responder = function() return { { record = '{"period":"annual","year":2026,"booksGoal":12}' } } end,
  })
  assert_equal(type(goal.goal), 'table')
  assert_equal(goal.goal.year, 2026)

  local no_goal = run_endpoint('query', 'getReadingGoal', {
    params = { did = 'did:plc:abc' },
    responder = function() return {} end,
  })
  assert_true(no_goal.goal == json.null)
end)

test('getReviewsByBook reads the appview_book_lua identifier bag', function()
  local _, calls = run_endpoint('query', 'getReviewsByBook', {
    params = { book = 'at://did:plc:x/community.lexicon.media.book.edition/abc' },
    responder = function() return {} end,
  })
  local sql = calls[1].sql
  assert_contains(sql, 'appview_book_lua')
  assert_absent(sql, 'edition_identifiers')
  assert_absent(sql, 'SELECT *')

  helpers_env.db = {
    raw = function()
      return {}
    end,
  }
  helpers.edition_view('at://edition/1')
end)

test('edition_view selects explicit columns', function()
  local captured
  helpers_env.db = {
    raw = function(sql)
      captured = sql
      return {}
    end,
  }
  helpers.edition_view('at://edition/1')
  assert_absent(captured, 'SELECT *')
  assert_contains(captured, 'identifiers')
  assert_contains(captured, 'contributors')
end)

-- ---------------------------------------------------------------------------
-- Tests: shelf existence and PDS wrappers.
-- ---------------------------------------------------------------------------

test('owned_shelf checks ownership and existence', function()
  local api = make_record_api()
  local shelf_uri = 'at://did:plc:owner/net.olamaelcu.livtet.biblio.shelf/3abc'
  seed_record(api, shelf_uri, 'net.olamaelcu.livtet.biblio.shelf', { name = 'Shelf' })
  helpers_env.caller_did = 'did:plc:owner'
  helpers_env.Record = api.Record

  local shelf, failure = helpers.owned_shelf(shelf_uri)
  assert_true(shelf ~= nil)
  assert_nil(failure)
  assert_equal(shelf.rkey, '3abc')
  assert_true(shelf.record ~= nil)

  local _, foreign = helpers.owned_shelf('at://did:plc:other/net.olamaelcu.livtet.biblio.shelf/3abc')
  assert_equal(foreign.__bib_http.status, 403)

  local _, missing = helpers.owned_shelf('at://did:plc:owner/net.olamaelcu.livtet.biblio.shelf/missing')
  assert_equal(missing.__bib_http.status, 404)

  local _, bad = helpers.owned_shelf('not-a-uri')
  assert_equal(bad.__bib_http.status, 400)
end)

test('status.set, shelf.addItem and shelf.addBooks reject an unknown shelf', function()
  local book = { uri = 'at://did:plc:owner/community.lexicon.media.book.edition/abc', cid = 'bafy' }
  local missing = 'at://did:plc:owner/net.olamaelcu.livtet.biblio.shelf/missing'

  local status = run_endpoint('procedure', 'status.set', {
    input = { book = book, status = 'read', shelf = missing },
    caller_did = 'did:plc:owner',
    responder = function() error('no SQL expected') end,
  })
  assert_equal(status.__bib_http.status, 404)

  local item = run_endpoint('procedure', 'shelf.addItem', {
    input = { shelf = missing, book = book },
    caller_did = 'did:plc:owner',
    responder = function() error('no SQL expected') end,
  })
  assert_equal(item.__bib_http.status, 404)

  local books = run_endpoint('procedure', 'shelf.addBooks', {
    input = { shelf = missing, books = { book } },
    caller_did = 'did:plc:owner',
    responder = function() error('no SQL expected') end,
  })
  assert_equal(books.__bib_http.status, 404)
end)

test('pds wrappers turn save/delete failures into 502 UpstreamFailure', function()
  local failure = helpers.pds_save({ save = function() error('write failed') end })
  assert_equal(failure.__bib_http.status, 502)
  assert_equal(failure.__bib_http.body.error, 'UpstreamFailure')
  assert_nil(helpers.pds_save({ save = function() end }))

  failure = helpers.pds_delete({ delete = function() error('delete failed') end })
  assert_equal(failure.__bib_http.status, 502)

  helpers_env.Record = { save_all = function() error('batch failed') end }
  failure = helpers.pds_save_all({})
  assert_equal(failure.__bib_http.status, 502)

  helpers_env.Record = { load_all = function() return { 'a', nil } end }
  local records, err = helpers.pds_load_all({ 'a', 'b' })
  assert_equal(records[1], 'a')
  assert_nil(records[2])
  assert_nil(err)

  helpers_env.Record = { load_all = function() error('load failed') end }
  records, err = helpers.pds_load_all({})
  assert_nil(records)
  assert_true(err ~= nil)
end)

-- ---------------------------------------------------------------------------
-- Tests: shelf.delete cascade.
-- ---------------------------------------------------------------------------

test('shelf.delete filters in SQL and batches Record.load_all', function()
  local api = make_record_api()
  local shelf_uri = 'at://did:plc:owner/net.olamaelcu.livtet.biblio.shelf/3abc'
  local item_one = 'at://did:plc:owner/net.olamaelcu.livtet.biblio.shelfItem/3abc-e1'
  local item_two = 'at://did:plc:owner/net.olamaelcu.livtet.biblio.shelfItem/3abc-e2'
  local status_one = 'at://did:plc:owner/net.olamaelcu.livtet.biblio.bookStatus/e1'
  seed_record(api, shelf_uri, 'net.olamaelcu.livtet.biblio.shelf', { name = 'Shelf' })
  seed_record(api, item_one, 'net.olamaelcu.livtet.biblio.shelfItem', {})
  seed_record(api, item_two, 'net.olamaelcu.livtet.biblio.shelfItem', {})
  seed_record(api, status_one, 'net.olamaelcu.livtet.biblio.bookStatus', {})

  local response, calls = run_endpoint('procedure', 'shelf.delete', {
    input = { shelf = shelf_uri },
    caller_did = 'did:plc:owner',
    RecordAPI = api,
    responder = function(sql, args)
      assert_contains(sql, "(record::jsonb)->>'shelf' = $3")
      assert_contains(sql, 'did = $1')
      assert_contains(sql, 'collection = $2')
      assert_equal(args[1], 'did:plc:owner')
      assert_equal(args[3], shelf_uri)
      if args[2] == 'net.olamaelcu.livtet.biblio.shelfItem' then
        return { { uri = item_one }, { uri = item_two } }
      end
      if args[2] == 'net.olamaelcu.livtet.biblio.bookStatus' then
        return { { uri = status_one } }
      end
      error('unexpected collection ' .. tostring(args[2]))
    end,
  })

  assert_equal(response.deleted, 4)
  assert_equal(api.options.deleted, 4)
  assert_equal(#api.load_all_calls, 1, 'one batched load_all for every dependent')
  assert_equal(#api.load_all_calls[1], 3)

  local missing = run_endpoint('procedure', 'shelf.delete', {
    input = { shelf = shelf_uri },
    caller_did = 'did:plc:owner',
    RecordAPI = make_record_api(),
    responder = function() error('no SQL expected') end,
  })
  assert_equal(missing.__bib_http.status, 404)
end)

-- ---------------------------------------------------------------------------
-- Tests: expansion parses and every endpoint loads.
-- ---------------------------------------------------------------------------

test('every expanded endpoint parses', function()
  local directories = { 'query', 'procedure' }
  for _, kind in ipairs(directories) do
    local pipe = io.popen('ls ' .. root .. '/happyview/scripts/xrpc/' .. kind .. '/*.lua')
    for path in pipe:lines() do
      local body = expand(module_root, read_file(path))
      local chunk, err = loadstring(body, '@' .. path)
      assert_true(chunk ~= nil, 'parse ' .. path .. ': ' .. tostring(err))
    end
    pipe:close()
  end
end)

-- ---------------------------------------------------------------------------
-- Run.
-- ---------------------------------------------------------------------------

local failures = 0
for _, case in ipairs(tests) do
  local ok, err = pcall(case.body)
  if ok then
    print('ok - ' .. case.name)
  else
    failures = failures + 1
    print('not ok - ' .. case.name)
    print('  ' .. tostring(err))
  end
end

print(string.format('%d tests, %d failures', #tests, failures))
os.exit(failures == 0 and 0 or 1)
