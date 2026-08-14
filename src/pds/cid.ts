import { create as cidCreate, toString as cidToString, CODEC_DCBOR } from '@atcute/cid';
import { encode as cborEncode } from '@atcute/cbor';

/**
 * Compute the content-addressed CIDv1 for an AT Protocol record value.
 *
 * The value is encoded with canonical DAG-CBOR (dCBOR42 — the DASL dialect
 * used by the rest of the AT Protocol stack), SHA-256-hashed, and packed
 * into CIDv1 with codec 0x71. The resulting base32 string is the form
 * every resolver, firehose consumer, and lexicon validator expects.
 *
 * Stable across machines: same value in → same CID out, every run.
 */
export async function cidForRecord(value: unknown): Promise<string> {
	const bytes = cborEncode(value);
	const cid = await cidCreate(CODEC_DCBOR, bytes);
	return cidToString(cid);
}

/** DAG-CBOR codec constant, exposed for callers that need to encode manually. */
export const DAG_CBOR_CODEC = CODEC_DCBOR;
