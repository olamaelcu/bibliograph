# Pagination

`<wa-pagination>`

Experimental [Navigation](https://webawesome.com/docs/components/?category=navigation) [Since 3.11](https://webawesome.com/docs/resources/changelog#wa_3110)

Pagination splits long lists of content into pages, letting users navigate between them.

```html
<wa-pagination total="237" page-size="10" page="3" label="Search results"></wa-pagination>
```

Set `total` and `page-size` to generate numbered page buttons with previous and next controls. Use the `label` attribute to give the control an accessible name, which is especially helpful when more than one appears on the same page.

**Pagination is a navigation control, not a form control.**  
It tracks the current page and emits events, but it doesn't submit a value with a form. Keep `page` in sync with your data by updating it in response to the [`wa-page-change`](#responding-to-page-changes) event.

## Accessibility Considerations

Pagination ships with several accessibility behaviors built in:

-   **Page changes are announced.** When the page changes, the new position is announced to screen readers through a shared live region, so the update isn't silent.
-   **Focus follows the page.** After a control is activated, focus moves to the new current page rather than falling back to the top of the document, keeping keyboard users oriented.
-   **The current page is marked.** The active page carries `aria-current="page"`, and disabled or boundary controls carry `aria-disabled` so assistive technology skips them.
-   **Icons are direction-aware.** The previous, next, first, and last icons flip automatically in right-to-left languages.

Give the control an accessible name with the `label` attribute whenever more than one pagination appears on a page, so screen reader users can tell them apart.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/pagination/pagination.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/pagination/pagination.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/pagination/pagination.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaPagination from '@awesome.me/webawesome/dist/react/pagination/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| \`first-icon\` | An icon to use in lieu of the default first icon. |
| \`last-icon\` | An icon to use in lieu of the default last icon. |
| \`next-icon\` | An icon to use in lieu of the default next icon. |
| \`previous-icon\` | An icon to use in lieu of the default previous icon. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`'outlined' \\| 'filled' \\| 'plain'\` The pagination's visual appearance. Type Default 'outlined' | |
| \`boundaryCount\` boundary-count | \`number\` The of pages to always show at the start and end. Type number Default 1 | |
| \`disabled\` disabled | \`boolean\` Disables the pagination. Type Default false | |
| \`format\` format | \`standard\` The pagination's layout. The default format shows the full page list with ellipses; compact collapses it into a short "1 of 5" label flanked by the previous and next buttons, useful in tight spaces like toolbars and cards. Type 'standard' \\| 'compact' Default 'standard' | |
| \`hideSinglePage\` hide-single-page | \`boolean\` Renders nothing when there's only one page. Type Default false | |
| \`hrefTemplate\` href-template | \`[\` A URL template used to render page items as links instead of buttons. When set, items render as elements for SSR, SEO, and no-JS support. Provide a string with {page} as a placeholder for the page number, e.g. /products?page={page}. In JavaScript, you can also assign a function that receives the page number and returns the URL, e.g. el.hrefTemplate = page => \\/products?page=${page}\`\`. Type string \\| ((page: number) => string) Default '' | |
| \`label\` label | \`string\` A label that describes the pagination to assistive devices. This won't be shown on the screen, but it will be announced by screen readers. Especially useful when more than one pagination control exists on the same page. Type Default '' | |
| \`page\` page | \`number\` The current page, starting at 1. Type Default 1 | |
| \`pageSize\` page-size | \`number\` The of items shown per page. Type number Default 10 | |
| \`siblingCount\` sibling-count | \`number\` The of pages to show on each side of the current page. Type number Default 2 | |
| \`total\` total | \`number\` The total of items to paginate. Type number Default 0 | |
| \`totalPages\` | \`total\` The number of pages, derived from total and pageSize. | |
| \`withEdges\` with-edges | \`boolean\` Shows buttons that jump to the first and last pages. Type Default false | |
| \`withoutNav\` without-nav | \`boolean\` Hides the previous and next buttons. Type Default false | |
| \`withSummary\` with-summary | \`boolean\` Shows a summary of the items on the current page, e.g. "1–10 of 237". Type Default false | |]()

### Events

| Name | Description |
| --- | --- |
| \`wa-before-page-change\` | \`event.preventDefault()\` Emitted when the page is about to change but before it does. Canceling this event with prevents the page from changing. |
| \`wa-page-change\` | Emitted after the page changes. |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`disabled\` | Applied when the pagination is disabled. | \`:state(disabled)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`button\` | Every button or link, including page numbers and navigation controls. | \`::part(button)\` |
| \`ellipsis\` | An ellipsis for collapsed pages. Acts as a button that jumps several pages toward that side. | \`::part(ellipsis)\` |
| \`first-button\` | The first button. | \`::part(first-button)\` |
| \`label\` | \`compact\` The "1 of 5" label shown between the navigation buttons in the layout. | \`::part(label)\` |
| \`last-button\` | The last button. | \`::part(last-button)\` |
| \`next-button\` | The next button. | \`::part(next-button)\` |
| \`page\` | A page number button or link. | \`::part(page)\` |
| \`page-current\` | The current page number button or link. | \`::part(page-current)\` |
| \`pages\` | The list that wraps the page number items. | \`::part(pages)\` |
| \`pagination\` | \`

\` The component's outer wrapper, a element. | \`::part(pagination)\` |
| \`previous-button\` | The previous button. | \`::part(previous-button)\` |
| \`summary\` | \`with-summary\` The summary of items on the current page, shown with the attribute. | \`::part(summary)\` |
| \`base\` | \`pagination\` Deprecated. Use the part instead. | \`::part(base)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)

## Examples

### Appearance

Set the `appearance` attribute to change the pagination's visual style. Valid appearances are `outlined` (the default), `filled`, and `plain`.

```html
<div class="wa-stack">
  <wa-pagination total="237" page-size="10" page="3" appearance="outlined"></wa-pagination>
  <wa-pagination total="237" page-size="10" page="3" appearance="filled"></wa-pagination>
  <wa-pagination total="237" page-size="10" page="3" appearance="plain"></wa-pagination>
</div>
```

### Size

Pagination has no `size` attribute; set `font-size` on the control or any ancestor to scale it.

```html
<div class="wa-stack">
  <wa-pagination total="237" page-size="10" page="3" style="font-size: var(--wa-font-size-s)"></wa-pagination>
  <wa-pagination total="237" page-size="10" page="3"></wa-pagination>
  <wa-pagination total="237" page-size="10" page="3" style="font-size: var(--wa-font-size-l)"></wa-pagination>
</div>
```

### Number of Buttons

Use the `sibling-count` attribute to set how many pages show on each side of the current page (defaults to `2`), and `boundary-count` to set how many show at the start and end (defaults to `1`). Remaining pages collapse into an ellipsis, which jumps several pages toward that side when activated.

```html
<div class="wa-stack">
  <wa-pagination total="1000" page-size="10" page="50" sibling-count="1" boundary-count="1"></wa-pagination>
  <wa-pagination total="1000" page-size="10" page="50" sibling-count="3" boundary-count="2"></wa-pagination>
</div>
```

### First and Last Buttons

Add the `with-edges` attribute to show buttons that jump to the first and last pages.

```html
<wa-pagination total="237" page-size="10" page="10" with-edges></wa-pagination>
```

### Previous and Next Buttons

Add the `without-nav` attribute to hide the previous and next buttons, leaving only the page numbers.

```html
<wa-pagination total="237" page-size="10" page="3" without-nav></wa-pagination>
```

### Summary

Add the `with-summary` attribute to show a summary of the items on the current page.

```html
<wa-pagination total="237" page-size="10" page="1" with-summary></wa-pagination>
```

### Compact

Set the `format` attribute to `compact` to replace the page numbers with a short "1 of 5" label between the previous and next buttons.

```html
<wa-pagination total="237" page-size="10" page="1" format="compact"></wa-pagination>
```

The compact format can be combined with other features, such as `with-summary`:

```html
<wa-pagination total="237" page-size="10" page="1" format="compact" with-summary></wa-pagination>
```

### Custom Icons

Use the `previous-icon`, `next-icon`, `first-icon`, and `last-icon` slots to replace the default navigation icons.

```html
<wa-pagination total="237" page-size="10" page="5" with-edges>
  <wa-icon slot="previous-icon" name="backward-step"></wa-icon>
  <wa-icon slot="next-icon" name="forward-step"></wa-icon>
  <wa-icon slot="first-icon" name="backward-fast"></wa-icon>
  <wa-icon slot="last-icon" name="forward-fast"></wa-icon>
</wa-pagination>
```

**Replacing an icon doesn't replace its label.**  
The navigation buttons keep their built-in accessible labels, so screen readers still announce them correctly.

### Disabled

Add the `disabled` attribute to disable the entire pagination control.

```html
<wa-pagination total="237" page-size="10" page="3" disabled></wa-pagination>
```

### Single Page

Add the `hide-single-page` attribute to render nothing when there's only one page of results. Since a single page renders nothing, this example is shown as code rather than a live preview.

```html
<wa-pagination total="5" page-size="10" hide-single-page></wa-pagination>
```

### Page Size Selector

Pair a [select](https://webawesome.com/docs/components/select) with the pagination control to let users change the page size. Update `page-size` when the selection changes, and reset to the first page.

```html
<div class="pagination-page-size">
  <wa-pagination total="237" page-size="10" page="1"></wa-pagination>

  <wa-select label="Items per page" value="10" size="s">
    <wa-option value="10">10</wa-option>
    <wa-option value="20">20</wa-option>
    <wa-option value="50">50</wa-option>
    <wa-option value="100">100</wa-option>
  </wa-select>
</div>

<style>
  .pagination-page-size {
    display: flex;
    align-items: end;
    gap: var(--wa-space-l);
    flex-wrap: wrap;
  }

  .pagination-page-size wa-select {
    inline-size: 8rem;
  }
</style>

<script>
  const container = document.querySelector('.pagination-page-size');
  const pagination = container.querySelector('wa-pagination');
  const select = container.querySelector('wa-select');

  select.addEventListener('change', () => {
    pagination.pageSize = Number(select.value);
    pagination.page = 1;
  });
</script>
```

### Responding to Page Changes

When the user changes the page, the `wa-page-change` event is emitted with `{ page, pageSize }` in `event.detail`. Update the `page` property to reflect the new page and load the corresponding data.

```html
<div class="pagination-change-demo">
  <wa-pagination class="pagination-change" total="237" page-size="10" page="1"></wa-pagination>

  <wa-divider></wa-divider>

  <small class="pagination-change-output" style="display: block">Showing page 1</small>
</div>

<script>
  const container = document.querySelector('.pagination-change-demo');
  const pagination = container.querySelector('.pagination-change');
  const output = container.querySelector('.pagination-change-output');

  pagination.addEventListener('wa-page-change', event => {
    pagination.page = event.detail.page;
    output.textContent = `Showing page ${event.detail.page}`;
  });
</script>
```

### Setting the Page Programmatically

Set the `page` property to any valid page to change the current page without user interaction. Setting `page` directly doesn't emit `wa-page-change`.

```html
<div class="pagination-set-demo">
  <wa-pagination class="pagination-set" total="237" page-size="10" page="1"></wa-pagination>

  <wa-divider></wa-divider>

  <div class="wa-cluster">
    <wa-button appearance="filled" data-page="1">Page 1</wa-button>
    <wa-button appearance="filled" data-page="5">Page 5</wa-button>
    <wa-button appearance="filled" data-page="10">Page 10</wa-button>
  </div>
</div>

<script>
  const container = document.querySelector('.pagination-set-demo');
  const pagination = container.querySelector('.pagination-set');

  container.querySelectorAll('[data-page]').forEach(button => {
    button.addEventListener('click', () => {
      pagination.page = Number(button.dataset.page);
    });
  });
</script>
```

### Preventing a Page Change

Call `event.preventDefault()` on the `wa-before-page-change` event to cancel a page change, such as to guard against unsaved changes.

```html
<wa-pagination class="pagination-guard" total="237" page-size="10" page="1"></wa-pagination>

<script>
  const pagination = document.querySelector('.pagination-guard');

  pagination.addEventListener('wa-before-page-change', event => {
    if (!window.confirm(`Leave for page ${event.detail.page}?`)) {
      event.preventDefault();
    }
  });

  pagination.addEventListener('wa-page-change', event => {
    pagination.page = event.detail.page;
  });
</script>
```

### Rendering Links Instead of Buttons

Set the `href-template` attribute to render page items as links instead of buttons, using `{page}` as a placeholder for the page number. Every control links through the template, which works well for server-rendered pages.

```html
<wa-pagination total="237" page-size="10" page="3" href-template="?page={page}"></wa-pagination>
```

In JavaScript, you can also set the `hrefTemplate` property to a function that receives the page number and returns the URL. This is handy when the URL doesn't follow a simple substitution. When server-rendering, set the `href-template` attribute to the closest equivalent as well, so the server and the browser render the same markup.

```html
<wa-pagination
  class="pagination-href-fn"
  total="237"
  page-size="10"
  page="3"
  href-template="?page={page}#results"
></wa-pagination>

<script>
  const pagination = document.querySelector('.pagination-href-fn');

  pagination.hrefTemplate = page => `?page=${page}#results`;
</script>
```

**In link mode, the component navigates instead of updating itself.**  
Render it on the server with the correct `page` for each request. Disabled and boundary controls, such as previous on the first page, render as anchors with no `href` and `aria-disabled` set.

### Customizing

Use the exported [CSS parts](#css-parts) to customize the pagination's appearance, where the `button` part targets every button at once. The `plain` appearance is a good starting point.

This example turns the control into a row of pill-shaped buttons, gives the navigation arrows a colorful circular treatment, and highlights the current page with a gradient and a soft glow.

```html
<wa-pagination
  class="custom-pagination"
  total="237"
  page-size="10"
  page="3"
  appearance="plain"
  with-edges
  sibling-count="1"
>
  <wa-icon slot="previous-icon" name="chevron-left"></wa-icon>
  <wa-icon slot="next-icon" name="chevron-right"></wa-icon>
  <wa-icon slot="first-icon" name="angles-left"></wa-icon>
  <wa-icon slot="last-icon" name="angles-right"></wa-icon>
</wa-pagination>

<style>
  .custom-pagination {
    --gradient: linear-gradient(135deg, var(--wa-color-brand-fill-loud), var(--wa-color-indigo-50));
  }

  /* The host uses `display: contents`, so style the `pagination` part to create the container chrome. */
  .custom-pagination::part(pagination) {
    padding: var(--wa-space-xs);
    border-radius: var(--wa-border-radius-pill);
    background-color: var(--wa-color-neutral-fill-quiet);
  }

  .custom-pagination::part(pages) {
    gap: var(--wa-space-2xs);
    flex-wrap: nowrap;
  }

  .custom-pagination::part(button) {
    min-width: 2.5em;
    height: 2.5em;
    border: none;
    border-radius: var(--wa-border-radius-pill);
    font-weight: var(--wa-font-weight-semibold);
    color: var(--wa-color-neutral-on-quiet);
    background-color: transparent;
    transition:
      transform var(--wa-transition-fast),
      color var(--wa-transition-fast),
      background-color var(--wa-transition-fast);
  }

  .custom-pagination::part(button):hover {
    color: var(--wa-color-neutral-on-normal);
    background-color: var(--wa-color-neutral-fill-normal);
    transform: translateY(-2px);
  }

  .custom-pagination::part(previous-button),
  .custom-pagination::part(next-button),
  .custom-pagination::part(first-button),
  .custom-pagination::part(last-button) {
    color: var(--wa-color-neutral-on-quiet);
    background-color: var(--wa-color-neutral-fill-normal);
  }

  /* Keep the nav arrows neutral on hover so they stay calm next to the brand-tinted page numbers. */
  .custom-pagination::part(previous-button):hover,
  .custom-pagination::part(next-button):hover,
  .custom-pagination::part(first-button):hover,
  .custom-pagination::part(last-button):hover {
    color: var(--wa-color-neutral-on-normal);
    background-color: var(--wa-color-neutral-fill-normal);
    filter: brightness(0.95);
  }

  .custom-pagination::part(page-current) {
    color: var(--wa-color-brand-on-loud);
    background-image: var(--gradient);
    transform: none;
  }

  .custom-pagination::part(page-current):hover {
    color: var(--wa-color-brand-on-loud);
    transform: none;
  }

  .custom-pagination::part(ellipsis) {
    color: var(--wa-color-neutral-on-quiet);
    border: none;
    background-color: transparent;
  }
</style>
```
