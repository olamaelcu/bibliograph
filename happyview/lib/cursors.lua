-- Opaque pagination cursors: base64url-encoded JSON objects. A malformed
-- cursor decodes to `{}` and restarts at the beginning, matching the documented
-- surface behavior. Included by lib/prelude.lua.

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

local function encode_cursor(value)
  return b64url_encode(json.encode(value))
end

-- Decode a cursor into a table. Invalid base64, invalid JSON, and non-object
-- payloads all yield `{}` so the caller starts a fresh page.
local function decode_cursor(raw)
  if raw == nil or raw == '' then return {} end
  local decoded = b64url_decode(raw)
  if decoded == nil then return {} end
  local ok, value = pcall(json.decode, decoded)
  if ok and type(value) == 'table' then return value end
  return {}
end

-- A non-negative, integral OFFSET decoded from a cursor. NaN, negatives,
-- non-numbers and floats are normalized here so Postgres never receives an
-- invalid OFFSET; `MAX_OFFSET` caps hostile values.
local function decode_offset(raw)
  local n = tonumber(raw)
  if n == nil or n ~= n then return 0 end
  if n < 0 then return 0 end
  n = math.floor(n)
  if n > MAX_OFFSET then return MAX_OFFSET end
  return n
end

-- The cursor for the next offset page. A page scans `limit` rows plus one probe
-- row but only emits those `limit` rows, so the next page starts at
-- `offset + limit`; advancing by the probe (`limit + 1`) would skip a row.
local function offset_cursor(offset, limit)
  local next_offset = decode_offset(offset) + decode_offset(limit)
  if next_offset > MAX_OFFSET then next_offset = MAX_OFFSET end
  return encode_cursor({ o = next_offset })
end
