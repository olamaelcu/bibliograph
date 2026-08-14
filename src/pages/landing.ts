import { renderString } from '../ssr/webawesome.js';
import {
  lexiconEndpoints,
  procedureCount,
  queryCount,
  type LexiconEndpoint,
  type LexiconParam,
} from '../lexicon-catalog.js';

const SERVICE_NSID = 'net.olamaelcu.livtet.biblio';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function badge(type: 'query' | 'procedure'): string {
  const variant = type === 'query' ? 'brand' : 'success';
  return `<wa-badge variant="${variant}" appearance="filled">${type}</wa-badge>`;
}

function requiredBadge(): string {
  return `<wa-badge variant="danger" appearance="filled">required</wa-badge>`;
}

function paramList(params: LexiconParam[]): string {
  if (params.length === 0) {
    return '<p class="muted">This method takes no parameters.</p>';
  }
  const rows = params
    .map((p) => {
      const bits = [esc(p.type)];
      if (p.description) bits.push('· ' + esc(p.description));
      const meta: string[] = [];
      if (p.default !== undefined) meta.push(`default: <code>${esc(p.default)}</code>`);
      if (p.knownValues?.length) meta.push(`known values: <code>${esc(p.knownValues.join(', '))}</code>`);
      return `<li>
				<div class="row-head">
					<code>${esc(p.name)}</code>
					${p.required ? requiredBadge() : ''}
					<span class="param-type">${bits.join(' ')}</span>
				</div>
				${meta.length ? `<div class="param-meta">${meta.join(' ')}</div>` : ''}
			</li>`;
    })
    .join('\n');
  return `<ul class="spec">${rows}</ul>`;
}

function outputBlock(endpoint: LexiconEndpoint): string {
  const output = endpoint.output;
  if (!output) return '<p class="muted">This method has no documented output.</p>';
  const bits = [`<code>${esc(output.encoding)}</code>`, esc(output.kind)];
  const props =
    output.properties.length > 0
      ? `<ul class="spec">${output.properties
        .map((p) => {
          const desc = p.description ? ` · ${esc(p.description)}` : '';
          return `<li><div class="row-head"><code>${esc(p.name)}</code> ${p.required ? requiredBadge() : ''} <span class="param-type">${esc(p.type)}</span></div><div class="param-meta">${desc}</div></li>`;
        })
        .join('\n')}</ul>`
      : '';
  return `<p class="muted">${bits.join(' ')}</p>${props}`;
}

function errorsBlock(endpoint: LexiconEndpoint): string {
  if (endpoint.errors.length === 0) {
    return '<p class="muted">This method has no documented errors.</p>';
  }
  const rows = endpoint.errors
    .map((e) => {
      const desc = e.description ? `<div class="param-meta">${esc(e.description)}</div>` : '';
      return `<li><div class="row-head"><code>${esc(e.name)}</code></div>${desc}</li>`;
    })
    .join('\n');
  return `<ul class="spec">${rows}</ul>`;
}

function endpointCard(endpoint: LexiconEndpoint): string {
  const sections: string[] = [
    `<wa-details summary="Parameters">${paramList(endpoint.params)}</wa-details>`,
  ];
  sections.push(`<wa-details summary="Output">${outputBlock(endpoint)}</wa-details>`);
  sections.push(`<wa-details summary="Errors">${errorsBlock(endpoint)}</wa-details>`);

  const desc = endpoint.description
    ? `<p class="endpoint-desc">${esc(endpoint.description)}</p>`
    : '';

  return `<wa-card with-footer class="endpoint-card">
		<div slot="header" class="card-header">
			${badge(endpoint.type)}
			<code class="endpoint-id">${esc(endpoint.id)}</code>
			<wa-copy-button value="${esc(endpoint.id)}" copy-label="Copy NSID"></wa-copy-button>
		</div>
		${desc}
		<div class="wa-stack wa-gap-xs">${sections.join('\n')}</div>
		<div slot="footer" class="card-footer">
			<a href="/l${esc(endpoint.lexiconPath)}" target="_blank" rel="noopener">View lexicon JSON</a>
		</div>
	</wa-card>`;
}

function buildPage(): string {
  const cards = lexiconEndpoints.map(endpointCard).join('\n');
  const stats = [
    `<wa-badge variant="brand" appearance="filled">${queryCount} queries</wa-badge>`,
    `<wa-badge variant="success" appearance="filled">${procedureCount} procedures</wa-badge>`,
  ].join('\n');

  return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Bibliograph — ${SERVICE_NSID}</title>
		<meta name="description" content="Bibliograph AT Protocol AppView: procedures and queries served by the ${esc(SERVICE_NSID)} lexicon." />
		<link rel="stylesheet" href="/webawesome/dist-cdn/styles/webawesome.css" />
		<script type="module" src="/webawesome/dist-cdn/webawesome.ssr-loader.js"></script>
		<style>
			:root { color-scheme: light dark; }
			/* Avoid a flash of unstyled content for elements that weren't server-rendered. */
			:not([did-ssr]):not(:defined) { visibility: hidden; }
			wa-page { --wa-page-width: 1100px; }
			.hero { padding: 2rem 0 1rem; flex-direction: column; }
			.hero h1 { margin: 0 0 0.25rem; }
			.hero .subtitle { margin: 0 0 0.5rem; color: var(--wa-color-neutral-500); }
			.hero .stats { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
			.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; padding-bottom: 2rem; }
			.card-header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
			.endpoint-id { font-weight: 600; }
			.endpoint-desc { margin: 0 0 0.75rem; }
			.muted { color: var(--wa-color-neutral-500); }
			.row-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
			.param-type { color: var(--wa-color-neutral-500); font-size: 0.875rem; }
			.param-meta { color: var(--wa-color-neutral-500); font-size: 0.875rem; margin-top: 0.25rem; }
			ul.spec { list-style: none; margin: 0; padding: 0; }
			ul.spec li { margin-bottom: 0.5rem; }
			.card-footer { text-align: right; }
      .footer { max-width: 50rem; text-align: center; padding: var(--wa-space-m); }
		</style>
	</head>
	<body>
		<wa-page mobile-breakpoint="920" view="desktop">
			<header class="hero" slot="header">
				<h1><wa-icon name="circle-star"></wa-icon> Bibliograph</h1>
				<p class="subtitle"><code>${esc(SERVICE_NSID)}</code> &mdash; a literary-centric <a href="https://atproto.com/guides/glossary#app-view">AT Protocol AppView</a></p>
				<p>Every query and procedure exposed by this service following standards (<code>/xrpc</code>), documented from the lexicon files.</p>
				<div class="stats">${stats}</div>
			</header>
			<main class="grid">${cards}</main>
      <div class="footer">
        Built by <a href="https://www.olamaelcu.net">Olamaelcu</a>
      </div>
		</wa-page>
	</body>
</html>`;
}

/** The fully SSR'd landing page, computed once at startup (content is static). */
export const landingPageHtml: string = (() => {
  return renderString(buildPage());
})();
