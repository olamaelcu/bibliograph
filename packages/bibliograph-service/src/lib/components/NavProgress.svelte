<script lang="ts">
  // A thin top-of-page progress bar for client-side navigations.
  //
  // Behaviour follows the "trickle" pattern rather than a real percentage: a
  // client-side navigation has no measurable progress, so the bar eases toward
  // 90% while the request is in flight and snaps to 100% when it resolves. Two
  // details matter for it not to feel broken:
  //
  //   * it waits `delay` ms before appearing, so a navigation that resolves in
  //     30ms never flashes a bar;
  //   * it only reads `navigating`, never the URL, so back/forward and form
  //     actions are covered without special cases.
  //
  // Everything is styled from WebAwesome tokens, so it inherits the theme
  // (including dark mode) instead of hard-coding colours.

  import { navigating } from '$app/state';
  import { onDestroy, onMount, untrack } from 'svelte';

  let {
    delay = 140,
    trickleMs = 180,
    height = 'max(2px, var(--wa-space-3xs))',
    label = 'Loading page',
  }: {
    /** Milliseconds of navigation before the bar appears at all. */
    delay?: number;
    /** Milliseconds between trickle steps. */
    trickleMs?: number;
    /** Bar thickness; any CSS length. */
    height?: string;
    /** Accessible label for the progressbar. */
    label?: string;
  } = $props();

  type Phase = 'idle' | 'pending' | 'running' | 'finishing';

  let phase = $state<Phase>('idle');
  let width = $state(0);
  let reducedMotion = $state(false);

  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let trickleTimer: ReturnType<typeof setInterval> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const visible = $derived(phase === 'running' || phase === 'finishing');

  function clearTimers() {
    if (showTimer) clearTimeout(showTimer);
    if (trickleTimer) clearInterval(trickleTimer);
    if (hideTimer) clearTimeout(hideTimer);
    showTimer = undefined;
    trickleTimer = undefined;
    hideTimer = undefined;
  }

  function begin() {
    // A second navigation while we are already showing just keeps going; only a
    // fresh cycle needs the timers reset.
    if (phase === 'running' || phase === 'finishing') return;
    if (phase === 'pending') return;

    clearTimers();
    phase = 'pending';
    width = 0;

    showTimer = setTimeout(() => {
      showTimer = undefined;
      phase = 'running';
      width = 10;

      if (reducedMotion) return;
      trickleTimer = setInterval(() => {
        // Approach 90% asymptotically: fast at first, never reaching the end.
        width = Math.min(90, width + Math.max(0.6, (90 - width) * 0.1));
      }, trickleMs);
    }, delay);
  }

  function complete() {
    clearTimers();

    // Never appeared (fast navigation) — nothing to finish.
    if (phase === 'pending' || phase === 'idle') {
      phase = 'idle';
      width = 0;
      return;
    }

    phase = 'finishing';
    width = 100;
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      phase = 'idle';
      width = 0;
    }, 260);
  }

  // `navigating` from `$app/state` is an object of getters, not a nullable
  // value: `navigating !== null` is always true and would latch the bar on
  // forever. Reading a property (`to`) is what subscribes to navigation state
  // and returns null when idle.
  //
  // The helpers read and write component state, which would otherwise feed back
  // into this effect, so they run untracked.
  $effect(() => {
    const isNavigating = navigating.to !== null;
    untrack(() => {
      if (isNavigating) begin();
      else complete();
    });
  });

  onMount(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = query.matches;
    const onChange = () => {
      reducedMotion = query.matches;
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  });

  onDestroy(clearTimers);
</script>

<div
  class="nav-progress"
  class:visible
  data-phase={phase}
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(width)}
  aria-hidden={!visible}
  style:height
>
  <div class="bar" style:width="{width}%"></div>
</div>

<style>
  .nav-progress {
    position: fixed;
    inset-block-start: 0;
    inset-inline: 0;
    z-index: 1100;
    pointer-events: none;
    opacity: 0;
    transition: opacity 160ms ease-out;
  }

  .nav-progress.visible {
    opacity: 1;
  }

  .bar {
    height: 100%;
    background: var(--wa-color-brand-50);
    border-start-end-radius: var(--wa-border-radius-pill);
    border-end-end-radius: var(--wa-border-radius-pill);
    /* A soft leading edge so the bar reads as "in motion" without a gradient. */
    box-shadow: 0 0 8px color-mix(in srgb, var(--wa-color-brand-50) 55%, transparent);
    transition: width 180ms ease-out;
  }

  /* While resetting to zero the width must jump, not animate backwards. */
  .nav-progress[data-phase='idle'] .bar {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .nav-progress {
      transition: none;
    }
    .bar {
      transition: none;
    }
  }
</style>
