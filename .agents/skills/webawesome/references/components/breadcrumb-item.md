# Breadcrumb Item

`<wa-breadcrumb-item>`

Stable [Navigation](https://webawesome.com/docs/components/?category=navigation) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Breadcrumb items represent individual links inside a breadcrumb, typically one per level of the site hierarchy.

This component must be used as a child of [`<wa-breadcrumb>`](https://webawesome.com/docs/components/breadcrumb). Please see the [Breadcrumb docs](https://webawesome.com/docs/components/breadcrumb) to see examples of this component in action.

```html
<wa-breadcrumb>
  <wa-breadcrumb-item><wa-icon slot="start" name="house"></wa-icon>Home</wa-breadcrumb-item>
  <wa-breadcrumb-item data-anatomy-subject="true"><wa-icon slot="start" name="folder"></wa-icon>Projects</wa-breadcrumb-item>
  <wa-breadcrumb-item>Overview</wa-breadcrumb-item>
</wa-breadcrumb>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/breadcrumb-item/breadcrumb-item.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/breadcrumb-item/breadcrumb-item.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/breadcrumb-item/breadcrumb-item.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaBreadcrumbItem from '@awesome.me/webawesome/dist/react/breadcrumb-item/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The breadcrumb item's label. |
| \`end\` | \`

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`href\` href | \`string \\| undefined\` Optional URL to direct the user to when the breadcrumb item is activated. When set, a link will be rendered internally. When unset, a button will be rendered instead. Type | |
| \`rel\` rel | \`rel\` The attribute to use on the link. Only used when href is set. Type string Default 'noreferrer noopener' | |
| \`target\` target | \`href\` Tells the browser where to open the link. Only used when is set. Type '\_blank' \\| '\_parent' \\| '\_self' \\| '\_top' \\| undefined | |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`end\` | \`end\` The container that wraps the slot. | \`::part(end)\` |
| \`label\` | The breadcrumb item's label. | \`::part(label)\` |
| \`separator\` | The container that wraps the separator. | \`::part(separator)\` |
| \`start\` | \`start\` The container that wraps the slot. | \`::part(start)\` |