/**
 * Per-entity render functions for /examples pages.
 *
 * Each `render<Kind>(data, container)` fn receives the parsed JSON response
 * from a single XRPC query and writes entity-appropriate Web Awesome markup
 * into `container`. All user-supplied strings are escaped through the
 * `escapeHtml` helper from `examples-client.js`.
 *
 * Note: covers / avatars are NOT in record shapes (community.lexicon.book
 * record schema has no cover/image field). Use `getImageForBook` /
 * `getImageForContributor` XRPC queries to fetch cover URLs.
 */

import { escapeHtml, snippet } from './examples-client.js';

const MAX_DESC = 280;
const PAGE_LIMIT = 20;

export async function renderEdition(data, container) {
	const edition = data?.edition;
	if (!edition) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No edition in response.</p>');
		return;
	}
	const authors = (edition.contributors ?? [])
		.map((c) => c.name ?? c.subject)
		.filter(Boolean)
		.join(', ');
	const identifiersHtml = renderIdentifiers(edition.identifiers);
	const coverHtml = await renderEditionCover(edition);
	container.insertAdjacentHTML(
		'beforeend',
		`<wa-card class="book-card">
			<div slot="header" class="book-card-header">
				<h3 class="book-title">${escapeHtml(edition.title)}</h3>
				<span class="at-uri">${escapeHtml(edition.uri)}</span>
			</div>
			<p class="muted" style="margin:0">${authors ? `By ${escapeHtml(authors)}` : 'No contributors listed.'}</p>
			${edition.description ? `<p class="book-desc">${escapeHtml(snippet(edition.description, MAX_DESC))}</p>` : ''}
			${identifiersHtml}
			${coverHtml}
		</wa-card>`,
	);
}

/** Fetch cover URL via getImageForBook and render an <img>. */
async function renderEditionCover(edition) {
	if (!edition.uri) return '';
	try {
		const res = await fetch(`/xrpc/net.olamaelcu.livtet.biblio.getImageForBook?uri=${encodeURIComponent(edition.uri)}`);
		if (!res.ok) return '';
		const data = await res.json();
		if (!data.url) return '';
		return `<img class="book-cover" loading="lazy" src="${escapeHtml(data.url)}" alt="" />`;
	} catch {
		return '';
	}
}

export async function renderContributor(data, container) {
	const c = data?.contributor;
	if (!c) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No contributor in response.</p>');
		return;
	}
	const identifiersHtml = renderIdentifiers(c.identifiers);
	container.insertAdjacentHTML(
		'beforeend',
		`<wa-card class="contributor-card">
			<div slot="header" class="contributor-card-header">
				<h3 class="contributor-name">${escapeHtml(c.name)}</h3>
				<span class="at-uri">${escapeHtml(c.uri)}</span>
			</div>
			${c.bio ? `<p class="contributor-bio">${escapeHtml(snippet(c.bio, MAX_DESC))}</p>` : ''}
			${identifiersHtml}
		</wa-card>`,
	);
}

export async function renderImageForBook(data, container) {
	const { url } = data ?? {};
	if (!url) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No cover URL available.</p>');
		return;
	}
	container.insertAdjacentHTML(
		'beforeend',
		`<wa-card class="book-card">
			<img class="book-cover" loading="lazy" src="${escapeHtml(url)}" alt="cover" />
				<p class="muted"><code>${escapeHtml(url)}</code></p>
		</wa-card>`,
	);
}

export async function renderImageForContributor(data, container) {
	const { url } = data ?? {};
	if (!url) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No avatar URL available.</p>');
		return;
	}
	container.insertAdjacentHTML(
		'beforeend',
		`<wa-card class="contributor-card">
			<img class="book-cover" loading="lazy" src="${escapeHtml(url)}" alt="avatar" />
				<p class="muted"><code>${escapeHtml(url)}</code></p>
		</wa-card>`,
	);
}

export function renderShelf(data, container) {
	const s = data?.shelf;
	if (!s) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No shelf in response.</p>');
		return;
	}
	container.insertAdjacentHTML(
		'beforeend',
		`<wa-card class="shelf-card">
			<div slot="header" class="shelf-card-header">
				<h3 class="shelf-name">${escapeHtml(s.name)}</h3>
				<span class="at-uri">${escapeHtml(s.uri)}</span>
			</div>
			${s.description ? `<p class="shelf-desc">${escapeHtml(snippet(s.description, MAX_DESC))}</p>` : ''}
		</wa-card>`,
	);
}

export function renderActor(data, container) {
	const a = data?.actor;
	if (!a) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No actor in response.</p>');
		return;
	}
	const bsky = a.bsky
		? `<p class="muted" style="margin:0">Bluesky: ${a.bsky.likeCount ?? 0} likes &middot; ${a.bsky.quoteCount ?? 0} quotes</p>`
		: '';
	container.insertAdjacentHTML(
		'beforeend',
		`<wa-card class="actor-card">
			<div slot="header" class="actor-card-header">
				<h3 class="actor-name">${escapeHtml(a.displayName || a.did)}</h3>
				<span class="at-uri">${escapeHtml(a.did)}</span>
			</div>
			${a.description ? `<p class="actor-desc">${escapeHtml(snippet(a.description, MAX_DESC))}</p>` : ''}
			${bsky}
		</wa-card>`,
	);
}

export function renderBookShelf(data, container) {
	const bs = data?.bookShelf;
	if (!bs) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No bookShelf in response.</p>');
		return;
	}
	const bookTitle = bs.book?.title || 'unknown book';
	const shelfName = bs.shelf?.name || 'unknown shelf';
	const meta = bs.metadata || {};
	const statusBadge = meta.status ? `<wa-badge variant="brand">${escapeHtml(meta.status)}</wa-badge>` : '';
	container.insertAdjacentHTML(
		'beforeend',
		`<wa-card class="bookShelf-card">
			<div slot="header" class="bookShelf-card-header">
				<h3 class="bookShelf-title">${escapeHtml(bookTitle)} &rarr; ${escapeHtml(shelfName)}</h3>
				<span class="at-uri">${escapeHtml(bs.uri)}</span>
			</div>
			<p class="bookShelf-meta">${statusBadge}${meta.position != null ? ` position <code>${escapeHtml(meta.position)}</code>` : ''}${meta.notes ? ` &middot; ${escapeHtml(snippet(meta.notes, 200))}` : ''}</p>
		</wa-card>`,
	);
}

/**
 * Renders the array-keyed lists: searchEditions/searchContributors (with
 * `total`) and the cursor-paginated list* queries.
 */
export async function renderSearchResults(data, container) {
	await renderListResults(data, container);
}

export async function renderListResults(data, container) {
	if (!data || typeof data !== 'object') {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">Empty response.</p>');
		return;
	}
	const arrayKey = Object.keys(data).find((k) => Array.isArray(data[k]));
	if (!arrayKey) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No array in response.</p>');
		return;
	}
	const items = data[arrayKey];
	if (items.length === 0) {
		container.insertAdjacentHTML('beforeend', '<p class="empty muted">No results.</p>');
		return;
	}
	const total = typeof data.total === 'number'
		? ` of ${data.total.toLocaleString()}`
		: '';
	container.insertAdjacentHTML(
		'beforeend',
		`<p class="muted results-meta">${items.length}${total} ${escapeHtml(arrayKey)} returned.</p>`,
	);
	for (const item of items) {
		await renderListItem(item, arrayKey, container);
	}
	if (data.cursor) {
		container.insertAdjacentHTML(
			'beforeend',
			`<p class="muted load-more">Cursor: <code>${escapeHtml(data.cursor)}</code></p>`,
		);
	}
}

async function renderListItem(item, arrayKey, container) {
	if (arrayKey === 'items') {
		// searchEditions returns items[] — each is a community edition record.
		// Has $type=community.lexicon.book.edition and a `uri` field.
		await renderEdition({ edition: item }, container);
		return;
	}
	if (arrayKey === 'shelves') {
		// shelfWithBooksView has { shelf, books } — render the shelf with a nested list of bookShelves.
		if (item.shelf && Array.isArray(item.books)) {
			renderShelf({ shelf: item.shelf }, container);
			for (const bs of item.books) renderBookShelf({ bookShelf: bs }, container);
			return;
		}
		renderShelf({ shelf: item }, container);
		return;
	}
	if (arrayKey === 'bookShelves') {
		renderBookShelf({ bookShelf: item }, container);
		return;
	}
	container.insertAdjacentHTML(
		'beforeend',
		`<wa-card><div slot="header"><strong>${escapeHtml(arrayKey)} entry</strong></div><pre style="white-space:pre-wrap;overflow:auto;max-height:20rem;font-size:0.8rem">${escapeHtml(JSON.stringify(item, null, 2))}</pre></wa-card>`,
	);
}

function renderIdentifiers(identifiers) {
	if (!Array.isArray(identifiers) || identifiers.length === 0) return '';
	const items = identifiers
		.map((i) => `<li><code>${escapeHtml(i.resource)}</code> &rarr; <a href="${escapeHtml(i.uri)}" target="_blank" rel="noopener">source</a></li>`)
		.join('');
	return `<ul class="identifiers">${items}</ul>`;
}