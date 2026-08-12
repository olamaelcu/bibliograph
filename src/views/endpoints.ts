import { html } from 'hono/html';
import type { HtmlContent } from './layout.js';
import type { LexEndpoint } from '../lexicons/discovery.js';

export type EndpointMethod = 'GET' | 'POST';

export function methodVariant(method: EndpointMethod): 'success' | 'warning' {
  return method === 'GET' ? 'success' : 'warning';
}

export function renderEndpoint(method: EndpointMethod, endpoint: LexEndpoint): HtmlContent {
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

export function renderEndpointList(method: EndpointMethod, endpoints: LexEndpoint[]): HtmlContent {
  return html`<div class="wa-stack">${endpoints.map((e) => renderEndpoint(method, e))}</div>`;
}

export function navHeader(props: {
  host: string;
  icon: string;
  title: string;
  subtitle: string;
  links: Array<{ href: string; icon: string; label: string; external?: boolean }>;
}): HtmlContent {
  return html`<div slot="header">
  <div class="wa-cluster wa-gap-l" style="justify-content: space-between; align-items: center; flex-wrap: wrap">
    <div class="wa-cluster wa-gap-m" style="align-items: center">
      <wa-icon library="lucide" name="${props.icon}" style="font-size: 2rem"></wa-icon>
      <div class="wa-stack" style="gap: 0">
        <h1 class="wa-heading-l">${props.title}</h1>
        <span class="wa-body-s wa-color-text-quiet">${props.subtitle}</span>
      </div>
    </div>
    <wa-button-group>
      ${props.links.map((l) => html`<wa-button href="${l.href}" ${l.external ? 'target="_blank"' : ''} variant="${l.external ? 'neutral' : ''}"><wa-icon library="lucide" name="${l.icon}" slot="prefix"></wa-icon>${l.label}</wa-button>`)}
    </wa-button-group>
  </div>
</div>`;
}

export function pageFooter(host: string): HtmlContent {
  return html`<div slot="footer">
  <p class="wa-caption-s wa-color-text-quiet">Bibliograph &mdash; ${host} &mdash; <a href="https://userinput.app/s/did:plc:ejggqolmgpylroktvaktibik/3mst4pvyu7m2f">Submit Feedback</a></p>
</div>`;
}
