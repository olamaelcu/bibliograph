# Resize Observer

`<wa-resize-observer>`

Stable [Helpers](https://webawesome.com/docs/components/?category=helpers) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Resize observers watch their slotted elements for size changes and emit an event when they occur. Provides a thin, declarative interface to the browser's ResizeObserver API.

```html
<div class="resize-observer-overview">
  <wa-resize-observer>
    <div class="box"><span class="dimensions">0 × 0</span></div>
  </wa-resize-observer>
  <small>Drag the box's bottom-right corner to resize it.</small>
</div>

<script>
  const container = document.querySelector('.resize-observer-overview');
  const dimensions = container.querySelector('.dimensions');
  const resizeObserver = container.querySelector('wa-resize-observer');

  resizeObserver.addEventListener('wa-resize', event => {
    const { width, height } = event.detail.entries[0].contentRect;
    dimensions.textContent = `${Math.round(width)} × ${Math.round(height)}`;
  });
</script>

<style>
  .resize-observer-overview .box {
    display: flex;
    resize: both;
    overflow: auto;
    width: 20rem;
    height: 8rem;
    min-width: 8rem;
    min-height: 5rem;
    align-items: center;
    justify-content: center;
    border: dashed 2px var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
    font-size: 1.25rem;
    font-variant-numeric: tabular-nums;
  }

  .resize-observer-overview small {
    display: block;
    margin-block-start: var(--wa-space-s);
  }
</style>
```

The resize observer will report changes to the dimensions of the elements it wraps through the `wa-resize` event. When emitted, `event.detail.entries` holds a collection of [`ResizeObserverEntry`](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserverEntry) objects describing the observed elements and their new dimensions.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/resize-observer/resize-observer.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/resize-observer/resize-observer.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/resize-observer/resize-observer.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaResizeObserver from '@awesome.me/webawesome/dist/react/resize-observer/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | One or more elements to watch for resizing. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`disabled\` disabled | \`boolean\` Disables the observer. Type Default false | |

### Events

| Name | Description |
| --- | --- |
| \`wa-resize\` | Emitted when the element is resized. |