# Copy Button

`<wa-copy-button>`

Stable [Actions](https://webawesome.com/docs/components/?category=actions) [Since 3.6](https://webawesome.com/docs/resources/changelog#wa_360)

Copy buttons copy text to the clipboard when the user activates them. They provide built-in success and error feedback so users know the copy worked.

```html
<wa-copy-button value="https://webawesome.com"></wa-copy-button>
```

**Copying requires a secure context.**  
Copy buttons use the browser's [`clipboard.writeText()`](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText) method, which requires a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (HTTPS) in most browsers.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/copy-button/copy-button.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/copy-button/copy-button.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/copy-button/copy-button.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaCopyButton from '@awesome.me/webawesome/dist/react/copy-button/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | \`\` The trigger element. By default, a copy icon button is rendered so this is optional. If desired, you can slot in a custom element such as or . |
| \`copy-icon\` | \`\` The icon to show in the default copy state. Works best with . |
| \`error-icon\` | \`\` The icon to show when the content is copied. Works best with . |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`copyLabel\` copy-label | \`string\` A custom label to use as the accessible name and tooltip text in the default copy state. Type Default '' | |
| \`disabled\` disabled | \`boolean\` Disables the copy button. Type Default false | |
| \`errorLabel\` error-label | \`string\` A custom label to show in the tooltip when a copy error occurs. Type Default '' | |
| \`feedbackDuration\` feedback-duration | \`number\` The length of time to show feedback before restoring the default trigger. Type Default 1000 | |
| \`from\` from | \`value\` An id that references an element in the same document from which data will be copied. If both this and are present, this value will take precedence. By default, the target element's textContent will be copied. To copy an attribute, append the attribute name wrapped in square brackets, e.g. from="el\[value\]". To copy a property, append a dot and the property name, e.g. from="el.value". Type string Default '' | |
| \`successLabel\` success-label | \`string\` A custom label to show in the tooltip after copying. Type Default '' | |
| \`tooltip\` tooltip | \`full\` Controls the built-in tooltip. (default) shows the tooltip on hover and focus and during copy feedback. copy keeps the tooltip silent on hover/focus and only shows it briefly to confirm a successful or failed copy. none disables the tooltip entirely. Applies to both the default and custom triggers. Type 'full' \\| 'copy' \\| 'none' Default 'full' | |
| \`tooltipPlacement\` tooltip-placement | \`'top' \\| 'right' \\| 'bottom' \\| 'left'\` The preferred placement of the tooltip. Type Default 'top' | |
| \`value\` value | \`string\` The text value to copy. Type Default '' | |

### Events

| Name | Description |
| --- | --- |
| \`wa-copy\` | Emitted when the data has been copied. |
| \`wa-error\` | Emitted when the data could not be copied. |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`error\` | Applied when the copy operation fails. | \`:state(error)\` |
| \`success\` | Applied when the copy operation succeeds. | \`:state(success)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`button\` | \`\` The internal element. | \`::part(button)\` |
| \`copy-icon\` | The container that holds the copy icon. | \`::part(copy-icon)\` |
| \`error-icon\` | The container that holds the error icon. | \`::part(error-icon)\` |
| \`feedback\` | \`\` The internal element. | \`::part(feedback)\` |
| \`success-icon\` | The container that holds the success icon. | \`::part(success-icon)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)
-   [`<wa-popup>`](https://webawesome.com/docs/components/popup)
-   [`<wa-tooltip>`](https://webawesome.com/docs/components/tooltip)

## Examples

### Copying from Other Elements

Set the `value` attribute to copy a literal string, or point the `from` attribute at another element's `id` to copy live content. When both are present, `from` wins.

By default `from` copies the target's [`textContent`](https://developer.mozilla.org/en-US/docs/Web/API/Node/textContent). Add a modifier to copy an attribute or property instead:

| Syntax | Copies | Example |
| --- | --- | --- |
| \`from="id"\` | \`textContent\` The element's | \`from="my-phone"\` |
| \`from="id\[attr\]"\` | The named attribute | \`from="my-link\[href\]"\` |
| \`from="id.prop"\` | The named property | \`from="my-input.value"\` |

```html
<div class="wa-stack">
  <!-- Copies the span's textContent -->
  <div class="wa-cluster wa-align-items-center wa-gap-2xs">
    <span id="my-phone">+1 (234) 456-7890</span>
    <wa-copy-button from="my-phone"></wa-copy-button>
  </div>

  <!-- Copies the input's "value" property -->
  <div class="wa-cluster wa-align-items-center wa-gap-2xs">
    <wa-input id="my-input" type="text" value="User input" style="max-width: 300px;"></wa-input>
    <wa-copy-button from="my-input.value"></wa-copy-button>
  </div>

  <!-- Copies the link's "href" attribute -->
  <div class="wa-cluster wa-align-items-center wa-gap-2xs">
    <a id="my-link" href="https://webawesome.com/">Web Awesome Website</a>
    <wa-copy-button from="my-link[href]"></wa-copy-button>
  </div>
</div>
```

### Custom Labels

The copy button shows a tooltip on hover and focus, then briefly swaps it to confirm a copy. Set the `copy-label`, `success-label`, and `error-label` attributes to customize the text for each state. `copy-label` also serves as the button's accessible name.

```html
<wa-copy-button
  value="Custom labels are easy"
  copy-label="Click to copy"
  success-label="You did it!"
  error-label="Whoops, your browser doesn't support this!"
></wa-copy-button>
```

### Custom Icons

Use the `copy-icon`, `success-icon`, and `error-icon` slots to replace the icon shown in each state. [`<wa-icon>`](https://webawesome.com/docs/components/icon) works best, but any image will do.

```html
<wa-copy-button value="Copied from a custom button">
  <wa-icon slot="copy-icon" name="clipboard" variant="regular"></wa-icon>
  <wa-icon slot="success-icon" name="thumbs-up" variant="solid"></wa-icon>
  <wa-icon slot="error-icon" name="xmark" variant="solid"></wa-icon>
</wa-copy-button>
```

### Custom Trigger

By default the copy button renders an icon-only button. Slot in any clickable element to use as the trigger instead — a Web Awesome button, a native button, or anything else.

```html
<div class="wa-stack">
  <wa-copy-button value="You can copy anything with a custom trigger!">
    <wa-button appearance="filled">Copy to Clipboard</wa-button>
  </wa-copy-button>

  <wa-copy-button value="https://webawesome.com">
    <button type="button" class="wa-filled">Copy to Clipboard</button>
  </wa-copy-button>
</div>
```

**Custom triggers get the same feedback with no extra wiring.**  
They receive the same tooltip and copy feedback as the default trigger; the icon swap is the one piece unique to it. Set `tooltip="none"` to opt out of the tooltip, and listen for the `wa-copy` and `wa-error` events or style the `:state(success)` and `:state(error)` custom states for your own feedback.

### Disabled

Add the `disabled` attribute to turn off the copy button.

```html
<wa-copy-button value="You can't copy me" disabled></wa-copy-button>
```

### Handling Errors

A copy fails when `value` is empty, when `from` points to an id that doesn't exist, or when the browser rejects the operation. Either way, the button shows its error state and emits the `wa-error` event. Customize the message with `error-label` and the icon with the `error-icon` slot.

```html
<wa-copy-button from="i-do-not-exist"></wa-copy-button>
```

### Feedback Duration

After a copy, the tooltip briefly shows the success or error label. Set the `feedback-duration` attribute (in milliseconds) to control how long it stays visible.

```html
<wa-copy-button value="Web Awesome rocks!" feedback-duration="250"></wa-copy-button>
```

### Tooltip Mode

The `tooltip` attribute controls when the built-in tooltip appears, on both the default and custom triggers.

| Value | Behavior |
| --- | --- |
| \`full\` default | Shows on hover and focus, and reused for copy feedback |
| \`copy\` | Stays silent on hover and focus; appears only to confirm a copy |
| \`none\` | Never shown |

```html
<div class="wa-cluster">
  <wa-copy-button value="npm install @awesome.me/webawesome" tooltip="full"></wa-copy-button>
  <wa-copy-button value="npm install @awesome.me/webawesome" tooltip="copy"></wa-copy-button>
  <wa-copy-button value="npm install @awesome.me/webawesome" tooltip="none"></wa-copy-button>
</div>
```

### Tooltip Placement

The tooltip sits above the trigger by default. Set the `tooltip-placement` attribute to `top`, `right`, `bottom`, or `left` to move it.

```html
<div class="wa-cluster">
  <wa-copy-button value="Above" tooltip-placement="top"></wa-copy-button>
  <wa-copy-button value="Right" tooltip-placement="right"></wa-copy-button>
  <wa-copy-button value="Below" tooltip-placement="bottom"></wa-copy-button>
  <wa-copy-button value="Left" tooltip-placement="left"></wa-copy-button>
</div>
```

### Customizing

Style the button through its CSS parts — `button`, `copy-icon`, `success-icon`, and `error-icon` — to match your design.

```html
<wa-copy-button value="I'm so stylish" class="custom-styles">
  <wa-icon slot="copy-icon" name="clipboard"></wa-icon>
  <wa-icon slot="success-icon" name="thumbs-up"></wa-icon>
  <wa-icon slot="error-icon" name="thumbs-down"></wa-icon>
</wa-copy-button>

<style>
  .custom-styles,
  .custom-styles::part(success-icon),
  .custom-styles::part(error-icon) {
    color: white;
  }

  .custom-styles::part(button) {
    background-color: #ff1493;
    border: solid 2px #ff7ac1;
    border-right-color: #ad005c;
    border-bottom-color: #ad005c;
    border-radius: 6px;
    transition: all var(--wa-transition-slow) var(--wa-transition-easing);
  }

  .custom-styles::part(button):hover {
    transform: scale(1.05);
  }

  .custom-styles::part(button):active {
    transform: translateY(1px);
  }

  .custom-styles::part(button):focus-visible {
    outline: dashed 2px deeppink;
    outline-offset: 4px;
  }
</style>
```
