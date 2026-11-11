import { fail } from '@sveltejs/kit';
import { adminActorDid, hasAdminAccess, requireAdmin } from '$lib/server/admin';
import { editionUriForRkey, loadAppviewBook } from '$lib/server/catalog/store';
import { editionViewFromAppview } from '$lib/server/media-book-view';
import { hvQuery } from '$lib/server/happyview/client';
import { enqueueDescriptionBackfill, enqueueFormatBackfill } from '$lib/server/jobs/enqueue';
import { clearLabel, grantLabel, hasLabel } from '$lib/server/labeler/labels';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { editions } from '$lib/server/db/schema';
import { CONTROVERSIAL_LABEL } from '$lib/server/labeler/vocabulary';
import { createLogger } from '$lib/server/logger';
import type { Actions, PageServerLoad } from './$types';

const log = createLogger('web');

export const load: PageServerLoad = async ({ params, request, cookies, url }) => {
	const uri = editionUriForRkey(params.rkey);
	const row = await loadAppviewBook(uri);
	if (!row) {
		return { notFound: true, rkey: params.rkey, uri, isAdmin: hasAdminAccess({ request, cookies }) };
	}

	let reviews: unknown[] = [];
	try {
		const res = await hvQuery(
			'net.olamaelcu.livtet.biblio.getReviewsByBook',
			new URLSearchParams({ book: uri }),
		);
		if (res.ok) {
			const body = (await res.json()) as { reviews?: unknown[] };
			reviews = body.reviews ?? [];
		}
	} catch (err) {
		log.warn({ err, uri }, 'review fetch failed; rendering without reviews');
	}

	return {
		notFound: false,
		rkey: params.rkey,
		uri,
		edition: editionViewFromAppview(row),
		reviews,
		controversial: await hasLabel(uri, CONTROVERSIAL_LABEL),
		isAdmin: hasAdminAccess({ request, cookies }),
		query: url.search,
	};
};

export const actions: Actions = {
	/** Flip the `controversial` label on this edition record (admins only). */
	toggleControversial: async (event) => {
		requireAdmin(event);
		const uri = editionUriForRkey(event.params.rkey);
		const currently = await hasLabel(uri, CONTROVERSIAL_LABEL);
		if (currently) await clearLabel(uri, CONTROVERSIAL_LABEL);
		else await grantLabel(uri, CONTROVERSIAL_LABEL);
		log.info({ rkey: event.params.rkey, did: adminActorDid() }, 'edition label flipped');
		return { ok: true, controversial: !currently };
	},

	/** Queue the description and format backfills (admins only). */
	runBackfill: async (event) => {
		requireAdmin(event);
		const uri = editionUriForRkey(event.params.rkey);
		await Promise.all([enqueueDescriptionBackfill(uri, 'admin'), enqueueFormatBackfill(uri, 'admin')]);
		return { ok: true, backfill: true };
	},

	/** Delete the catalog edition (admins only). Dependent rows cascade. */
	deleteEdition: async (event) => {
		requireAdmin(event);
		const uri = editionUriForRkey(event.params.rkey);
		await db.delete(editions).where(eq(editions.uri, uri));
		log.info({ rkey: event.params.rkey, did: adminActorDid() }, 'edition deleted by admin');
		return { ok: true, deleted: true };
	},
};
