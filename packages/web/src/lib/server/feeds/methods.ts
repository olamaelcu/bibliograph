/**
 * The two `com.atproto.feed.*` NSIDs the edge answers itself.
 *
 * Kept free of `$env` imports (unlike `./index.ts`) so the XRPC dispatch and its
 * tests can classify a method without loading the feed generator.
 */

export const DESCRIBE_FEED_GENERATOR = 'com.atproto.feed.describeFeedGenerator';
export const GET_FEED_SKELETON = 'com.atproto.feed.getFeedSkeleton';

export function isFeedMethod(method: string): boolean {
  return method === DESCRIBE_FEED_GENERATOR || method === GET_FEED_SKELETON;
}
