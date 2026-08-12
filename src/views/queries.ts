import { html } from 'hono/html';
import { Layout } from './layout.js';
import { navHeader, pageFooter, renderEndpointList } from './endpoints.js';
import type { LexEndpoint } from '../lexicons/discovery.js';

const ICON = 'file-text';
const TITLE = 'Queries';
const SUBTITLE = 'community.lexicon.book';

const LINKS = [
  { href: '/', icon: 'home', label: 'Home' },
  { href: '/procedures', icon: 'square-pen', label: 'Procedures' },
  { href: '/feeds', icon: 'rss', label: 'Feeds' },
];

export function QueriesPage(props: { host: string; endpoints: LexEndpoint[] }) {
  const content = html`<wa-page style="max-width: 60rem; margin: 0 auto;">
    ${navHeader({ host: props.host, icon: ICON, title: TITLE, subtitle: SUBTITLE, links: LINKS })}

    <div>
      <wa-card>
        <h2 slot="header" class="wa-cluster wa-gap-m">
          <wa-icon library="lucide" name="${ICON}"></wa-icon>
          <span>${TITLE}</span>
          <wa-badge variant="success">${props.endpoints.length}</wa-badge>
        </h2>
        <p class="wa-body-s wa-color-text-quiet">Read-only GET endpoints. Each row is a request/response shape — open the row to copy its URL.</p>
        ${renderEndpointList('GET', props.endpoints)}
      </wa-card>
    </div>

    ${pageFooter(props.host)}
  </wa-page>`;
  return Layout({ title: `${TITLE} · Bibliograph`, content });
}
