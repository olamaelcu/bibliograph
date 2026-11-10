# Tab Panel

`<wa-tab-panel>`

Stable [Navigation](https://webawesome.com/docs/components/?category=navigation) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Tab panels hold the content shown for a single tab inside a tab group.

This component must be used as a child of [`<wa-tab-group>`](https://webawesome.com/docs/components/tab-group). Please see the [Tab Group docs](https://webawesome.com/docs/components/tab-group) to see examples of this component in action.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/tab-panel/tab-panel.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/tab-panel/tab-panel.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaTabPanel from '@awesome.me/webawesome/dist/react/tab-panel/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The tab panel's content. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`active\` active | \`boolean\` When true, the tab panel will be shown. Type Default false | |
| \`name\` name | \`string\` The tab panel's name. Type Default '' | |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--padding\` | The tab panel's padding. |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`base\` | Deprecated. Style the host element instead. | \`::part(base)\` |