// Resolve an NSID to the schema this host publishes.
//
// The lexicon files are the source of truth. They are published to the PDS as
// `com.atproto.lexicon.schema` records by `scripts/pds-publish-lexicons.ts`;
// resolution here answers from the build-time map so it cannot disagree with
// what this build serves. No network lookup by design.

import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { PUBLISHER_DID } from '../did';
import { lexiconForNsid } from '../lexicon-map';

export const LEX_COLLECTION = 'com.atproto.lexicon.schema';

export interface PublishedLexicon {
	/** `at://<publisher did>/com.atproto.lexicon.schema/<nsid>` */
	uri: string;
	/** CID of the schema record. */
	cid: string;
	/** The record value: the lexicon document itself. */
	schema: Record<string, unknown>;
}

export async function resolvePublishedLexicon(nsid: string): Promise<PublishedLexicon | null> {
	const schema = lexiconForNsid(nsid);
	if (!schema) return null;
	const cid = await cidForLex(schema as unknown as LexMap);
	return {
		uri: `at://${PUBLISHER_DID}/${LEX_COLLECTION}/${nsid}`,
		cid: cid.toString(),
		schema,
	};
}
