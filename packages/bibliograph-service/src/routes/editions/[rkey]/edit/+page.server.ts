import { fail, redirect } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { requireAdmin } from '$lib/server/admin';
import { db } from '$lib/server/db';
import { editions } from '$lib/server/db/schema';
import { editionUriForRkey, loadAppviewBook } from '$lib/server/catalog/store';
import { loadEditionIdentifiers } from '$lib/server/edition-record';
import { identifierFromString, identifierKey, type Identifier } from '$lib/server/identifiers';
import type { Actions, PageServerLoad } from './$types';

function parseIdentifiers(raw: string): Identifier[] {
	const out: Identifier[] = [];
	for (const entry of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
		const identifier = identifierFromString(entry);
		if (identifier) out.push(identifier);
	}
	return out;
}

async function writeIdentifiers(uri: string, next: readonly Identifier[]): Promise<void> {
	await db.execute(sql`DELETE FROM edition_identifiers WHERE edition_uri = ${uri}`);
	for (const identifier of next) {
		await db.execute(sql`
			INSERT INTO edition_identifiers (edition_uri, issuer, value)
			VALUES (${uri}, ${identifier.issuer}, ${identifier.value})
			ON CONFLICT DO NOTHING
		`);
	}
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const uri = editionUriForRkey(event.params.rkey);
	const row = await loadAppviewBook(uri);
	if (!row) redirect(303, `/editions/${event.params.rkey}`);
	return {
		uri,
		rkey: event.params.rkey,
		row,
		identifiers: await loadEditionIdentifiers(uri),
	};
};

export const actions: Actions = {
	save: async (event) => {
		requireAdmin(event);
		const form = await event.request.formData();
		const uri = editionUriForRkey(event.params.rkey);
		const title = String(form.get('title') ?? '').trim();
		if (!title) return fail(400, { error: 'Title is required.' });

		const identifiers = parseIdentifiers(String(form.get('identifiers') ?? ''));
		if (identifiers.length === 0) {
			return fail(400, { error: 'At least one identifier is required (issuer:value).' });
		}
		const unique = Array.from(new Map(identifiers.map((id) => [identifierKey(id), id])).values());

		await db
			.update(editions)
			.set({
				title,
				subtitle: String(form.get('subtitle') ?? '').trim() || null,
				language: String(form.get('language') ?? '').trim() || null,
				publishedDate: String(form.get('publishedDate') ?? '').trim() || null,
				format: String(form.get('format') ?? '').trim() || null,
				pages: Number.parseInt(String(form.get('pages') ?? ''), 10) || null,
				description: String(form.get('description') ?? '').trim() || null,
				coverUrl: String(form.get('coverUrl') ?? '').trim() || null,
				indexedAt: new Date(),
			})
			.where(eq(editions.uri, uri));

		await writeIdentifiers(uri, unique);
		return { ok: true };
	},
};
