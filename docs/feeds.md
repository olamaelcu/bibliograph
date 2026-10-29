# Book Reviews Feed Implementation

## Overview
Implemented an ATProto feed generator using Constellation to expose reviews made of editions via `net.olamaelcu.livtet.bookReview` as a consumable feed for ATProto clients.

## Implementation Summary

### 1. Constellation Client Extension (`packages/bibliograph-service/src/lib/server/constellation/client.ts`)
- Added `ReviewSource = 'net.olamaelcu.livtet.bookReview:book'`
- Extended `GetBacklinksParams.source` to accept `ShelvingSource | ReviewSource`
- This enables the feed to query reviews via Constellation backlinks

### 2. DID Document Service (`packages/bibliograph-service/src/lib/server/did.ts`)
- Added `#atproto_feed` service entry to DID document:
  - `id: '#atproto_feed'`
  - `type: 'AtprotoFeedGenerator'`
  - `serviceEndpoint: `${PROTO}://${HOSTNAME}``

### 3. ATProto Feed Generator Endpoints (`packages/bibliograph-service/src/lib/server/xrpc-router.ts`)

#### Describe Feed Generator (`app.bsky.feed.describeFeedGenerator`)
- Registers feed generator metadata endpoint
- Returns publisher DID and feed URI: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed/reviews`
- Display name: "Book Reviews"
- Description: "Reviews of editions using net.olamaelcu.livtet.bookReview"

#### Get Feed Skeleton (`app.bsky.feed.getFeedSkeleton`)
- Returns paginated skeleton feed posts for reviews
- **DB-first approach**: Queries `net.olamaelcu.livtet.bookReview` and `net.olamaelcu.livtet.biblio.bookReview` collections
- **Constellation merge**: If feed URI contains a subject (edition), merges constellation backlinks with DB results using `getBacklinks({source:'net.olamaelcu.livtet.bookReview:book'})`
- Returns array of `{post: reviewURI, reason?: description}` with cursor for pagination

### 4. Feed URI Pattern
- General feed URI: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed/reviews`
- Subject-specific feed (optional): `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed/reviews/${editionRkey}`

### 5. Compatibility
- Existing `getReviewsByBook` handler unchanged
- Constellation backlinks support both shelving and review sources
- Feed gracefully falls back to DB-only pagination when Constellation queries fail

## Verification Commands

Run these commands against a running bibliograph service:

```bash
# Describe feed generator metadata
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/app.bsky.feed.describeFeedGenerator'

# Get feed skeleton (general reviews)
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:web:biblio.livtet.olamaelcu.net/net.olamaelcu.livtet.biblio.feed/reviews&limit=5'

# Get feed skeleton for specific edition (if Constellation backlink exists)
curl -s 'https://biblio.livtet.olamaelcu.net/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:web:biblio.livtet.olamaelcu.net/net.olamaelcu.livtet.biblio.feed/reviews/abc123&limit=5'
```

## Technical Details

### Schema Definitions
- Feed generator endpoints use inline valibot schemas from `@atcute/lexicons/validations`
- Schemas include proper NSID, parameter validation, and XRPC output types
- Follows existing bibliograph code patterns

### Data Sources
1. **Database**: Direct queries to `records` table for book reviews
2. **Constellation**: Backlink queries for edition-specific reviews
3. **Fallback**: DB-only pagination ensures reliability

### Error Handling
- Constellation backlink errors are logged but don't break the feed
- Database queries handle missing or malformed review data gracefully
- Pagination continues working even with partial data sources

## Future Considerations

### Feed Declaration Record
- A feed declaration record in the lex repo could provide canonical AT-URI
- Optional but recommended for production feed discovery

### Enhanced Constellation Integration
- Could pre-process Constellation backlink results for better merging with DB data
- Could support more complex edition-based filtering

### Performance Optimizations
- Pagination caching for general feed requests
- Pre-compiled edition-to-review mappings

## Files Modified

1. `packages/bibliograph-service/src/lib/server/constellation/client.ts`
2. `packages/bibliograph-service/src/lib/server/did.ts`
3. `packages/bibliograph-service/src/lib/server/xrpc-router.ts`

All changes are backward compatible and follow existing bibliograph code patterns.