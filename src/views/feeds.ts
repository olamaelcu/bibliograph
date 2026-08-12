import { html } from 'hono/html';
import { Layout } from './layout.js';
import { navHeader } from './endpoints.js';

const HEADER_LINKS = [
  { href: '/', icon: 'home', label: 'Home' },
  { href: '/queries', icon: 'file-text', label: 'Queries' },
  { href: '/procedures', icon: 'square-pen', label: 'Procedures' },
];

export function FeedsPage(props: { host: string }) {
  const content = html`<wa-page  style="max-width: 60rem; margin: 0 auto;">
  ${navHeader({
    host: props.host,
    icon: 'radio',
    title: 'Feeds',
    subtitle: 'community.lexicon.book',
    links: HEADER_LINKS,
  })}

  <div>

    <wa-card>
      <h2 slot="header">
          <wa-badge id="feed-status" variant="neutral">connecting&hellip;</wa-badge>
          Recent updates
        </h2>
      <div class="wa-stack" id="recent">
        <wa-skeleton></wa-skeleton><wa-skeleton></wa-skeleton><wa-skeleton></wa-skeleton>
      </div>
    </wa-card>

    <wa-card>
      <h2 slot="header">Newest books</h2>
      <div class="wa-stack" id="newest">
        <wa-skeleton></wa-skeleton><wa-skeleton></wa-skeleton>
      </div>
    </wa-card>

    <wa-card>
      <h2 slot="header">Trending</h2>
      <div class="wa-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))">
        <section><h3 class="wa-heading-m">Day</h3><div class="wa-stack" id="trend-day"><wa-skeleton></wa-skeleton></div></section>
        <section><h3 class="wa-heading-m">Week</h3><div class="wa-stack" id="trend-week"><wa-skeleton></wa-skeleton></div></section>
        <section><h3 class="wa-heading-m">Month</h3><div class="wa-stack" id="trend-month"><wa-skeleton></wa-skeleton></div></section>
      </div>
    </wa-card>
  </div>

  <div slot="footer">
    <p class="wa-caption-s wa-color-text-quiet">Polling /xrpc/community.lexicon.book.feed every 5s &middot; Bibliograph &mdash; ${props.host}
&mdash; <a href="https://userinput.app/s/did:plc:ejggqolmgpylroktvaktibik/3mst4pvyu7m2f">Submit Feedback</a>
      </p>
  </div>
</wa-page>

<script>
(function () {
  const statusEl = document.getElementById('feed-status');
  const recentEl = document.getElementById('recent');
  const newestEl = document.getElementById('newest');
  const trendEls = { day: document.getElementById('trend-day'),
                     week: document.getElementById('trend-week'),
                     month: document.getElementById('trend-month') };

  const ENDPOINT = '/xrpc/community.lexicon.book.feed?limit=25';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function divider() {
    return '<wa-divider></wa-divider>';
  }

  function renderRecent(items) {
    if (!items.length) {
      recentEl.innerHTML = '<p class="wa-body-s wa-color-text-quiet">no recent updates</p>';
      return;
    }
    recentEl.innerHTML = items.map(function (it) {
      const variant = it.type === 'review' ? 'warning' : 'success';
      return '<div class="wa-cluster wa-gap-m" style="align-items: center">' +
        '<wa-badge variant="' + variant + '">' + esc(it.type) + '</wa-badge>' +
        '<strong>' + esc(it.book.title) + '</strong>' +
        '<span class="wa-body-s wa-color-text-quiet">' + esc(it.book.author) + '</span>' +
        '<span class="wa-caption-s wa-color-text-quiet">' + esc(it.did.slice(0, 20)) + '</span>' +
        '<wa-relative-time date="' + esc(it.createdAt) + '"></wa-relative-time>' +
        '</div>';
    }).join(divider());
  }

  function renderBooks(items) {
    if (!items.length) {
      newestEl.innerHTML = '<p class="wa-body-s wa-color-text-quiet">no books yet</p>';
      return;
    }
    newestEl.innerHTML = items.map(function (b) {
      return '<div class="wa-cluster wa-gap-m" style="align-items: baseline">' +
        '<strong>' + esc(b.title) + '</strong>' +
        '<span class="wa-body-s wa-color-text-quiet">' + esc(b.author) + '</span>' +
        '</div>';
    }).join(divider());
  }

  function renderTrending(items) {
    if (!items.length) return '<p class="wa-body-s wa-color-text-quiet">no activity</p>';
    return items.map(function (b, i) {
      return '<div class="wa-cluster wa-gap-m" style="align-items: baseline">' +
        '<wa-badge variant="neutral">#' + (i + 1) + '</wa-badge>' +
        '<strong>' + esc(b.title) + '</strong>' +
        '<span class="wa-body-s wa-color-text-quiet">' + esc(b.author) + '</span>' +
        '</div>';
    }).join(divider());
  }

  function setStatus(state) {
    statusEl.textContent = state === 'live' ? 'live' : 'reconnecting\u2026';
    statusEl.variant = state === 'live' ? 'success' : 'neutral';
  }

  async function refresh() {
    try {
      const res = await fetch(ENDPOINT);
      if (!res.ok) {
        if (res.status === 404) {
          recentEl.innerHTML = '<wa-callout variant="danger">feed generator feature is disabled</wa-callout>';
          newestEl.innerHTML = '';
          Object.keys(trendEls).forEach(function (k) { trendEls[k].innerHTML = ''; });
        }
        setStatus('reconnect');
        return;
      }
      const data = await res.json();
      renderRecent(data.recent || []);
      renderBooks(data.newestBooks || []);
      trendEls.day.innerHTML = renderTrending((data.trending || {}).day || []);
      trendEls.week.innerHTML = renderTrending((data.trending || {}).week || []);
      trendEls.month.innerHTML = renderTrending((data.trending || {}).month || []);
      setStatus('live');
    } catch (err) {
      recentEl.innerHTML = '<wa-callout variant="danger">couldn&apos;t reach the feed</wa-callout>';
      setStatus('reconnect');
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>`;
  return Layout({ title: 'Bibliograph Feeds', content });
}
