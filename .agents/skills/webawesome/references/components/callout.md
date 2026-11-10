# Callout

`<wa-callout>`

Stable [Feedback](https://webawesome.com/docs/components/?category=feedback) [Since 3.0](https://webawesome.com/docs/resources/changelog#wa_300)

Callouts display important messages inline with surrounding content. Use them to highlight tips, warnings, errors, or other information users should not miss.

```html
<wa-callout>
  <wa-icon slot="icon" name="circle-info"></wa-icon>
  This is a standard callout. You can customize its content and even the icon.
</wa-callout>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/callout/callout.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/callout/callout.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/callout/callout.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaCallout from '@awesome.me/webawesome/dist/react/callout/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The callout's main content. |
| \`icon\` | \`

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`'accent' \\| 'filled' \\| 'outlined' \\| 'plain' \\| 'filled-outlined'\` The callout's visual appearance. Type | |
| \`size\` size | \`'xs' \\| 's' \\| 'm' \\| 'l' \\| 'xl' \\| 'small' \\| 'medium' \\| 'large'\` The callout's size. Type Default 'm' | |
| \`variant\` variant | \`brand\` The callout's theme variant. Defaults to if not within another element with a variant. Type 'brand' \\| 'neutral' \\| 'success' \\| 'warning' \\| 'danger' Default 'brand' | |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`icon\` | The container that wraps the optional icon. | \`::part(icon)\` |
| \`message\` | The container that wraps the callout's main content. | \`::part(message)\` |

## Examples

### Variant

Set the `variant` attribute to match the callout to its message.

```html
<div class="wa-stack">
  <wa-callout variant="brand">
    <wa-icon slot="icon" name="circle-info"></wa-icon>
    <strong>A new theme is available</strong><br />
    Try it from Settings whenever you're ready.
  </wa-callout>

  <wa-callout variant="success">
    <wa-icon slot="icon" name="circle-check"></wa-icon>
    <strong>Your changes have been saved</strong><br />
    You can safely close this tab now.
  </wa-callout>

  <wa-callout variant="neutral">
    <wa-icon slot="icon" name="gear"></wa-icon>
    <strong>Your settings have been updated</strong><br />
    Changes take effect on your next login.
  </wa-callout>

  <wa-callout variant="warning">
    <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
    <strong>Your session is about to expire</strong><br />
    Save your work to avoid losing it.
  </wa-callout>

  <wa-callout variant="danger">
    <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
    <strong>This action can't be undone</strong><br />
    Deleting a project removes it for everyone on the team.
  </wa-callout>
</div>
```

### Appearance

Use the `appearance` attribute to change the callout's visual style. With no `appearance` set, a callout renders with a quiet fill and border, matching `filled-outlined`.

```html
<div class="wa-stack">
  <wa-callout variant="brand" appearance="accent">
    <wa-icon slot="icon" name="square-check"></wa-icon>
    This <strong>accent</strong> callout draws the most attention.
  </wa-callout>

  <wa-callout variant="brand" appearance="filled-outlined">
    <wa-icon slot="icon" name="fill-drip"></wa-icon>
    This callout is both <strong>filled</strong> and <strong>outlined</strong>.
  </wa-callout>

  <wa-callout variant="brand" appearance="filled">
    <wa-icon slot="icon" name="fill"></wa-icon>
    This callout is only <strong>filled</strong>.
  </wa-callout>

  <wa-callout variant="brand" appearance="outlined">
    <wa-icon slot="icon" name="lines-leaning"></wa-icon>
    Here's an <strong>outlined</strong> callout.
  </wa-callout>

  <wa-callout variant="brand" appearance="plain">
    <wa-icon slot="icon" name="font"></wa-icon>
    No fill or border on this <strong>plain</strong> callout.
  </wa-callout>
</div>
```

### Size

Use the `size` attribute to change a callout's size.

```html
<div class="wa-stack">
  <wa-callout size="xs">
    <wa-icon slot="icon" name="circle-info"></wa-icon>
    Extra-small callout for minimal emphasis.
  </wa-callout>

  <wa-callout size="s">
    <wa-icon slot="icon" name="circle-info"></wa-icon>
    Small callout for a bit of emphasis.
  </wa-callout>

  <wa-callout size="m">
    <wa-icon slot="icon" name="circle-info"></wa-icon>
    Medium callout, the default size.
  </wa-callout>

  <wa-callout size="l">
    <wa-icon slot="icon" name="circle-info"></wa-icon>
    Large callout for more emphasis.
  </wa-callout>

  <wa-callout size="xl">
    <wa-icon slot="icon" name="circle-info"></wa-icon>
    Extra-large callout for maximum emphasis.
  </wa-callout>
</div>
```

### Without an Icon

Icons are optional. Omit the `icon` slot for a text-only callout.

```html
<wa-callout variant="brand">All times are shown in your local timezone.</wa-callout>
```

### Customizing

Style a callout with regular CSS — `background`, `border`, `border-radius`, `color`, `padding`, and `margin` all work as expected.

```html
<wa-callout
  variant="brand"
  style="
    background: var(--wa-color-brand-fill-quiet);
    border-radius: var(--wa-border-radius-pill);
    border-style: dashed;
  "
>
  <wa-icon slot="icon" name="wand-magic-sparkles"></wa-icon>
  A pinch of CSS goes a long way.
</wa-callout>
```
