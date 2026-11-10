# Tooltip

`<wa-tooltip>`

Stable [Feedback](https://webawesome.com/docs/components/?category=feedback) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Tooltips display brief contextual information when the user hovers, focuses, or taps a target element.

```html
<wa-tooltip for="my-button">This is a tooltip</wa-tooltip>
<wa-button appearance="filled" id="my-button">Hover Me</wa-button>
```

Point the `for` attribute at the `id` of the element the tooltip describes, and Web Awesome wires up positioning and accessibility for you.

**Keep tooltips to text and presentational content.**  
Tooltips can't be reliably focused or operated with a keyboard, so avoid buttons, links, and form controls inside one. Reach for a [popover](https://webawesome.com/docs/components/popover) or [dropdown](https://webawesome.com/docs/components/dropdown) when you need interactive content.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/tooltip/tooltip.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/tooltip/tooltip.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaTooltip from '@awesome.me/webawesome/dist/react/tooltip/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The tooltip's default slot where any content should live. Interactive content should be avoided. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`disabled\` disabled | \`boolean\` Disables the tooltip so it won't show when triggered. Type Default false | |
| \`distance\` distance | \`number\` The distance in pixels from which to offset the tooltip away from its target. Type Default 8 | |
| \`hideDelay\` hide-delay | \`number\` The amount of time to wait before hiding the tooltip when the user mouses out. Type Default 0 | |
| \`open\` open | \`boolean\` Indicates whether or not the tooltip is open. You can use this in lieu of the show/hide methods. Type Default false | |
| \`placement\` placement | \`'top' \\| 'top-start' \\| 'top-end' \\| 'right' \\| 'right-start' \\| 'right-end' \\| 'bottom' \\| 'bottom-start' \\| 'bottom-end' \\| 'left' \\| 'left-start' \\| 'left-end'\` The preferred placement of the tooltip. Note that the actual placement may vary as needed to keep the tooltip inside of the viewport. Type Default 'top' | |
| \`showDelay\` show-delay | \`number\` The amount of time to wait before showing the tooltip when the user mouses in. Type Default 150 | |
| \`skidding\` skidding | \`number\` The distance in pixels from which to offset the tooltip along its target. Type Default 0 | |
| \`trigger\` trigger | \`click\` Controls how the tooltip is activated. Possible options include , hover, focus, and manual. Multiple options can be passed by separating them with a space. When manual is used, the tooltip must be activated programmatically. Type string Default 'hover focus' | |
| \`withoutArrow\` without-arrow | \`boolean\` Removes the arrow from the tooltip. Type Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`hide()\` | Hides the tooltip | |
| \`show()\` | Shows the tooltip. | |

### Events

| Name | Description |
| --- | --- |
| \`wa-after-hide\` | Emitted after the tooltip has hidden and all animations are complete. |
| \`wa-after-show\` | Emitted after the tooltip has shown and all animations are complete. |
| \`wa-hide\` | Emitted when the tooltip begins to hide. |
| \`wa-show\` | Emitted when the tooltip begins to show. |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--max-width\` | The maximum width of the tooltip before its content will wrap. |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`base\_\_arrow\` | \`arrow\` The popup's exported part. Use this to target the tooltip's arrow. | \`::part(base\_\_arrow)\` |
| \`base\_\_popup\` | \`popup\` The 's exported popup part. Use this to target the tooltip's popup container. | \`::part(base\_\_popup)\` |
| \`body\` | The tooltip's body where its content is rendered. | \`::part(body)\` |
| \`tooltip\` | The component's outer wrapper. | \`::part(tooltip)\` |
| \`base\` | \`tooltip\` Deprecated. Use the part instead. | \`::part(base)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-popup>`](https://webawesome.com/docs/components/popup)

## Examples

### Placement

Use the `placement` attribute to set the tooltip's preferred position. The actual placement may shift to keep the tooltip inside the viewport.

```html
<div class="tooltip-placement-example">
  <div class="tooltip-placement-example-row">
    <wa-button appearance="filled" id="tooltip-top-start"></wa-button>
    <wa-button appearance="filled" id="tooltip-top"></wa-button>
    <wa-button appearance="filled" id="tooltip-top-end"></wa-button>
  </div>

  <div class="tooltip-placement-example-row">
    <wa-button appearance="filled" id="tooltip-left-start"></wa-button>
    <wa-button appearance="filled" id="tooltip-right-start"></wa-button>
  </div>

  <div class="tooltip-placement-example-row">
    <wa-button appearance="filled" id="tooltip-left"></wa-button>
    <wa-button appearance="filled" id="tooltip-right"></wa-button>
  </div>

  <div class="tooltip-placement-example-row">
    <wa-button appearance="filled" id="tooltip-left-end"></wa-button>
    <wa-button appearance="filled" id="tooltip-right-end"></wa-button>
  </div>

  <div class="tooltip-placement-example-row">
    <wa-button appearance="filled" id="tooltip-bottom-start"></wa-button>
    <wa-button appearance="filled" id="tooltip-bottom"></wa-button>
    <wa-button appearance="filled" id="tooltip-bottom-end"></wa-button>
  </div>
</div>

<wa-tooltip for="tooltip-top-start" placement="top-start">top-start</wa-tooltip>
<wa-tooltip for="tooltip-top" placement="top">top</wa-tooltip>
<wa-tooltip for="tooltip-top-end" placement="top-end">top-end</wa-tooltip>
<wa-tooltip for="tooltip-left-start" placement="left-start">left-start</wa-tooltip>
<wa-tooltip for="tooltip-right-start" placement="right-start">right-start</wa-tooltip>
<wa-tooltip for="tooltip-left" placement="left">left</wa-tooltip>
<wa-tooltip for="tooltip-right" placement="right">right</wa-tooltip>
<wa-tooltip for="tooltip-left-end" placement="left-end">left-end</wa-tooltip>
<wa-tooltip for="tooltip-right-end" placement="right-end">right-end</wa-tooltip>
<wa-tooltip for="tooltip-bottom-start" placement="bottom-start">bottom-start</wa-tooltip>
<wa-tooltip for="tooltip-bottom" placement="bottom">bottom</wa-tooltip>
<wa-tooltip for="tooltip-bottom-end" placement="bottom-end">bottom-end</wa-tooltip>

<style>
  .tooltip-placement-example {
    width: 250px;
    margin: 1rem;
  }

  .tooltip-placement-example wa-button {
    width: 2.5rem;
  }

  .tooltip-placement-example-row {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .tooltip-placement-example-row:nth-child(1),
  .tooltip-placement-example-row:nth-child(5) {
    justify-content: center;
  }
</style>
```

### Triggers

The `trigger` attribute controls how a tooltip is activated. Pass multiple values separated by a space to combine them — the default is `hover focus`, which shows the tooltip on pointer hover and keyboard focus.

| Value | Shows the tooltip when |
| --- | --- |
| \`hover\` | The pointer moves over the target |
| \`focus\` | The target receives keyboard focus |
| \`click\` | The target is clicked; clicking again dismisses it |
| \`manual\` | \`open\` Only when you set yourself — no built-in activation |

Open tooltips light dismiss, which means pressing the target, clicking the tooltip, or clicking anywhere else on the page hides them. Pressing Escape will also hide them. Tooltips with `trigger="manual"` never light dismiss, and calling `preventDefault()` on the `wa-hide` event will keep the tooltip open.

```html
<wa-button appearance="filled" id="toggle-button">Click to Toggle</wa-button>
<wa-tooltip for="toggle-button" trigger="click">Click again to dismiss</wa-tooltip>
```

### HTML in Tooltips

Use the default slot to add presentational HTML, such as emphasis or line breaks.

```html
<wa-button appearance="filled" id="rich-tooltip">Hover me</wa-button>
<wa-tooltip for="rich-tooltip">
  <div>This tooltip includes <strong>formatted</strong> content, such as <em>emphasis</em> and line breaks.</div>
</wa-tooltip>
```

### Customizing

Use the `--max-width` custom property to set the width at which the tooltip's content wraps.

```html
<wa-tooltip for="wrapping-tooltip" style="--max-width: 80px;">
  This tooltip will wrap after only 80 pixels.
</wa-tooltip>
<wa-button appearance="filled" id="wrapping-tooltip">Hover me</wa-button>
```

Remove the arrow on a single tooltip with the `without-arrow` attribute.

```html
<wa-button appearance="filled" id="no-arrow">No Arrow</wa-button>
<wa-tooltip for="no-arrow" without-arrow>This is a tooltip with no arrow</wa-tooltip>
```

Resize the arrow on every tooltip with the `--wa-tooltip-arrow-size` design token. Set it in a `:root` block after the Web Awesome stylesheet loads — `0` removes arrows globally.

```css
:root {
  --wa-tooltip-arrow-size: 0;
}
```

### Showing & Hiding Manually

Set `trigger="manual"` and toggle the `open` attribute to control the tooltip yourself — handy for onboarding hints or surfacing a tooltip in response to your own logic.

```html
<div class="manual-trigger-example">
  <wa-tooltip for="manual-trigger-tooltip" trigger="manual" class="manual-tooltip">This is an avatar!</wa-tooltip>
  <wa-avatar id="manual-trigger-tooltip" label="User"></wa-avatar>

  <wa-divider></wa-divider>

  <wa-button appearance="filled" class="manual-toggle">Toggle Manually</wa-button>
</div>

<script>
  const tooltip = document.querySelector('.manual-tooltip');
  const toggle = document.querySelector('.manual-toggle');

  toggle.addEventListener('click', () => (tooltip.open = !tooltip.open));
</script>
```
