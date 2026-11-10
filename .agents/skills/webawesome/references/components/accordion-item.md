# Accordion Item

`<wa-accordion-item>`

Experimental [Layout](https://webawesome.com/docs/components/?category=layout) [Since 3.8](https://webawesome.com/docs/resources/changelog#wa_380)

Accordion items are used inside [`<wa-accordion>`](https://webawesome.com/docs/components/accordion) to create expandable sections with accessible headers.

This component must be used as a child of [`<wa-accordion>`](https://webawesome.com/docs/components/accordion). Please see the [Accordion docs](https://webawesome.com/docs/components/accordion) to see examples of this component in action.

```html
<wa-accordion>
  <wa-accordion-item label="Overview">The first section.</wa-accordion-item>
  <wa-accordion-item expanded data-anatomy-subject="true">
    <span slot="label">Shipping &amp; returns</span>
    Orders ship within two business days. Returns are free within 30 days.
  </wa-accordion-item>
  <wa-accordion-item label="Warranty">The third section.</wa-accordion-item>
</wa-accordion>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/accordion-item/accordion-item.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/accordion-item/accordion-item.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/accordion-item/accordion-item.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaAccordionItem from '@awesome.me/webawesome/dist/react/accordion-item/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The accordion item's body content. |
| \`icon\` | \`

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`disabled\` disabled | \`boolean\` Disables the accordion item so it can't be toggled. Type Default false | |
| \`expanded\` expanded | \`boolean\` Expands the accordion item. Type Default false | |
| \`label\` label | \`label\` The text shown in the header. If you need HTML, use the label slot instead. Type string Default '' | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`collapse()\` | Collapses the accordion item with animation. | |
| \`expand()\` | Expands the accordion item with animation. | |
| \`focus()\` | Focuses the accordion item's trigger button. | \`options: FocusOptions\` |
| \`toggle()\` | Toggles the accordion item's expanded state. | |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--easing\` | \`var(--wa-transition-easing)\` The easing of the expand/collapse animation. Default |
| \`--hide-duration\` | \`var(--wa-transition-normal)\` The duration of the collapse animation. Default |
| \`--show-duration\` | \`var(--wa-transition-normal)\` The duration of the expand animation. Default |
| \`--spacing\` | \`var(--wa-space-m)\` The amount of space around and between the item's header and content. Default |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`animating\` | Applied while the panel is animating. | \`:state(animating)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`accordion-item\` | The component's outer wrapper. | \`::part(accordion-item)\` |
| \`button\` | The trigger button that toggles the panel. | \`::part(button)\` |
| \`content\` | The content slot inside the panel. | \`::part(content)\` |
| \`heading\` | \`heading-level="none"\` The heading element wrapping the trigger button. Omitted when . | \`::part(heading)\` |
| \`icon\` | The container that wraps the expand/collapse icon. | \`::part(icon)\` |
| \`label\` | The container that wraps the label. | \`::part(label)\` |
| \`panel\` | The panel that contains the item's content. | \`::part(panel)\` |
| \`base\` | \`accordion-item\` Deprecated. Use the part instead. | \`::part(base)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)