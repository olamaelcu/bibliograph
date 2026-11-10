# Badge

`<wa-badge>`

Stable [Feedback](https://webawesome.com/docs/components/?category=feedback) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Badges draw attention to adjacent content by displaying a status, count, or label. Use them to highlight notifications, categorize items, or flag new activity.

```html
<wa-badge>New</wa-badge>
```

```html
<wa-badge variant="brand">
  <wa-icon slot="start" name="star"></wa-icon>
  Featured
  <wa-icon slot="end" name="arrow-right"></wa-icon>
</wa-badge>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/badge/badge.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/badge/badge.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/badge/badge.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaBadge from '@awesome.me/webawesome/dist/react/badge/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The badge's content. |
| \`end\` | \`\` An element, such as , placed before the label. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`'accent' \\| 'filled' \\| 'outlined' \\| 'filled-outlined'\` The badge's visual appearance. Type Default 'accent' | |
| \`attention\` attention | \`'none' \\| 'pulse' \\| 'bounce'\` Adds an animation to draw attention to the badge. Type Default 'none' | |
| \`pill\` pill | \`boolean\` Draws a pill-style badge with rounded edges. Type Default false | |
| \`variant\` variant | \`brand\` The badge's theme variant. Defaults to if not within another element with a variant. Type 'brand' \\| 'neutral' \\| 'success' \\| 'warning' \\| 'danger' Default 'brand' | |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--pulse-color\` | \`attention="pulse"\` The color of the badge's pulse effect when using . |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`badge\` | The component's outer wrapper. | \`::part(badge)\` |
| \`end\` | \`end\` The container that wraps the slot. | \`::part(end)\` |
| \`start\` | \`start\` The container that wraps the slot. | \`::part(start)\` |
| \`base\` | \`badge\` Deprecated. Use the part instead. | \`::part(base)\` |

## Examples

### Variant

Set the `variant` attribute to change the badge's variant.

```html
<wa-badge variant="brand">Brand</wa-badge>
<wa-badge variant="success">Success</wa-badge>
<wa-badge variant="neutral">Neutral</wa-badge>
<wa-badge variant="warning">Warning</wa-badge>
<wa-badge variant="danger">Danger</wa-badge>
```

### Appearance

Use the `appearance` attribute to change the badge's visual appearance.

```html
<div style="margin-block-end: 1rem;">
  <wa-badge appearance="accent" variant="neutral">Accent</wa-badge>
  <wa-badge appearance="filled-outlined" variant="neutral">Filled-Outlined</wa-badge>
  <wa-badge appearance="filled" variant="neutral">Filled</wa-badge>
  <wa-badge appearance="outlined" variant="neutral">Outlined</wa-badge>
</div>
<div style="margin-block-end: 1rem;">
  <wa-badge appearance="accent" variant="brand">Accent</wa-badge>
  <wa-badge appearance="filled-outlined" variant="brand">Filled-Outlined</wa-badge>
  <wa-badge appearance="filled" variant="brand">Filled</wa-badge>
  <wa-badge appearance="outlined" variant="brand">Outlined</wa-badge>
</div>
<div style="margin-block-end: 1rem;">
  <wa-badge appearance="accent" variant="success">Accent</wa-badge>
  <wa-badge appearance="filled-outlined" variant="success">Filled-Outlined</wa-badge>
  <wa-badge appearance="filled" variant="success">Filled</wa-badge>
  <wa-badge appearance="outlined" variant="success">Outlined</wa-badge>
</div>
<div style="margin-block-end: 1rem;">
  <wa-badge appearance="accent" variant="warning">Accent</wa-badge>
  <wa-badge appearance="filled-outlined" variant="warning">Filled-Outlined</wa-badge>
  <wa-badge appearance="filled" variant="warning">Filled</wa-badge>
  <wa-badge appearance="outlined" variant="warning">Outlined</wa-badge>
</div>
<div>
  <wa-badge appearance="accent" variant="danger">Accent</wa-badge>
  <wa-badge appearance="filled-outlined" variant="danger">Filled-Outlined</wa-badge>
  <wa-badge appearance="filled" variant="danger">Filled</wa-badge>
  <wa-badge appearance="outlined" variant="danger">Outlined</wa-badge>
</div>
```

### Size

Badges are sized relative to the current font size. You can set `font-size` on any badge (or an ancestor element) to change it.

```html
<wa-badge variant="brand" style="font-size: var(--wa-font-size-xs);">Extra Small</wa-badge>
<wa-badge variant="brand" style="font-size: var(--wa-font-size-s);">Small</wa-badge>
<wa-badge variant="brand" style="font-size: var(--wa-font-size-m);">Medium</wa-badge>
<wa-badge variant="brand" style="font-size: var(--wa-font-size-l);">Large</wa-badge>
<wa-badge variant="brand" style="font-size: var(--wa-font-size-xl);">Extra Large</wa-badge>
```

### Pill

Use the `pill` attribute to give badges rounded edges.

```html
<wa-badge variant="brand" pill>Brand</wa-badge>
<wa-badge variant="success" pill>Success</wa-badge>
<wa-badge variant="neutral" pill>Neutral</wa-badge>
<wa-badge variant="warning" pill>Warning</wa-badge>
<wa-badge variant="danger" pill>Danger</wa-badge>
```

### Drawing Attention

Use the `attention` attribute to draw attention to the badge with a subtle animation. Supported effects are `bounce`, `pulse` and `none`.

```html
<div class="badge-attention">
  <wa-badge variant="brand" attention="pulse" pill>1</wa-badge>
  <wa-badge variant="success" attention="pulse" pill>1</wa-badge>
  <wa-badge variant="neutral" attention="pulse" pill>1</wa-badge>
  <wa-badge variant="warning" attention="pulse" pill>1</wa-badge>
  <wa-badge variant="danger" attention="pulse" pill>1</wa-badge>
</div>

<div class="badge-attention">
  <wa-badge variant="brand" attention="bounce" pill>1</wa-badge>
  <wa-badge variant="success" attention="bounce" pill>1</wa-badge>
  <wa-badge variant="neutral" attention="bounce" pill>1</wa-badge>
  <wa-badge variant="warning" attention="bounce" pill>1</wa-badge>
  <wa-badge variant="danger" attention="bounce" pill>1</wa-badge>
</div>

<style>
  .badge-attention {
    margin-block-end: var(--wa-space-m);

    wa-badge:not(:last-of-type) {
      margin-right: 1rem;
    }
  }
</style>
```

Set the `--pulse-color` custom property to color the pulse independently of the badge's variant.

```html
<wa-badge variant="neutral" attention="pulse" pill style="--pulse-color: var(--wa-color-brand-fill-loud)">1</wa-badge>
```

### Start & End Decorations

Use the `start` and `end` slots to add presentational elements like [`<wa-icon>`](https://webawesome.com/docs/components/icon) alongside the badge's label.

```html
<wa-badge>
  <wa-icon slot="start" name="seedling"></wa-icon>
  Start
</wa-badge>
<wa-badge>
  <wa-icon slot="end" name="tree"></wa-icon>
  End
</wa-badge>
<wa-badge>
  <wa-icon slot="start" name="cow"></wa-icon>
  <wa-icon slot="end" name="meteor"></wa-icon>
  Both
</wa-badge>
```

### With Buttons

One of the most common use cases for badges is attaching them to buttons. To make this easier, badges will be automatically positioned at the top-right when they're a child of a button.

```html
<wa-button appearance="filled">
  Requests
  <wa-badge pill>30</wa-badge>
</wa-button>

<wa-button appearance="filled" style="margin-inline-start: 1rem;">
  Warnings
  <wa-badge variant="warning" pill>8</wa-badge>
</wa-button>

<wa-button appearance="filled" style="margin-inline-start: 1rem;">
  Errors
  <wa-badge variant="danger" pill>6</wa-badge>
</wa-button>
```
