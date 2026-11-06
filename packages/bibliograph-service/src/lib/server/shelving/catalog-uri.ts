// rkey → catalog edition URI, without touching the database.
//
// Kept apart from `hydrate.ts` (which imports `db`) so the derivation can be used
// by job handlers and tested without a database: the rkey prefix is the only
// thing that decides which provider owns the edition.

import { gbEditionUri, isGbRkey, volumeIdFromGbRkey } from '../gb/keys';
import { bhEditionUri, isBhRkey, hiveIdFromBhRkey } from '../bookhive/keys';
import { isIsbndbRkey, isbnFromIsbndbRkey, isbndbEditionUri } from '../isbndb/keys';
import { grEditionUri, grIdFromRkey, isGrRkey } from '../gr/keys';

export function catalogEditionUriFromRkey(rkey: string): string | null {
  if (isBhRkey(rkey)) {
    try {
      return bhEditionUri(hiveIdFromBhRkey(rkey));
    } catch {
      return null;
    }
  }
  if (isGbRkey(rkey)) {
    try {
      return gbEditionUri(volumeIdFromGbRkey(rkey));
    } catch {
      return null;
    }
  }
  if (isIsbndbRkey(rkey)) {
    try {
      return isbndbEditionUri(isbnFromIsbndbRkey(rkey));
    } catch {
      return null;
    }
  }
  if (isGrRkey(rkey)) {
    try {
      return grEditionUri(grIdFromRkey(rkey));
    } catch {
      return null;
    }
  }
  return null;
}
