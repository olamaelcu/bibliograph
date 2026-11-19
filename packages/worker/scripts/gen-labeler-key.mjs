#!/usr/bin/env node
/**
 * Generate the labeler's secp256k1 key pair.
 *
 *   node scripts/gen-labeler-key.mjs > /etc/bibliograph/labeler.key
 *   chmod 600 /etc/bibliograph/labeler.key
 *
 * The file's `private=` line is what the labeler reads (from the path in
 * `LABELER_KEY_FILE`); its `public=` line belongs in the edge's
 * `LIVTET_LABELER_KEY_MULTIBASE`, which publishes `#atproto_label` in the
 * `did:web` document so consumers can verify the labels.
 *
 * Rotating the key means replacing the file, updating the edge's variable and
 * republishing the DID document: labels already signed verify only under the key
 * that signed them, so a rotation invalidates the history a consumer cached.
 */

import { writeSync } from 'node:fs';

import {
  SECP256K1_JWT_ALG,
  Secp256k1Keypair,
  bytesToMultibase,
  formatMultikey
} from '@atproto/crypto';

const keypair = await Secp256k1Keypair.create({ exportable: true });
const privateKey = await keypair.export();

const out = [
  `# bibliograph labeler key — generated ${new Date().toISOString()}`,
  `private=${bytesToMultibase(privateKey, 'base58btc')}`,
  `public=${formatMultikey(SECP256K1_JWT_ALG, keypair.publicKeyBytes())}`,
  `did=${keypair.did()}`,
  ''
].join('\n');
writeSync(1, out);
