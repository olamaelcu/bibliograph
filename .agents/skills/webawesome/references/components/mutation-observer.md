# Mutation Observer

`<wa-mutation-observer>`

Stable [Helpers](https://webawesome.com/docs/components/?category=helpers) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Mutation observers watch for changes to an element's DOM tree and emit an event when they occur. Provides a thin, declarative interface to the browser's MutationObserver API.

```html
<div class="mutation-overview">
  <wa-mutation-observer attr="variant">
    <wa-button appearance="filled" variant="brand">Click to mutate</wa-button>
  </wa-mutation-observer>

  <p>The observer saw the variant change to <span class="current">brand</span>.</p>

  <script>
    const container = document.querySelector('.mutation-overview');
    const mutationObserver = container.querySelector('wa-mutation-observer');
    const button = container.querySelector('wa-button');
    const current = container.querySelector('.current');
    const variants = ['brand', 'success', 'neutral', 'warning', 'danger'];
    let clicks = 0;

    // Change the button's variant attribute
    button.addEventListener('click', () => {
      clicks++;
      button.setAttribute('variant', variants[clicks % variants.length]);
    });

    // The observer reports each change it detects
    mutationObserver.addEventListener('wa-mutation', () => {
      current.textContent = button.getAttribute('variant');
    });
  </script>

  <style>
    .mutation-overview wa-button {
      margin-bottom: 1rem;
    }
  </style>
</div>
```

The mutation observer will report changes to the content it wraps through the `wa-mutation` event. When emitted, `event.detail.mutationList` holds a collection of [MutationRecord](https://developer.mozilla.org/en-US/docs/Web/API/MutationRecord) objects describing how it changed.

**Specify at least one of `attr`, `child-list`, or `char-data`.**  
These attributes tell the observer what changes to watch. Without at least one, no `wa-mutation` events are emitted.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/mutation-observer/mutation-observer.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/mutation-observer/mutation-observer.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/mutation-observer/mutation-observer.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaMutationObserver from '@awesome.me/webawesome/dist/react/mutation-observer/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The content to watch for mutations. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`attr\` attr | \`attr="class id title"\` Watches for changes to attributes. To watch only specific attributes, separate them by a space, e.g. . To watch all attributes, use \*. Type string | |
| \`attrOldValue\` attr-old-value | \`boolean\` Indicates whether or not the attribute's previous value should be recorded when monitoring changes. Type Default false | |
| \`charData\` char-data | \`boolean\` Watches for changes to the character data contained within the node. Type Default false | |
| \`charDataOldValue\` char-data-old-value | \`boolean\` Indicates whether or not the previous value of the node's text should be recorded. Type Default false | |
| \`childList\` child-list | \`boolean\` Watches for the addition or removal of new child nodes. Type Default false | |
| \`disabled\` disabled | \`boolean\` Disables the observer. Type Default false | |

### Events

| Name | Description |
| --- | --- |
| \`wa-mutation\` | Emitted when a mutation occurs. |

## Examples

### Child List

Use the `child-list` attribute to watch for new child elements that are added or removed.

```html
<div class="mutation-child-list">
  <wa-mutation-observer child-list>
    <div class="buttons">
      <wa-button appearance="filled" variant="brand">Add button</wa-button>
    </div>
  </wa-mutation-observer>

  <p>Add buttons, then click a numbered one to remove it. The observer saw <span class="log">no changes yet</span>.</p>

  <script>
    const container = document.querySelector('.mutation-child-list');
    const mutationObserver = container.querySelector('wa-mutation-observer');
    const buttons = container.querySelector('.buttons');
    const button = container.querySelector('wa-button[variant="brand"]');
    const log = container.querySelector('.log');
    let i = 0;

    // Add a button
    button.addEventListener('click', () => {
      const button = document.createElement('wa-button');
      button.setAttribute('appearance', 'filled');
      button.textContent = ++i;
      buttons.append(button);
    });

    // Remove a button
    buttons.addEventListener('click', event => {
      const target = event.target.closest('wa-button:not([variant="brand"])');
      event.stopPropagation();

      if (target) {
        target.remove();
      }
    });

    // The observer reports each change it detects
    mutationObserver.addEventListener('wa-mutation', event => {
      const [record] = event.detail.mutationList;
      log.textContent = record.addedNodes.length ? 'a button added' : 'a button removed';
    });
  </script>

  <style>
    .mutation-child-list .buttons {
      display: flex;
      gap: 0.25rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
    }
  </style>
</div>
```
