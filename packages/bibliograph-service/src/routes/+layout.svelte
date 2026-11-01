<script lang="ts">
  import "@awesome.me/webawesome/dist/styles/webawesome.css";
  import "@awesome.me/webawesome/dist/styles/themes/default.css";
  // Hydration support must be imported BEFORE any WebAwesome component.
  // This enables Declarative Shadow DOM hydration when SSR'd content reaches the client.
  import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
  import "@awesome.me/webawesome/dist/components/animated-image/animated-image.js";
  import "@awesome.me/webawesome/dist/components/avatar/avatar.js";
  import "@awesome.me/webawesome/dist/components/page/page.js";
  import "@awesome.me/webawesome/dist/components/badge/badge.js";
  import "@awesome.me/webawesome/dist/components/breadcrumb/breadcrumb.js";
  import "@awesome.me/webawesome/dist/components/breadcrumb-item/breadcrumb-item.js";
  import "@awesome.me/webawesome/dist/components/button/button.js";
  import "@awesome.me/webawesome/dist/components/button-group/button-group.js";
  import "@awesome.me/webawesome/dist/components/callout/callout.js";
  import "@awesome.me/webawesome/dist/components/card/card.js";
  import "@awesome.me/webawesome/dist/components/copy-button/copy-button.js";
  import "@awesome.me/webawesome/dist/components/details/details.js";
  import "@awesome.me/webawesome/dist/components/divider/divider.js";
  import "@awesome.me/webawesome/dist/components/icon/icon.js";
  import "@awesome.me/webawesome/dist/components/input/input.js";
  import "@awesome.me/webawesome/dist/components/option/option.js";
  import "@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js";
  import "@awesome.me/webawesome/dist/components/progress-ring/progress-ring.js";
  import "@awesome.me/webawesome/dist/components/select/select.js";
  import "@awesome.me/webawesome/dist/components/tab/tab.js";
  import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
  import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
  import "@awesome.me/webawesome/dist/components/tag/tag.js";
  import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
  import { page } from "$app/state";
  import { setViewer } from "$lib/stores/auth";
  import NavProgress from "$lib/components/NavProgress.svelte";
  import type { Snippet } from "svelte";

  const navLinks = [
    { href: "/", label: "Home" },
    { href: "/queries", label: "Queries" },
    { href: "/stats", label: "Stats" },
    { href: "/search", label: "Search" },
    // { href: "/records", label: "Records" },
    // { href: "/examples", label: "Examples" },
  ];

  // A nav link is active when the current pathname equals its href OR
  // (for non-root links) starts with the href + '/'. Special aliases:
  // /query/... also highlights /queries; the four detail-page kinds
  // (/editions/, /works/, /contributors/, /publishers/) all highlight Search.
  function isActive(href: string, pathname: string): boolean {
    if (href === "/") return pathname === "/";
    if (pathname === href || pathname.startsWith(href + "/")) return true;
    if (href === "/queries" && pathname.startsWith("/query/")) return true;
    if (href === "/search" && (
      pathname.startsWith("/editions/") || pathname.startsWith("/works/") ||
      pathname.startsWith("/contributors/") || pathname.startsWith("/publishers/")
    )) return true;
    return false;
  }

  let {
    data,
    children,
  }: {
    data: {
      viewer: { did: string; handle: string | null } | null;
      viewerIsAdmin: boolean;
    };
    children: Snippet;
  } = $props();

  // Mirror the server's session into the client store. `$effect` runs in the
  // browser only, so SSR never writes module-level state (see stores/auth.ts).
  $effect(() => {
    setViewer(data.viewer);
  });
</script>

<svelte:head>
  <script>
    // WebAwesome color-scheme detection — runs synchronously in <head> before paint.
    // Per https://webawesome.com/docs/customizing#detecting-color-scheme-preference
    (function () {
      try {
        var stored = localStorage.getItem("wa-color-scheme");
        var prefersDark =
          stored !== null
            ? stored === "dark"
            : window.matchMedia("(prefers-color-scheme: dark)").matches;
        if (prefersDark) {
          document.documentElement.classList.add("wa-dark");
        }
        window
          .matchMedia("(prefers-color-scheme: dark)")
          .addEventListener("change", function (e) {
            if (localStorage.getItem("wa-color-scheme") === null) {
              document.documentElement.classList.toggle("wa-dark", e.matches);
            }
          });
        window.__toggleWaColorScheme = function () {
          var toDark = !document.documentElement.classList.contains("wa-dark");
          document.documentElement.classList.toggle("wa-dark", toDark);
          try {
            localStorage.setItem("wa-color-scheme", toDark ? "dark" : "light");
          } catch (_) {}
        };
      } catch (e) {
        document.documentElement.classList.add("wa-dark");
      }
    })();
  </script>
</svelte:head>

<!-- Outside <wa-page> so no shadow-DOM stacking context can trap it. -->
<NavProgress />

<wa-page mobile-breakpoint="920">
  <header class="topbar" slot="header">
    <a class="brand" href="/">
      <wa-icon name="circle-star" library="default"></wa-icon>
      <span class="brand-name">Bibliograph</span>
      <span class="brand-sub">net.olamaelcu.livtet.biblio</span>
    </a>
    <nav class="nav">
      {#each navLinks as link}
        <a
          href={link.href}
          class:active={isActive(link.href, page.url.pathname)}
          >{link.label}</a
        >
      {/each}
    </nav>
    <div class="auth">
      {#if data.viewer}
        {#if data.viewerIsAdmin}
          <a class="admin" href="/admin">Admin</a>
        {/if}
        <span class="who" title={data.viewer.did}>
          {data.viewer.handle ?? data.viewer.did}
        </span>
        <form method="POST" action="/logout">
          <button type="submit">Sign out</button>
        </form>
      {:else}
        <a class="signin" href="/login?next={encodeURIComponent(page.url.pathname + page.url.search)}">Sign in</a>
      {/if}
    </div>
  </header>

  {@render children()}

  <footer class="footer" slot="footer">
    <div class="footer-col">
      <div class="footer-head">Bibliograph</div>
      <p class="muted" style="margin: 0">
        A literary-centric AT Protocol AppView over
        <code>net.olamaelcu.livtet.biblio</code>.
      </p>
    </div>
    <div class="footer-col">
      <div class="footer-head">Product</div>
      {#each navLinks as link}
        <a href={link.href}>{link.label}</a>
      {/each}
    </div>
    <div class="footer-col">
      <div class="footer-head">Project</div>
      <a href="https://atproto.com/guides/glossary#app-view"
        >AT Protocol AppView</a
      >
      <a href="https://atproto.com">AT Protocol</a>
      <a href="https://openlibrary.org">Open Library</a>
    </div>
    <div class="footer-col">
      <div class="footer-head">Built by</div>
      <a href="https://www.olamaelcu.net">Olamaeclu</a>
    </div>
  </footer>
</wa-page>

<style>
  :global(:root) {
    color-scheme: light dark;
  }

  :global(:not([did-ssr]):not(:defined)) {
    visibility: hidden;
  }

  wa-page {
    --wa-page-width: 1100px;
  }

  /* ---- Top bar ------------------------------------------------------- */

  .topbar {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.9rem var(--wa-space-l);
    background: var(--wa-color-surface-raised);
    border-bottom: 1px solid var(--wa-form-control-border-color);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--wa-space-m);
    text-decoration: none;
    color: var(--wa-color-text-normal);
    white-space: nowrap;
  }

  .brand wa-icon {
    font-size: var(--wa-font-size-m);
    color: var(--wa-color-brand-50);
  }

  .brand-name {
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .brand-sub {
    color: var(--wa-color-on-quiet);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: var(--wa-font-size-xs);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: 4px;
    padding: 0.1rem 0.35rem;
    background: var(--wa-color-surface-lowered);
  }

  .topbar .nav {
    display: flex;
    gap: 1.25rem;
    margin: 0 auto;
  }

  .topbar .nav a {
    color: var(--wa-color-on-quiet);
    text-decoration: none;
    font-weight: 500;
    font-size: var(--wa-font-size-s);
    padding: var(--wa-space-s) 0;
    border-bottom: 2px solid transparent;
  }

  .topbar .nav a:hover {
    color: var(--wa-color-text-normal);
  }

  .topbar .nav a.active {
    color: var(--wa-color-text-normal);
    border-bottom-color: var(--wa-color-brand-50);
  }

  /* ---- Auth --------------------------------------------------------- */

  .auth {
    display: flex;
    align-items: center;
    gap: var(--wa-space-s);
    font-size: var(--wa-font-size-s);
    white-space: nowrap;
  }

  .auth .who {
    color: var(--wa-color-on-quiet);
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .auth form {
    margin: 0;
  }

  .auth button,
  .auth .signin,
  .auth .admin {
    padding: 0.25rem 0.7rem;
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: transparent;
    color: var(--wa-color-text-normal);
    font-size: var(--wa-font-size-s);
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
  }

  .auth button:hover,
  .auth .signin:hover,
  .auth .admin:hover {
    border-color: var(--wa-color-brand-50);
    color: var(--wa-color-brand-50);
  }

  .auth .admin {
    border-color: var(--wa-color-brand-50);
    color: var(--wa-color-brand-50);
  }

  /* ---- Footer ------------------------------------------------------- */

  .footer {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1.5rem;
    max-width: 1100px;
    margin: var(--wa-space-l) auto 0;
    padding: var(--wa-space-l) var(--wa-space-l) var(--wa-space-l);
    border-top: 1px solid var(--wa-form-control-border-color);
  }

  .footer-col {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: var(--wa-font-size-s);
  }

  .footer-col .footer-head {
    font-weight: 700;
    margin-bottom: var(--wa-space-s);
  }

  .footer-col a {
    color: var(--wa-color-on-quiet);
    text-decoration: none;
    width: fit-content;
  }

  .footer-col a:hover {
    color: var(--wa-color-brand-50);
  }

  .muted {
    color: var(--wa-color-on-quiet);
  }
</style>
