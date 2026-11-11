<script lang="ts">
  import "@awesome.me/webawesome/dist/components/button/button.js";
  import "@awesome.me/webawesome/dist/components/callout/callout.js";
  import "@awesome.me/webawesome/dist/components/details/details.js";
  import "@awesome.me/webawesome/dist/components/option/option.js";
  import "@awesome.me/webawesome/dist/components/progress-ring/progress-ring.js";
  import "@awesome.me/webawesome/dist/components/select/select.js";
  // Edition detail view.
  //
  // Hero, then the vote dock that sticks under the site header while you read,
  // then the metadata card. The vote form lives in a `<wa-details>` disclosure
  // so it stays reachable without JavaScript (a popover would hide a POST form
  // behind a JS-only click).
  import ActionFeedback from "$lib/components/records/ActionFeedback.svelte";
  import ControversialToggle from "$lib/components/records/ControversialToggle.svelte";
  import RecordBody from "$lib/components/records/RecordBody.svelte";
  import RecordHero from "$lib/components/records/RecordHero.svelte";
  import LibrarianRequest from "./LibrarianRequest.svelte";
  import SignInPrompt from "./SignInPrompt.svelte";
  import VoteTally from "./VoteTally.svelte";
  import type { Chip } from "$lib/record-page";
  import { contributorItems, identifierItems, peopleFromContributions } from "$lib/record-page";
  import {
    type EditionView,
    pendingNote,
    voteMargin,
    voteProgress,
    votesFor,
    workRkey,
  } from "$lib/edition-votes";

  let {
    rkey,
    value,
    status,
    candidates,
    canCurate,
    application,
    controversial,
    canLabel,
    loggedIn,
    form,
  }: EditionView = $props();

  const progress = $derived(voteProgress(status));
  const ringLabel = $derived(
    status
      ? `Net vote margin ${voteMargin(status)} of ${status.threshold} needed for consensus`
      : "",
  );
  const poster = $derived(
    value.coverImageUrl
      ? {
          src: value.coverImageUrl,
          animated: /\.(gif|webp|apng)$/i.test(value.coverImageUrl),
        }
      : undefined,
  );
  const chips = $derived.by((): Chip[] => {
    const list: Chip[] = [];
    if (value.publishedYear) list.push({ label: String(value.publishedYear) });
    if (value.language) list.push({ label: value.language });
    if (value.place) list.push({ label: value.place });
    if (controversial) list.push({ label: "Controversial", tone: "danger" });
    return list;
  });
  const columns = $derived([
    {
      title: "Contributors",
      items: contributorItems(value.contributors),
    },
    { title: "Identifiers", items: identifierItems(value.identifiers) },
  ]);
</script>

<section class="detail">
  <RecordHero
    kicker="Edition"
    kickerDetail={rkey}
    title={value.title}
    subtitle={value.subtitle}
    {poster}
    {chips}
    people={peopleFromContributions(value.contributors)}
  />

  {#if status && loggedIn}
    <wa-callout appearance="outlined" class="dock-bar">
      <div class="dock-row">
        <wa-progress-ring
          value={progress}
          label={ringLabel}
          class="ring"
        ></wa-progress-ring>
        <div class="dock-copy">
          <strong>
            {#if status.workUri}
              Linked to {workRkey(status.workUri)}
            {:else}
              No work link yet
            {/if}
          </strong>
          <span class="muted small">{pendingNote(status)}</span>
        </div>
      </div>
      <wa-details summary="Vote" appearance="outlined" class="dock-details">
        <VoteTally {status} />
        {#if !canCurate}
          <LibrarianRequest {application} {form} />
        {:else if candidates.length > 0 || status.workUri}
          <form method="POST" action="?/linkWork" class="link-form">
            <wa-select
              name="workUri"
              label="Link to a work"
              placeholder="Choose a work…"
              size="s"
              required
            >
              {#each candidates as candidate (candidate.uri)}
                <wa-option value={candidate.uri}>
                  {candidate.title}{candidate.year
                    ? ` (${candidate.year})`
                    : ""} — {workRkey(candidate.uri)}
                  {votesFor(status, candidate.uri) > 0
                    ? ` · ${votesFor(status, candidate.uri)} vote(s)`
                    : ""}
                </wa-option>
              {/each}
              {#if status.workUri && !candidates.some((c) => c.uri === status.workUri)}
                <wa-option value={status.workUri}>
                  {workRkey(status.workUri)} (currently linked)
                </wa-option>
              {/if}
            </wa-select>
            <wa-button type="submit" variant="brand" size="s"
              >Vote to link</wa-button
            >
          </form>
          {#if status.workUri}
            <form method="POST" action="?/unlinkWork">
              <wa-button type="submit" appearance="outlined" size="s"
                >Vote to unlink</wa-button
              >
            </form>
          {/if}
        {/if}
        {#if canCurate}
          <form
            method="POST"
            action="?/deleteEdition"
            class="delete-form"
            onsubmit={(event) => {
              if (!confirm(`Delete ${rkey} from the catalog? This cannot be undone.`)) {
                event.preventDefault();
              }
            }}
          >
            <wa-button type="submit" variant="danger" appearance="outlined" size="s"
              >Delete edition</wa-button
            >
            <span class="muted small">
              Removes the catalog row, its votes and its labels; a linked work goes only when no
              other edition uses it.
            </span>
          </form>
        {/if}
      </wa-details>
    </wa-callout>
  {/if}

  <ActionFeedback
    {form}
    success={form?.requested
      ? "Librarian access requested."
      : form?.backfill
        ? "Backfill queued for this edition."
      : "Vote recorded in your repository."}
  />
  <ControversialToggle {controversial} {canLabel} />

  {#if canLabel}
    <form method="POST" action="?/runBackfill" class="backfill-form">
      <wa-button type="submit" appearance="outlined" size="s">
        Queue description + metadata backfill
      </wa-button>
      <span class="muted small">
        Google Books (description) + Goodreads (format, pages, year, language). Fills
        missing fields only; runs on the worker.
      </span>
    </form>
  {/if}

  <RecordBody
    description={value.description}
    columns={columns}
  >
    {#snippet footer()}
      {#if status && !loggedIn}
        <SignInPrompt {rkey} />
      {/if}
    {/snippet}
  </RecordBody>
</section>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-l);
  }
  .dock-bar {
    position: sticky;
    inset-block-start: var(--wa-space-s);
    z-index: 2;
  }
  .dock-row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-m);
    flex-wrap: wrap;
  }
  .ring {
    --size: 3.25rem;
    flex: none;
  }
  .dock-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 16rem;
  }
  .dock-details {
    display: block;
    margin-block-start: var(--wa-space-s);
  }
  .dock-details :global(wa-select) {
    min-width: min(20rem, 100%);
    max-width: 100%;
  }
  .link-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-s);
    align-items: flex-end;
    margin-block-end: var(--wa-space-s);
  }
  .delete-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-s);
    align-items: center;
    margin-block-start: var(--wa-space-s);
  }
  .backfill-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-s);
    align-items: center;
    margin-block-end: var(--wa-space-s);
  }
  .small {
    font-size: var(--wa-font-size-s);
  }
  .muted {
    color: var(--wa-color-on-quiet);
  }
  @media (max-width: 44rem) {
    /* Sticking under the site header only pays off when there is room for it. */
    .dock-bar {
      position: static;
    }
  }
</style>
