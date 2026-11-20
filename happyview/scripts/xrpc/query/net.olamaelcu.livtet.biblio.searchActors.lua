-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.searchActors — the readers a picker can name.
--
-- The index already knows which repos hold a book record: a Livtet review or
-- shelving row, a Bookhive book, a Popfeed review or shelf item. This query
-- narrows that set by what the reader typed after `@` — a handle prefix, or
-- part of a display name — and answers the accounts a mention can be written
-- for.
--
-- Handles come from `happyview_linked_repos`, the registry a linked (backfilled)
-- repo is recorded in, because a record carries no handle of its own. An
-- account the index has activity for but no handle for is left out rather than
-- answered as a bare DID: a mention is typed as a handle, and a row without one
-- cannot be named. Display names come from the reader's own Livtet profile
-- record when the index has seen one; they order the answer, never qualify it.

local MAX_QUERY = 50
local DEFAULT_LIMIT = 8
local MAX_LIMIT = 25

-- Escape the LIKE metacharacters a reader can type, so `%` and `_` in a query
-- match themselves instead of widening the search.
local function like_escape(value)
  return (value:gsub('([%%_\\])', '\\%1'))
end

function handle()
  local raw = params.q
  if type(raw) ~= 'string' then
    return fail(400, 'InvalidRequest', '`q` is required')
  end
  local term = raw:match('^%s*(.-)%s*$')
  if term == '' then
    return fail(400, 'InvalidRequest', '`q` is required')
  end
  if #term > MAX_QUERY then
    return fail(400, 'InvalidRequest', '`q` must be at most ' .. MAX_QUERY .. ' characters')
  end

  local limit = clamp_int(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  local needle = like_escape(term:lower())
  local handle_prefix = needle .. '%'
  local name_contains = '%' .. needle .. '%'

  -- The constants are compile-time strings, so the collection list is part of
  -- the statement rather than a parameter Postgres would have to type.
  local collections = table.concat({
    "'" .. REVIEW_COLLECTION .. "'",
    "'" .. BOOK_STATUS .. "'",
    "'" .. BOOKHIVE_BOOK .. "'",
    "'" .. POPFEED_REVIEW .. "'",
    "'" .. POPFEED_LIST_ITEM .. "'",
  }, ', ')

  local rows = db.raw(
    [[WITH readers AS (
        SELECT r.did, max(r.created_at) AS last_activity
          FROM happyview_records AS r
         WHERE r.collection IN (]] .. collections .. [[)
         GROUP BY r.did
      ),
      named AS (
        SELECT readers.did,
               linked.handle,
               readers.last_activity,
               (SELECT (profile.record::jsonb)->>'displayName'
                  FROM happyview_records AS profile
                 WHERE profile.did = readers.did
                   AND profile.collection = ']] .. PROFILE_COLLECTION .. [['
                 ORDER BY profile.created_at DESC
                 LIMIT 1) AS display_name
          FROM readers
          JOIN happyview_linked_repos AS linked ON linked.did = readers.did
         WHERE linked.handle IS NOT NULL
           AND btrim(linked.handle) <> ''
      ),
      matched AS (
        SELECT did, handle, display_name, last_activity,
               lower(handle) LIKE $1 AS handle_hit,
               lower(coalesce(display_name, '')) LIKE $2 AS name_hit
          FROM named
      )
      SELECT did, handle, display_name
        FROM matched
       WHERE handle_hit OR name_hit
       ORDER BY handle_hit DESC, last_activity DESC, lower(handle) ASC
       LIMIT $3]],
    { handle_prefix, name_contains, limit }
  )

  local actors = {}
  for i = 1, #rows do
    local row = rows[i]
    local actor = { did = row.did, handle = row.handle }
    if type(row.display_name) == 'string' and row.display_name ~= '' then
      actor.displayName = row.display_name
    end
    actors[#actors + 1] = actor
  end
  return { actors = toarray(actors) }
end
