import { resolveTxt } from 'node:dns/promises';
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	AtprotoWebDidDocumentResolver,
} from '@atcute/identity-resolver';
import type { Did } from '@atcute/lexicons/syntax';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_EXPECT_MISMATCH = 2;

interface CliArgs {
  subcommand: string;
  nsid?: string;
  host?: string;
  expectNsid?: string;
  verbose?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { subcommand: '' };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === 'resolve') {
      args.subcommand = 'resolve';
      i++;
    } else if (arg.startsWith('--host=')) {
      args.host = arg.slice('--host='.length);
      i++;
    } else if (arg.startsWith('--expect-nsid=')) {
      args.expectNsid = arg.slice('--expect-nsid='.length);
      i++;
    } else if (arg === '--verbose') {
      args.verbose = true;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
      i++;
    } else if (!arg.startsWith('-') && !args.subcommand) {
      args.subcommand = arg;
      i++;
    } else if (!arg.startsWith('-') && args.subcommand === 'resolve' && !args.nsid) {
      args.nsid = arg;
      i++;
    } else {
      i++;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: tsx src/lex/cli.ts resolve <nsid> [options]
Options:
  --host=<url>         Skip DNS/DID resolution, fetch directly from URL
  --expect-nsid=<nsid> Assert returned schema.id equals this NSID
  --verbose            Print each resolution hop to stderr
  --help, -h           Show this help message
Examples:
  tsx src/lex/cli.ts resolve net.olamaelcu.livtet.biblio.review
  tsx src/lex/cli.ts resolve net.olamaelcu.livtet.biblio.review --host=http://localhost:3000/xrpc
  tsx src/lex/cli.ts resolve net.olamaelcu.livtet.biblio.review --expect-nsid=net.olamaelcu.livtet.biblio.review --verbose`);
}

function nsidToAuthority(nsid: string): string {
  const segments = nsid.split('.');
  if (segments.length < 3) {
    throw new Error(`Invalid NSID: ${nsid}`);
  }
  const reversed = [...segments].reverse();
  return reversed.join('.');
}

async function resolveViaHost(nsid: string, host: string, verbose?: boolean): Promise<unknown> {
  if (verbose) {
    console.error(`Fetching directly from: ${host}`);
  }
  const url = `${host}${host.endsWith('/') ? '' : '/'}com.atproto.lexicon.resolveLexicon?nsid=${encodeURIComponent(nsid)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`XRPC call failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function makeDidResolver(fetchFn: typeof fetch): CompositeDidDocumentResolver<'plc' | 'web'> {
  return new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver({ fetch: fetchFn }),
      web: new AtprotoWebDidDocumentResolver({ fetch: fetchFn }),
    },
  });
}

async function resolveLexicon(nsid: string, verbose?: boolean): Promise<unknown> {
  const authority = nsidToAuthority(nsid);
  const dnsName = `_lexicon.${authority}`;

  if (verbose) {
    console.error(`DNS query for TXT record: ${dnsName}`);
  }

  let txtRecords: string[][];
  try {
    txtRecords = await resolveTxt(dnsName);
  } catch (err) {
    throw new Error(`DNS lookup failed for ${dnsName}: ${(err as Error).message}`);
  }

  const flatRecords = txtRecords.flat();
  const didRecord = flatRecords.find((r) => r.startsWith('did='));
  if (!didRecord) {
    throw new Error(`No _lexicon TXT record found for ${authority}`);
  }

  const did = didRecord.slice('did='.length);
  if (verbose) {
    console.error(`DID found in TXT record: ${did}`);
  }

  if (verbose) {
    console.error(`Resolving DID: ${did}`);
  }

  let doc: Awaited<ReturnType<ReturnType<typeof makeDidResolver>['resolve']>>;
  try {
    doc = await makeDidResolver(fetch).resolve(did as Did<'plc' | 'web'>);
  } catch (err) {
    throw new Error(`DID resolution failed for ${did}: ${(err as Error).message}`);
  }

  const pdsEntry = doc.service?.find((s) => s.id === '#atproto_pds');
  if (!pdsEntry || typeof pdsEntry.uri !== 'string') {
    throw new Error(`PDS not found in DID doc for ${did}`);
  }

  const pdsUrl: string = pdsEntry.uri;
  if (verbose) {
    console.error(`PDS URL found: ${pdsUrl}`);
  }

  const xrpcUrl = `${pdsUrl}${pdsUrl.endsWith('/') ? '' : '/'}xrpc/com.atproto.lexicon.resolveLexicon?nsid=${encodeURIComponent(nsid)}`;
  if (verbose) {
    console.error(`XRPC call: ${xrpcUrl}`);
  }

  const response = await fetch(xrpcUrl);
  if (!response.ok) {
    throw new Error(`XRPC call failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function main(argv: string[]) {
  const args = parseArgs(argv);

  if (args.help || !args.subcommand) {
    printHelp();
    process.exit(EXIT_SUCCESS);
  }

  if (args.subcommand !== 'resolve') {
    console.error(`Unknown subcommand: ${args.subcommand}`);
    printHelp();
    process.exit(EXIT_FAILURE);
  }

  if (!args.nsid) {
    console.error('Error: NSID is required');
    printHelp();
    process.exit(EXIT_FAILURE);
  }

  try {
    let result: unknown;
    if (args.host) {
      result = await resolveViaHost(args.nsid, args.host, args.verbose);
    } else {
      result = await resolveLexicon(args.nsid, args.verbose);
    }

    const schema = result as { id?: string };
    if (args.expectNsid && schema.id !== args.expectNsid) {
      console.error(`Expected schema.id to be '${args.expectNsid}', but got '${schema.id}'`);
      process.exit(EXIT_EXPECT_MISMATCH);
    }

    console.log(JSON.stringify(result, null, 2));
    process.exit(EXIT_SUCCESS);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(EXIT_FAILURE);
  }
}

main(process.argv);
