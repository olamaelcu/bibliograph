<script lang="ts">
  let {
    data,
  }: {
    data: {
      nsid: string;
      schemaRaw: string;
      params?: { kind: string; description?: string; fields?: Array<{ name: string; type: string; required: boolean; description?: string; defaultValue?: string; constraints?: string[] }> };
      input?: { kind: string; description?: string; fields?: Array<{ name: string; type: string; required: boolean; description?: string; defaultValue?: string; constraints?: string[] }> };
      output?: { kind: string; description?: string; fields?: Array<{ name: string; type: string; required: boolean; description?: string; defaultValue?: string; constraints?: string[] }> };
      errors: Array<{ name: string; description?: string }>;
    };
  } = $props();
</script>

<main class="wrapped-content">
  <p><a href="/procedures">← All procedures</a></p>

  <header class="row-head">
    <code class="endpoint-id">{data.nsid}</code>
    <wa-badge variant="success" appearance="tint">procedure</wa-badge>
  </header>

  {#if data.errors.length > 0}
    <section>
      <h2>Errors</h2>
      <ul class="spec">
        {#each data.errors as e}
          <li>
            <code>{e.name}</code>
            {#if e.description}<span class="muted"> — {e.description}</span>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if data.params?.fields}
    <section>
      <h2>Parameters</h2>
      <table>
        <thead>
          <tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr>
        </thead>
        <tbody>
          {#each data.params.fields as f}
            <tr>
              <td><code>{f.name}</code></td>
              <td><code class="param-type">{f.type}</code></td>
              <td>{f.required ? 'yes' : 'no'}</td>
              <td>
                {f.description ?? ''}
                {#if f.constraints && f.constraints.length > 0}
                  <div class="param-meta">[ {f.constraints.join(', ')} ]</div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  {#if data.input?.fields}
    <section>
      <h2>Input</h2>
      <table>
        <thead>
          <tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr>
        </thead>
        <tbody>
          {#each data.input.fields as f}
            <tr>
              <td><code>{f.name}</code></td>
              <td><code class="param-type">{f.type}</code></td>
              <td>{f.required ? 'yes' : 'no'}</td>
              <td>
                {f.description ?? ''}
                {#if f.constraints && f.constraints.length > 0}
                  <div class="param-meta">[ {f.constraints.join(', ')} ]</div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  {#if data.output?.fields}
    <section>
      <h2>Output</h2>
      <table>
        <thead>
          <tr><th>Field</th><th>Type</th><th>Description</th></tr>
        </thead>
        <tbody>
          {#each data.output.fields as f}
            <tr>
              <td><code>{f.name}</code></td>
              <td><code class="param-type">{f.type}</code></td>
              <td>
                {f.description ?? ''}
                {#if f.constraints && f.constraints.length > 0}
                  <div class="param-meta">[ {f.constraints.join(', ')} ]</div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  <section>
    <h2>Try it</h2>
    <p>
      <code><a href={`/xrpc/${data.nsid}`}>/xrpc/{data.nsid}</a></code>
    </p>
  </section>

  <section>
    <h2>Raw schema</h2>
    <pre><code>{data.schemaRaw}</code></pre>
  </section>
</main>

<style>
  .row-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .endpoint-id {
    font-weight: 600;
    font-size: var(--wa-font-size-m);
    word-break: break-all;
  }
  .muted {
    color: var(--wa-color-on-quiet);
    font-size: var(--wa-font-size-s);
    line-height: 1.55;
  }
  .param-type {
    color: var(--wa-color-on-quiet);
    font-size: var(--wa-font-size-s);
  }
  .param-meta {
    color: var(--wa-color-on-quiet);
    font-size: var(--wa-font-size-s);
    margin-top: 0.25rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: var(--wa-space-m) 0;
  }
  th, td {
    text-align: left;
    padding: var(--wa-space-s) var(--wa-space-m);
    border-bottom: 1px solid var(--wa-color-border-quiet);
    vertical-align: top;
  }
  th {
    font-weight: 600;
    font-size: var(--wa-font-size-s);
  }
  ul.spec {
    list-style: none;
    margin: var(--wa-space-m) 0;
    padding: 0;
  }
  ul.spec li {
    margin-bottom: var(--wa-space-s);
  }
  section {
    margin-top: var(--wa-space-l);
  }
</style>
