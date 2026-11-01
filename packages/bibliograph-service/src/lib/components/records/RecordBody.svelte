<script lang="ts">
  // The metadata card shared by the record detail pages: free text, optional
  // tags, then one list per column. Callers describe their columns as data, so a
  // new record kind means new data, not new markup.
  import type { Snippet } from "svelte";
  import type { BodyColumn } from "$lib/record-page";

  let {
    description,
    tags = [],
    columns,
    footer,
  }: {
    description?: string;
    tags?: string[];
    columns: BodyColumn[];
    footer?: Snippet;
  } = $props();
</script>

<wa-card appearance="outlined" class="details">
  {#if description}
    <p class="description">{description}</p>
  {/if}

  {#if tags.length > 0}
    <div class="tags">
      {#each tags as tag (tag)}
        <wa-tag size="s" variant="brand" appearance="outlined">{tag}</wa-tag>
      {/each}
    </div>
  {/if}

  <div class="columns">
    {#each columns as column (column.title)}
      <section>
        <h2>{column.title}</h2>
        {#if column.items.length > 0}
          <ul>
            {#each column.items as item (item.text)}
              <li>
                {#if item.initials}
                  <wa-avatar
                    initials={item.initials}
                    label={item.text}
                  ></wa-avatar>
                {/if}
                {#if item.meta}<code>{item.meta}</code>{/if}
                {#if item.href}
                  <a href={item.href}>{item.text}</a>
                {:else if item.code}
                  <code class="value">{item.text}</code>
                {:else}
                  <span>{item.text}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted small">
            {column.empty ?? `No ${column.title.toLowerCase()} recorded.`}
          </p>
        {/if}
      </section>
    {/each}
  </div>

  {#if footer}
    <div class="footer">{@render footer()}</div>
  {/if}
</wa-card>

<style>
  .description {
    margin: 0 0 var(--wa-space-l);
    font-family: var(--wa-font-family-longform);
    font-size: var(--wa-font-size-m);
    line-height: 1.7;
    max-width: 68ch;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-xs);
    margin-block-end: var(--wa-space-l);
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--wa-space-l);
  }
  h2 {
    margin: 0 0 var(--wa-space-s);
    font-size: var(--wa-font-size-s);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--wa-color-on-quiet);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-s);
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--wa-space-s);
    font-size: var(--wa-font-size-s);
    flex-wrap: wrap;
  }
  li wa-avatar {
    --size: 1.75rem;
  }
  li a {
    color: var(--wa-color-text-link);
  }
  .value {
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--wa-color-on-quiet);
  }
  .small {
    font-size: var(--wa-font-size-s);
  }
  .footer {
    margin-block-start: var(--wa-space-l);
  }
</style>
