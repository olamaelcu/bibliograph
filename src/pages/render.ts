import { Eta } from 'eta';
import { fileURLToPath } from 'node:url';
import { renderString } from '../ssr/webawesome.js';

const TEMPLATES_DIR = fileURLToPath(new URL('./templates/', import.meta.url));

const eta = new Eta({
	views: TEMPLATES_DIR,
	// Templates are read fresh on every render in dev so edits appear on
	// browser refresh; compiled templates are cached in production.
	cache: process.env.NODE_ENV === 'production',
});

/**
 * Render an on-disk Eta template (under src/pages/templates) into fully
 * SSR'd HTML. The page template produces a content fragment, which is
 * injected into the shared layout's `body` slot before Web Awesome SSR.
 */
export function renderPage(name: string, data: Record<string, unknown>): string {
	const body = eta.render(`./${name}.html`, data);
	const html = eta.render('./layout.html', { ...data, body });
	return renderString(html);
}
