// Build-time map of the lexicons this host publishes.
//
// The edge no longer reads `data/lex` CARs: the lexicon files are the source of
// truth and Vite inlines them into the server bundle. `com.atproto.lexicon.schema`
// records are published to the PDS by `scripts/pds-publish-lexicons.ts`.

const files = import.meta.glob('/lexicons/**/*.json', { eager: true, import: 'default' }) as Record<
	string,
	Record<string, unknown>
>;

const byNsid = new Map<string, Record<string, unknown>>();
for (const [path, lexicon] of Object.entries(files)) {
	// `lexicons/codegen` holds normalized copies used only by lex-cli.
	if (path.includes('/codegen/')) continue;
	const id = lexicon?.id;
	if (typeof id === 'string') byNsid.set(id, lexicon);
}

/** The lexicon document this host publishes under `nsid`, or `null`. */
export function lexiconForNsid(nsid: string): Record<string, unknown> | null {
	return byNsid.get(nsid) ?? null;
}

export function publishedNsids(): string[] {
	return Array.from(byNsid.keys()).sort();
}
