# Details

`<wa-details>`

Stable [Layout](https://webawesome.com/docs/components/?category=layout) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Details display a brief summary and expand to reveal additional content. Use them to progressively disclose information, group related FAQs, or hide advanced options.

```html
<wa-details summary="Toggle Me">
  Click the summary to expand and collapse the details component. You can put any content in here that you want to
  reveal on demand!
</wa-details>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/details/details.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/details/details.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/details/details.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaDetails from '@awesome.me/webawesome/dist/react/details/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The details' main content. |
| \`collapse-icon\` | \`\` Optional expand icon to use instead of the default. Works best with . |
| \`summary\` | \`summary\` The details' . Alternatively, you can use the summary attribute. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`'filled' \\| 'outlined' \\| 'filled-outlined' \\| 'plain'\` The element's visual appearance. Type Default 'outlined' | |
| \`disabled\` disabled | \`boolean\` Disables the details so it can't be toggled. Type Default false | |
| \`iconPlacement\` icon-placement | \`'start' \\| 'end'\` The location of the expand/collapse icon. Type Default 'end' | |
| \`name\` name | \`string\` Groups related details elements. When one opens, others with the same name will close. Type | |
| \`open\` open | \`show()\` Indicates whether or not the details is open. You can toggle this attribute to show and hide the details, or you can use the and hide() methods and this attribute will reflect the details' open state. Type boolean Default false | |
| \`summary\` summary | \`summary\` The to show in the header. If you need to display HTML, use the summary slot instead. Type string | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`hide()\` | Hides the details | |
| \`show()\` | Shows the details. | |

### Events

| Name | Description |
| --- | --- |
| \`wa-after-hide\` | Emitted after the details closes and all animations are complete. |
| \`wa-after-show\` | Emitted after the details opens and all animations are complete. |
| \`wa-hide\` | Emitted when the details closes. |
| \`wa-show\` | Emitted when the details opens. |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--hide-duration\` | \`var(--wa-transition-normal)\` The hide duration to use when applying built-in animation classes. Default |
| \`--show-duration\` | \`var(--wa-transition-normal)\` The show duration to use when applying built-in animation classes. Default |
| \`--spacing\` | The amount of space around and between the details' content. Expects a single value. |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`animating\` | Applied when the details is animating expand/collapse. | \`:state(animating)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`content\` | The details content. | \`::part(content)\` |
| \`details\` | \`display\` The component's outer wrapper. Styles you apply to the component are automatically applied to this part, so you usually don't need to deal with it unless you need to set the property. | \`::part(details)\` |
| \`header\` | The header that wraps both the summary and the expand/collapse icon. | \`::part(header)\` |
| \`icon\` | The container that wraps the expand/collapse icons. | \`::part(icon)\` |
| \`summary\` | The container that wraps the summary. | \`::part(summary)\` |
| \`base\` | \`details\` Deprecated. Use the part instead. | \`::part(base)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)

## Examples

### Expanded Initially

Use the `open` attribute to expand the details initially.

```html
<wa-details summary="Toggle Me" open>
  This details component is expanded by default. Users can click the summary to collapse it if they want to hide the
  content.
</wa-details>
```

### Disabled

Use the `disabled` attribute to prevent the details from expanding.

```html
<wa-details summary="Disabled" disabled>
  This content can't be seen because the details component is disabled. Try removing the disabled attribute to reveal
  what's inside!
</wa-details>
```

### Expand & Collapse Icons

Use the `expand-icon` and `collapse-icon` slots to change the expand and collapse icons, respectively. To disable the animation, override the `rotate` property on the `icon` part as shown below.

```html
<wa-details summary="Toggle Me" class="custom-icons">
  <wa-icon name="square-plus" slot="expand-icon" variant="regular"></wa-icon>
  <wa-icon name="square-minus" slot="collapse-icon" variant="regular"></wa-icon>

  This example uses custom plus and minus icons for expanding and collapsing. You can use any icon you want to match the
  look and feel of your app.
</wa-details>

<style>
  /* Disable the expand/collapse animation */
  wa-details.custom-icons::part(icon) {
    rotate: none;
  }
</style>
```

### Icon Placement

The default position for the expand and collapse icons is at the end of the summary. Set the `icon-placement` attribute to `start` to place the icon at the start of the summary.

```html
<div class="wa-stack">
  <wa-details summary="Start" icon-placement="start">
    The expand/collapse icon is at the start of the summary. This is a common pattern that feels familiar to users who
    are used to tree views and file explorers.
  </wa-details>
  <wa-details summary="End" icon-placement="end">
    The expand/collapse icon is at the end of the summary. This is the default placement and works great for most use
    cases.
  </wa-details>
</div>
```

### HTML in Summary

To use HTML in the summary, use the `summary` slot. Links and other interactive elements will still retain their behavior:

```html
<wa-details>
  <span slot="summary">
    Some text
    <a href="https://webawesome.com" target="_blank">a link</a>
    more text
  </span>

  You can use the summary slot to put HTML in the summary, including links and other interactive elements. Pretty neat,
  right?
</wa-details>
```

### Right-to-Left Languages

The details component, including its `icon-placement`, automatically adapts to right-to-left languages:

```html
<div class="wa-stack">
  <wa-details summary="تبديلني" lang="ar" dir="rtl">
    استخدام طريقة لوريم إيبسوم لأنها تعطي توزيعاَ طبيعياَ -إلى حد ما- للأحرف عوضاً عن
  </wa-details>
  <wa-details summary="تبديلني" lang="ar" dir="rtl" icon-placement="start">
    استخدام طريقة لوريم إيبسوم لأنها تعطي توزيعاَ طبيعياَ -إلى حد ما- للأحرف عوضاً عن
  </wa-details>
</div>
```

### Appearance

Use the `appearance` attribute to change the element’s visual appearance.

```html
<div class="wa-stack">
  <wa-details summary="Outlined (default)">
    This is the default outlined appearance. It has a subtle border that helps it stand out without being too flashy.
  </wa-details>
  <wa-details summary="Filled-outlined" appearance="filled-outlined">
    The filled-outlined appearance combines a filled header with an outlined body. It gives the summary a bit more
    visual weight while keeping the content area clean.
  </wa-details>
  <wa-details summary="Filled" appearance="filled">
    The filled appearance adds a background color to the entire component. Use this when you want the details to really
    pop on the page.
  </wa-details>
  <wa-details summary="Plain" appearance="plain">
    No bells and whistles on this one. The plain appearance strips away borders and backgrounds for a minimalist look.
  </wa-details>
</div>
```

### Grouping Details

Use the `name` attribute to create accordion-like behavior where only one details element with the same name can be open at a time. This matches the behavior of native `<details>` elements.

```html
<div class="wa-stack">
  <wa-details name="group-1" summary="Section 1" open>
    This is the first section of the accordion. When you open another section, this one will close automatically. Give
    it a try!
  </wa-details>

  <wa-details name="group-1" summary="Section 2">
    This is the second section. Notice how the first section closed when you opened this one? That's the accordion
    behavior in action, powered by the shared name attribute.
  </wa-details>

  <wa-details name="group-1" summary="Section 3">
    And here's the third section. You can have as many sections as you need — just make sure they all share the same
    name and only one will be open at a time.
  </wa-details>
</div>
```
