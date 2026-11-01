<script lang="ts">
  // Hero band shared by the record detail pages: optional poster, tracker-style
  // kicker, headline, chips and a byline of contributor avatars.
  import { initialsFromUri, type Chip, type Person } from "$lib/record-page";

  let {
    kicker,
    kickerDetail,
    title,
    subtitle,
    poster,
    chips = [],
    people = [],
  }: {
    kicker: string;
    /** Record key shown next to the kicker; kept un-transformed so it stays copyable. */
    kickerDetail?: string;
    title: string;
    subtitle?: string;
    poster?: { src: string; animated?: boolean };
    chips?: Chip[];
    people?: Person[];
  } = $props();
</script>

<header class="hero" class:with-poster={!!poster}>
  {#if poster}
    <div class="poster">
      {#if poster.animated}
        <wa-animated-image src={poster.src} alt=""></wa-animated-image>
      {:else}
        <img src={poster.src} alt="" loading="lazy" />
      {/if}
    </div>
  {/if}

  <div class="copy">
    <p class="kicker">
      {kicker}{#if kickerDetail}<code>{kickerDetail}</code>{/if}
    </p>
    <h1>{title}</h1>
    {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}

    {#if chips.length > 0}
      <div class="chips">
        {#each chips as chip (chip.label)}
          {#if chip.tone === "danger"}
            <wa-badge variant="danger" appearance="filled">{chip.label}</wa-badge>
          {:else}
            <wa-tag size="s" variant={chip.tone ?? "neutral"} appearance="outlined"
              >{chip.label}</wa-tag
            >
          {/if}
        {/each}
      </div>
    {/if}

    {#if people.length > 0}
      <div class="byline">
        {#each people as person (person.uri + (person.role ?? ""))}
          <span class="person">
            <wa-avatar
              initials={initialsFromUri(person.uri)}
              label={person.uri}
            ></wa-avatar>
            {#if person.role}<code>{person.role}</code>{/if}
          </span>
        {/each}
      </div>
    {/if}
  </div>
</header>

<style>
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--wa-space-l);
    align-items: center;
  }
  .hero.with-poster {
    grid-template-columns: minmax(9rem, 15rem) minmax(0, 1fr);
    gap: var(--wa-space-2xl);
  }
  .poster img,
  .poster wa-animated-image {
    width: 100%;
    display: block;
    border-radius: var(--wa-border-radius-m);
    border: 1px solid var(--wa-form-control-border-color);
    box-shadow: 0 12px 28px -22px rgb(0 0 0 / 60%);
  }
  .kicker {
    margin: 0;
    font-size: var(--wa-font-size-2xs);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--wa-color-on-quiet);
  }
  .kicker code {
    margin-inline-start: 0.5em;
    letter-spacing: normal;
    text-transform: none;
  }
  h1 {
    margin: var(--wa-space-2xs) 0 0;
    font-family: var(--wa-font-family-heading);
    font-size: var(--wa-font-size-4xl);
    line-height: 1;
    letter-spacing: -0.03em;
  }
  .subtitle {
    margin: var(--wa-space-s) 0 0;
    font-size: var(--wa-font-size-l);
    color: var(--wa-color-on-quiet);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-xs);
    margin-block-start: var(--wa-space-m);
  }
  .byline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-m);
    margin-block-start: var(--wa-space-m);
  }
  .person {
    display: flex;
    align-items: center;
    gap: var(--wa-space-s);
    font-size: var(--wa-font-size-s);
  }
  .person wa-avatar {
    --size: 1.75rem;
  }
  @media (max-width: 44rem) {
    .hero.with-poster {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--wa-space-l);
    }
    .poster {
      max-width: 11rem;
    }
  }
</style>
