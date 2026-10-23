#!/usr/bin/env tsx
// Generate the K-256 keypair used to sign ATProto labels.
//
// Prints ATP_LABEL_SIGNING_KEY (private, hex) and ATP_LABEL_KEY_MULTIBASE
// (public, multibase) for the running app's environment.
//
// The public half must be published in the labeler's DID document under the
// `#atproto_label` fragment; verifiers resolve that key and check every label
// signature against it, so a mismatch makes all labels invalid.
//
// Keep this key separate from ATP_SIGNING_KEY (the repo/lex publisher key): they
// have different blast radii, and the spec allows rotation of one without the
// other.

import { Secp256k1Keypair, formatMultikey } from '@atproto/crypto';

const HOSTNAME = process.env.LEX_PUBLISHER_HOSTNAME ?? 'biblio.livtet.olamaelcu.net';
const DID = `did:web:${HOSTNAME}`;

async function main(): Promise<void> {
  const kp = await Secp256k1Keypair.create({ exportable: true });
  const privKeyBytes = await kp.export();
  const publicKeyBytes = kp.publicKeyBytes();
  const privateKeyHex = Buffer.from(privKeyBytes).toString('hex');
  const publicKeyMultibase = formatMultikey('ES256K', publicKeyBytes);

  console.log('Labeler key generated.\n');
  console.log(`Labeler DID: ${DID}`);
  console.log(`Published at:  ${DID}#atproto_label\n`);
  console.log('--- environment (DO NOT commit the private half):');
  console.log(`ATP_LABEL_SIGNING_KEY=${privateKeyHex}`);
  console.log(`ATP_LABEL_KEY_MULTIBASE=${publicKeyMultibase}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
