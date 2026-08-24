<script lang="ts">
  import type { Counts } from '$lib/server/stats';

  let { data }: { data: { counts: Counts } } = $props();

  // svelte-ignore state_referenced_locally
  let counts = $state<Counts>({ ...data.counts });
  let lastUpdated = $state<number>(Date.now());
  let now = $state<number>(Date.now());
  let isLive = $state<boolean>(true);

  const POLL_MS = 5_000;
  const TICK_MS = 1_000;
  const formatter = new Intl.NumberFormat('en-US');

  type Tile = { key: keyof Omit<Counts, 'generatedAt'>; label: string; href?: string };
  const tiles: Tile[] = [
    { key: 'works', label: 'Works', href: '/queries' },
    { key: 'editions', label: 'Editions', href: '/queries' },
    { key: 'contributors', label: 'Contributors', href: '/queries' },
    { key: 'publishers', label: 'Publishers' },
  ];

  function format(n: number): string {
    return formatter.format(n);
  }

  function ago(timestamp: number, reference: number): string {
    const seconds = Math.max(0, Math.floor((reference - timestamp) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  $effect(() => {
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    let inflight = false;
    let cancelled = false;

    async function poll() {
      if (inflight) return;
      if (document.hidden) return;
      inflight = true;
      try {
        const res = await fetch('/stats/counts', { headers: { accept: 'application/json' } });
        if (!res.ok) {
          isLive = false;
          return;
        }
        const payload = (await res.json()) as Counts;
        if (cancelled) return;
        counts = payload;
        lastUpdated = Date.now();
        isLive = true;
      } catch {
        isLive = false;
      } finally {
        inflight = false;
      }
    }

    pollTimer = setInterval(poll, POLL_MS);
    tickTimer = setInterval(() => { now = Date.now(); }, TICK_MS);
    const onVisibility = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (tickTimer) clearInterval(tickTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
</script>

<main>
  <section class="page-intro">
    <h1>Stats</h1>
    <p class="muted">
      Live row counts from the AppView database. Updates every {POLL_MS / 1000} seconds while this
      tab is visible.
    </p>
  </section>

  <section class="grid">
    {#each tiles as { key, label, href } (key)}
      <wa-card class="stat-card">
        <div slot="header" class="card-header">
          <span class="stat-label">{label}</span>
          <wa-badge variant={isLive ? 'success' : 'neutral'} appearance="tint">
            {#if isLive}
              <span class="dot dot-live" aria-hidden="true"></span>live
            {:else}
              stale
            {/if}
          </wa-badge>
        </div>
        <div class="stat-value" data-testid="stat-{key}">{format(counts[key])}</div>
        {#if href}
          <div slot="footer" class="card-footer">
            <a class="muted" {href}>Browse →</a>
          </div>
        {/if}
      </wa-card>
    {/each}
  </section>

  <section class="page-intro meta">
    <p class="muted">
      Last updated {ago(lastUpdated, now)}.
      {#if !isLive}<br />Showing last successful fetch; the AppView database may be unreachable.{/if}
    </p>
  </section>
</main>

<style>
  .page-intro {
    max-width: 50rem;
    margin: 2rem auto 0;
    padding: 0 2rem;
  }
  .page-intro h1 {
    margin: 0 0 0.5rem;
  }
  .meta {
    margin-top: 0.5rem;
  }
  .muted {
    color: var(--wa-color-on-quiet);
    line-height: 1.55;
    font-size: var(--wa-font-size-s);
    text-decoration: none;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 1rem;
    padding: 1rem 2rem 0.5rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .stat-label {
    font-weight: 600;
    font-size: var(--wa-font-size-s);
    color: var(--wa-color-on-quiet);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .stat-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 3rem;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.02em;
    padding: 0.5rem 0;
  }
  .stat-card {
    margin: 0;
  }
  .card-footer {
    text-align: right;
  }
  .dot {
    display: inline-block;
    width: 0.5em;
    height: 0.5em;
    border-radius: 50%;
    vertical-align: middle;
    margin-right: 0.35em;
    background: var(--wa-color-neutral-fill-quiet);
  }
  .dot-live {
    background: var(--wa-color-success-fill-loud, #2e7d32);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
</style>