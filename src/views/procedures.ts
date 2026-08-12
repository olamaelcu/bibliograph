import { html } from 'hono/html';
import { Layout } from './layout.js';
import { navHeader, pageFooter, renderEndpointList } from './endpoints.js';
import type { LexEndpoint } from '../lexicons/discovery.js';

const ICON = 'square-pen';
const TITLE = 'Procedures';
const SUBTITLE = 'community.lexicon.book';

const LINKS = [
  { href: '/', icon: 'home', label: 'Home' },
  { href: '/queries', icon: 'file-text', label: 'Queries' },
  { href: '/feeds', icon: 'rss', label: 'Feeds' },
];

export function ProceduresPage(props: { host: string; endpoints: LexEndpoint[] }) {
  const content = html`<wa-page style="max-width: 60rem; margin: 0 auto;">
    ${navHeader({ host: props.host, icon: ICON, title: TITLE, subtitle: SUBTITLE, links: LINKS })}

    <div>
      <wa-card>
        <h2 slot="header" class="wa-cluster wa-gap-m">
          <wa-icon library="lucide" name="${ICON}"></wa-icon>
          <span>${TITLE}</span>
          <wa-badge variant="warning">${props.endpoints.length}</wa-badge>
        </h2>
        <p class="wa-body-s wa-color-text-quiet">Write endpoints. Each row carries a request schema on input and a response schema on output — see the lex JSON at <code>/lexicon/&lt;nsid&gt;</code> for the full shape.</p>
        ${renderEndpointList('POST', props.endpoints)}
      </wa-card>
    </div>

    ${pageFooter(props.host)}
  </wa-page>`;
  return Layout({ title: `${TITLE} · Bibliograph`, content });
}
