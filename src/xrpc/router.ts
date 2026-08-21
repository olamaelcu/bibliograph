import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { XRPCRouter, json, XRPCError } from '@atcute/xrpc-server';
import { CID, digest } from 'multiformats';
import { loadLexiconSchema, LexiconNotFound } from '../lexicon-resolve.js';
import * as Lexicons from '../lexicons/index.js';
import { registerPdsHandlers } from '../pds/router.js';
import type { ViewContext } from '../lex/collections.js';

type Db = NodePgDatabase<typeof schema>;

function notImplemented(nsid: string): never {
	throw new XRPCError({
		status: 501,
		error: 'NotImplementedError',
		message: `${nsid} is not implemented`,
	});
}

export function createXrpcRouter(db: Db, ctx: ViewContext): XRPCRouter {
	const router = new XRPCRouter();
	registerPdsHandlers(router, db, ctx);

	router.addQuery(Lexicons.ComAtprotoLexiconResolveLexicon.mainSchema, {
		async handler({ params }) {
			let schemaNsid: string;
			try {
				schemaNsid = params.nsid;
				const { json: schemaJson, bytes } = loadLexiconSchema(schemaNsid);
				const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
				const hashBytes = new Uint8Array(hash);
				const digestObj = digest.create(0x12, hashBytes);
				const cid = CID.createV1(0x0129, digestObj);
				const uri = `at://${ctx.serviceDid}/com.atproto.lexicon.schema/${schemaNsid}`;
				return json({ uri, cid: cid.toString(), schema: schemaJson as unknown as Lexicons.ComAtprotoLexiconResolveLexicon.$output['schema'] });
			} catch (err) {
				if (err instanceof LexiconNotFound) {
					throw new XRPCError({ status: 400, error: 'LexiconNotFound', message: err.message });
				}
				throw err;
			}
		},
	});

	// ─── AppView reads: stubbed ─────────────────────────────────────────────
	// Each handler throws 501 NotImplementedError until reimplemented. The
	// explicit per-endpoint registration makes the placeholder surface
	// greppable: `router.addQuery.*NetOlamaelcuLivtetBiblio<Name>`.
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetActor.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getActor'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBook.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getBook'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBookOnShelf.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getBookOnShelf'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetContributor.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getContributor'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetGenre.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getGenre'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetReview.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getReview'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelf.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getShelf'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelvingOfBook.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getShelvingOfBook'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetWork.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.getWork'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooks.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listBooks'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooksOnShelf.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listBooksOnShelf'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListGenres.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listGenres'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListReviewsByBook.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listReviewsByBook'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelves.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listShelves'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelvesWithBooks.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.listShelvesWithBooks'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchBooks.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.searchBooks'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchContributors.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.searchContributors'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchReviews.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.searchReviews'),
	});
	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchWorks.mainSchema, {
		handler: () => notImplemented('net.olamaelcu.livtet.biblio.searchWorks'),
	});

	return router;
}
