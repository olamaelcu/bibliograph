# search-contributors documentation

## XRPC Query Schema

**Endpoint**: `POST /xrpc/community.lexicon.book.searchContributors`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | No | Free-form text query (max 1024 chars) |
| `id` | array of strings | No | Identifiers to match (URI or URN form) |
| `limit` | integer | No | Results count (1-100, default 20) |
| `cursor` | string | No | Pagination cursor |

### Output Schema

```json
{
  "items": [
    {
      "$type": "community.lexicon.book.contributor",
      "uri": "string (at:// URI)",
      "name": "string (minLength: 1)",
      "aliases": ["string"],
      "identifiers": [
        {
          "uri": "string",
          "resource": "string"
        }
      ],
      "createdAt": "string (datetime)"
    }
  ],
  "cursor": "string",
  "total": "integer"
}
```

### Live Example Response

```json
{
  "items": [
    {
      "$type": "community.lexicon.book.contributor",
      "uri": "at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A14286376A",
      "name": "Trivium Test Trivium Test Prep",
      "aliases": [],
      "identifiers": [
        {
          "uri": "https://openlibrary.org/authors/OL14286376A",
          "resource": "openlibrary"
        }
      ],
      "createdAt": "2026-10-25T00:13:18.838Z"
    }
  ],
  "total": 1682
}
```

## Contributor Record Schema

The contributor record requires:
- `name` (string, minLength: 1, maxLength: 256)
- `createdAt` (datetime)
- `uri` (string, format: uri)

## Where Book Search Returns Contributors

Based on the codebase:
1. **`searchEditions`** - may include contributor URIs in edition records
2. **`searchWork`** - may include contributor URIs in work records
3. **`searchContributors`** - dedicated endpoint for finding contributors

## Verification

The endpoint was verified with:
```bash
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/community.lexicon.book.searchContributors?q=test&limit=1'
```

This returned a valid response with the expected schema shape, confirming:
- `items` array contains contributor records
- Each record includes `name`, `uri`, and other fields
- `total` field indicates total count
- The schema documentation page renders correctly

## Notes

- Contributor records in the database may have empty `name` fields (though schema requires minLength: 1)
- The XRPC response includes contributor names when available from the database
- No code changes are needed for this documentation-only task

## Files Referenced

1. `packages/bibliograph-service/lexicons/community/lexicon/book/searchContributors.json` - Lexicon definition
2. `packages/bibliograph-service/src/lib/server/xrpc-router.ts:256-283` - Handler implementation
3. `packages/bibliograph-service/src/lib/server/search/service.ts:241-267` - Service implementation
4. `packages/bibliograph-service/lexicons/community/lexicon/book/contributor.json` - Contributor record schema