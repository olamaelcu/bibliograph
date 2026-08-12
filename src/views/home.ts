import { html } from 'hono/html';
import { Layout, type HtmlContent } from './layout.js';
import type { LexEndpoint } from '../lexicons/discovery.js';

function methodVariant(method: 'GET' | 'POST'): 'success' | 'warning' {
  return method === 'GET' ? 'success' : 'warning';
}

function endpointDetails(method: 'GET' | 'POST', endpoint: LexEndpoint): HtmlContent {
  const path = `/xrpc/${endpoint.nsid}`;
  return html`<wa-details>
  <div slot="summary" class="wa-cluster wa-gap-m">
    <wa-badge variant="${methodVariant(method)}">${method}</wa-badge>
    <code>${path}</code>
  </div>
  <div class="wa-cluster wa-gap-m" style="justify-content: space-between; align-items: center">
    <span class="wa-body-s wa-color-text-quiet">${endpoint.description ?? ''}</span>
    <wa-copy-button value="${path}"></wa-copy-button>
  </div>
</wa-details>`;
}

function groupCard(title: string, icon: string, method: 'GET' | 'POST', endpoints: LexEndpoint[]): HtmlContent {
  return html`<wa-card>
  <h2 slot="header" class="wa-cluster wa-gap-m">
    <wa-icon library="lucide" name="${icon}"></wa-icon>
    <span>${title}</span>
    <wa-badge variant="${methodVariant(method)}">${endpoints.length}</wa-badge>
  </h2>
  <div class="wa-stack">${endpoints.map((e) => endpointDetails(method, e))}</div>
</wa-card>`;
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

export function HomePage(props: { host: string; queries: LexEndpoint[]; procedures: LexEndpoint[] }) {
  const content = html`<wa-page style="max-width: 60rem; margin: 0 auto;">
  <div slot="header">
    <div class="wa-cluster wa-gap-l" style="justify-content: space-between; align-items: center; flex-wrap: wrap">
      <div class="wa-cluster wa-gap-m" style="align-items: center">
        <wa-icon library="lucide" name="book-open" style="font-size: 2rem"></wa-icon>
        <div class="wa-stack" style="gap: 0">
          <h1 class="wa-heading-l">Bibliograph</h1>
          <span class="wa-body-s wa-color-text-quiet">community.lexicon.book</span>
        </div>
      </div>
      <wa-button-group>
        <wa-button href="/feeds"><wa-icon library="lucide" name="rss" slot="prefix"></wa-icon>Feeds</wa-button>
        <wa-button href="https://github.com/olamaelcu/bibliograph" target="_blank" variant="neutral">
          <wa-icon library="lucide" name="external-link" slot="prefix"></wa-icon>GitHub
        </wa-button>
        <wa-button href="https://userinput.app/s/did:plc:ejggqolmgpylroktvaktibik/3mst4pvyu7m2f">Send Feedback</wa-button>
      </wa-button-group>
    </div>
  </div>

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

    ${groupCard('Queries', 'file-text', 'GET', props.queries)}
    ${groupCard('Procedures', 'square-pen', 'POST', props.procedures)}

    <wa-card>
      <h2 slot="header" class="wa-cluster wa-gap-m">
        <wa-icon library="lucide" name="list"></wa-icon>
        <span>Other endpoints</span>
      </h2>
      <div class="wa-stack">
        ${otherRow('GET', '/feeds', 'Live feed streams', html`<wa-button href="/feeds" size="s">Open</wa-button>`)}
        ${otherRow('POST', '/tap/event', 'Webhook fallback')}
        ${otherRow('GET', '/health', 'Health check')}
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

  <div slot="footer">
    <p class="wa-caption-s wa-color-text-quiet">Bibliograph &mdash; ${props.host} &mdash; <a href="https://userinput.app/s/did:plc:ejggqolmgpylroktvaktibik/3mst4pvyu7m2f">Submit Feedback</a></p>
  </div>
</wa-page>`;
  return Layout({ title: 'Bibliograph', content });
}
