# Toast Item

`<wa-toast-item>`

Stable [Feedback](https://webawesome.com/docs/components/?category=feedback) [Since 3.3](https://webawesome.com/docs/resources/changelog#wa_330)

Toast items are individual notifications displayed within a toast container.

```html
<wa-toast-item variant="brand" duration="0">
  <wa-icon slot="icon" name="bell"></wa-icon>
  This is how a toast item looks!
</wa-toast-item>
```

**Now Available in Web Awesome Core**  
Toast Item moved over from Pro in [**3.11.0**](https://webawesome.com/docs/resources/changelog#unreleased). On an earlier Core version? Upgrade to use it.

**Toast items are meant to live inside a [`<wa-toast>`](https://webawesome.com/docs/components/toast) container.**  
The container manages their lifecycle and positioning. For usage examples showing how to display notifications, see the [Toast documentation](https://webawesome.com/docs/components/toast).

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/toast-item/toast-item.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/toast-item/toast-item.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/toast-item/toast-item.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaToastItem from '@awesome.me/webawesome/dist/react/toast-item/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The toast item's message content. |
| \`icon\` | An optional icon to show at the start of the toast item. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`duration\` duration | \`number\` The length of time in milliseconds before the toast item is automatically dismissed. Set to 0 to keep the toast item open until the user dismisses it. Type Default 5000 | |
| \`size\` size | \`'xs' \\| 's' \\| 'm' \\| 'l' \\| 'xl' \\| 'small' \\| 'medium' \\| 'large'\` The toast item's size. Type Default 'm' | |
| \`variant\` variant | \`'brand' \\| 'success' \\| 'warning' \\| 'danger' \\| 'neutral'\` The toast item's variant. Type Default 'neutral' | |
| \`withIcon\` with-icon | \`true\` Only required for SSR. Set to if you're slotting in an icon element so the server-rendered markup includes the icon before the component hydrates on the client. Type boolean Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`hide()\` | Hides the toast item with animation and removes it from the DOM. | |

### Events

| Name | Description |
| --- | --- |
| \`wa-after-hide\` | Emitted after the toast item has finished hiding. |
| \`wa-after-show\` | Emitted after the toast item has finished showing. |
| \`wa-hide\` | Emitted when the toast item begins to hide. |
| \`wa-show\` | Emitted when the toast item begins to show. |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--accent-width\` | The width of the accent line. Defaults to 4px. |
| \`--hide-duration\` | \`var(--wa-transition-normal)\` The animation duration when hiding. Default |
| \`--padding\` | \`size\` The internal spacing of the toast item. Scales with the attribute. |
| \`--show-duration\` | \`var(--wa-transition-normal)\` The animation duration when showing. Default |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`accent\` | The colored accent line on the start side. | \`::part(accent)\` |
| \`close-button\` | The close button element. | \`::part(close-button)\` |
| \`close-icon\` | The close icon element. | \`::part(close-icon)\` |
| \`close-icon\_\_svg\` | The close icon's exported svg part. | \`::part(close-icon\_\_svg)\` |
| \`content\` | The message content container. | \`::part(content)\` |
| \`icon\` | The icon container. | \`::part(icon)\` |
| \`progress-ring\` | The progress ring component. | \`::part(progress-ring)\` |
| \`progress-ring\_\_base\` | The progress ring's exported base part. | \`::part(progress-ring\_\_base)\` |
| \`progress-ring\_\_indicator\` | The progress ring's exported indicator part. | \`::part(progress-ring\_\_indicator)\` |
| \`progress-ring\_\_label\` | The progress ring's exported label part. | \`::part(progress-ring\_\_label)\` |
| \`progress-ring\_\_track\` | The progress ring's exported track part. | \`::part(progress-ring\_\_track)\` |
| \`toast-item\` | The toast item's main container. | \`::part(toast-item)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)
-   [`<wa-progress-ring>`](https://webawesome.com/docs/components/progress-ring)

## Examples

### Variant

Use the `variant` attribute to change the toast item's visual style. The variant determines the accent color on the left side and the icon color. Available variants are `neutral` (default), `brand`, `success`, `warning`, and `danger`.

```html
<div class="wa-stack">
  <wa-toast-item variant="neutral" duration="0">
    <wa-icon slot="icon" name="gear"></wa-icon>
    Neutral variant (default)
  </wa-toast-item>

  <wa-toast-item variant="brand" duration="0">
    <wa-icon slot="icon" name="circle-info"></wa-icon>
    Brand variant
  </wa-toast-item>

  <wa-toast-item variant="success" duration="0">
    <wa-icon slot="icon" name="check"></wa-icon>
    Success variant
  </wa-toast-item>

  <wa-toast-item variant="warning" duration="0">
    <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
    Warning variant
  </wa-toast-item>

  <wa-toast-item variant="danger" duration="0">
    <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
    Danger variant
  </wa-toast-item>
</div>
```

### Size

Use the `size` attribute to change the toast item's size.

```html
<div class="wa-stack">
  <wa-toast-item size="xs" duration="0">
    <wa-icon slot="icon" name="shrimp"></wa-icon>
    Extra Small
  </wa-toast-item>

  <wa-toast-item size="s" duration="0">
    <wa-icon slot="icon" name="mouse-field"></wa-icon>
    Small
  </wa-toast-item>

  <wa-toast-item size="m" duration="0">
    <wa-icon slot="icon" name="horse"></wa-icon>
    Medium (default)
  </wa-toast-item>

  <wa-toast-item size="l" duration="0">
    <wa-icon slot="icon" name="elephant"></wa-icon>
    Large
  </wa-toast-item>

  <wa-toast-item size="xl" duration="0">
    <wa-icon slot="icon" name="whale"></wa-icon>
    Extra Large
  </wa-toast-item>
</div>
```

### Icons

Use the `icon` slot to display an icon at the start of the toast item. The icon color automatically matches the variant's accent color.

```html
<div class="wa-stack">
  <wa-toast-item variant="success" duration="0">
    <wa-icon slot="icon" name="check"></wa-icon>
    Your changes have been saved!
  </wa-toast-item>

  <wa-toast-item variant="brand" duration="0">
    <wa-icon slot="icon" name="envelope"></wa-icon>
    You have 3 new messages
  </wa-toast-item>

  <wa-toast-item variant="warning" duration="0">
    <wa-icon slot="icon" name="clock"></wa-icon>
    Your session will expire soon
  </wa-toast-item>
</div>
```

Toast items work fine without icons too.

```html
<wa-toast-item variant="neutral" duration="0"> A simple notification without an icon. </wa-toast-item>
```

### Providing Content

The default slot accepts any HTML content, allowing you to create rich notifications with formatted text, links, and interactive elements.

```html
<div class="wa-stack">
  <wa-toast-item variant="brand" duration="0">
    <wa-icon slot="icon" name="bell"></wa-icon>
    <strong>New message from Alex</strong><br />
    Hey, are you available for a quick call?
  </wa-toast-item>

  <wa-toast-item variant="success" duration="0">
    <wa-icon slot="icon" name="cloud-arrow-up"></wa-icon>
    <strong>Upload complete</strong><br />
    <a href="#">View file</a> · <a href="#">Share</a>
  </wa-toast-item>

  <wa-toast-item variant="brand" duration="0">
    <wa-icon slot="icon" name="gift"></wa-icon>
    You've earned a reward!
    <div style="margin-block-start: var(--wa-space-xs);">
      <wa-button variant="brand" size="s">Claim Now</wa-button>
      <wa-button appearance="filled" size="s">Later</wa-button>
    </div>
  </wa-toast-item>
</div>
```

### Duration

The `duration` attribute controls how long the toast item displays before automatically dismissing (in milliseconds). The default is `5000` (5 seconds). Set to `0` to disable auto-dismissal.

When a duration is set, a progress ring appears around the close button showing the remaining time.

```html
<wa-toast-item variant="brand" duration="5000">...</wa-toast-item>
<wa-toast-item variant="brand" duration="10000">...</wa-toast-item>
<wa-toast-item variant="brand" duration="0">...</wa-toast-item>
```

### Hover & Focus Behavior

Toast items automatically pause their countdown timer when the user hovers over them or when the close button receives focus, giving more time to read the content. When the mouse leaves or focus moves away, the timer resets and begins counting down again.

### The Close Button

Every toast item includes a close button that allows users to dismiss the notification. When `duration` is greater than `0`, the close button displays a progress ring showing the remaining time.

```html
<wa-toast-item variant="neutral" duration="0">
  <wa-icon slot="icon" name="circle-info"></wa-icon>
  Click the close button on the right to dismiss →
</wa-toast-item>
```

### Customizing the Accent

Use the `--accent-width` custom property to adjust the width of the accent line, or hide it entirely.

```html
<div class="wa-stack">
  <wa-toast-item variant="brand" duration="0" style="--accent-width: 8px;">
    <wa-icon slot="icon" name="star"></wa-icon>
    Thicker accent line
  </wa-toast-item>

  <wa-toast-item variant="success" duration="0" style="--accent-width: 0;">
    <wa-icon slot="icon" name="check"></wa-icon>
    No accent line
  </wa-toast-item>
</div>
```

### Customizing the Padding

Use the `--padding` custom property to adjust the internal spacing.

```html
<div class="wa-stack">
  <wa-toast-item variant="brand" duration="0" style="--padding: var(--wa-space-xs);">
    <wa-icon slot="icon" name="compress"></wa-icon>
    Compact padding
  </wa-toast-item>

  <wa-toast-item variant="brand" duration="0" style="--padding: var(--wa-space-xl);">
    <wa-icon slot="icon" name="expand"></wa-icon>
    Spacious padding
  </wa-toast-item>
</div>
```
