import { html } from 'hono/html';
import { Layout, type HtmlContent } from './layout.js';
import { navHeader, pageFooter } from './endpoints.js';

function methodVariant(method: 'GET' | 'POST'): 'success' | 'warning' {
  return method === 'GET' ? 'success' : 'warning';
}

function otherRow(method: 'GET' | 'POST', path: string, desc: string, extra?: HtmlContent): HtmlContent {
  return html`<div class="wa-cluster wa-gap-m" style="justify-content: space-between; align-items: center">
  <div class="wa-cluster wa-gap-m" style="align-items: center">
    <wa-badge variant="${methodVariant(method)}">${method}</wa-badge>
    <code>${path}</code>
  </div>
  <div class="wa-cluster wa-gap-m" style="align-items: center">
    <span class="wa-body-s wa-color-text-quiet">${desc}</span>
    ${extra ?? ''}
  </div>
</div>`;
}

const HEADER_LINKS = [
  { href: '/queries', icon: 'file-text', label: 'Queries' },
  { href: '/procedures', icon: 'square-pen', label: 'Procedures' },
  { href: '/feeds', icon: 'rss', label: 'Feeds' },
];

export function HomePage(props: { host: string }) {
  const content = html`<wa-page style="max-width: 60rem; margin: 0 auto;">
    ${navHeader({
    host: props.host,
    icon: 'book-open',
    title: 'Bibliograph',
    subtitle: 'community.lexicon.book',
    links: HEADER_LINKS,
  })}

    <div>
      <wa-card>
        <div class="wa-cluster wa-gap-xl" style="align-items: center">
          <div class="wa-cluster wa-gap-m" style="align-items: center">
            <wa-icon library="lucide" name="book"></wa-icon>
            <div class="wa-stack" style="gap: 0">
              <span class="count-num" id="book-count">&mdash;</span>
              <span class="wa-caption-m wa-color-text-quiet">Books</span>
            </div>
          </div>
          <wa-divider vertical></wa-divider>
          <div class="wa-cluster wa-gap-m" style="align-items: center">
            <wa-icon library="lucide" name="bookmark-check"></wa-icon>
            <div class="wa-stack" style="gap: 0">
              <span class="count-num" id="status-count">&mdash;</span>
              <span class="wa-caption-m wa-color-text-quiet">Statuses</span>
            </div>
          </div>
          <span class="wa-caption-s wa-color-text-quiet" id="sse-status">connecting&hellip;</span>
        </div>
      </wa-card>

      <wa-card>
        <h2 slot="header" class="wa-cluster wa-gap-m">
          <wa-icon library="lucide" name="list"></wa-icon>
          <span>Endpoints</span>
        </h2>
        <div class="wa-stack">
          ${otherRow('GET', '/feeds', 'Live feed streams', html`<wa-button href="/feeds" size="s">Open</wa-button>`)}
          ${otherRow('POST', '/tap/event', 'Webhook fallback')}
          ${otherRow('GET', '/health', 'Health check')}
          ${otherRow('GET', '/lexicon-hashes.json', 'SHA-256 hashes of every served lex')}
        </div>
      </wa-card>

      <wa-callout>
        <wa-icon library="lucide" name="shield-check" slot="icon"></wa-icon>
        <div slot="title">Authenticate with ATProto service JWTs</div>
        <div class="wa-cluster wa-gap-m">
          <code>Authorization: Bearer &lt;jwt&gt;</code>
          <wa-copy-button value="Authorization: Bearer &lt;jwt&gt;"></wa-copy-button>
        </div>
        <p class="wa-caption-s wa-color-text-quiet">iss: your DID &middot; aud: did:web:${props.host}#atproto_pds &middot; lxm: &lt;endpoint-nsid&gt;</p>
      </wa-callout>
    </div>

    ${pageFooter(props.host)}
  </wa-page>`;
  return Layout({ title: 'Bibliograph', content });
}
