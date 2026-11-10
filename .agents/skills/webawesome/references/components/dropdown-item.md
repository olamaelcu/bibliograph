# Dropdown Item

`<wa-dropdown-item>`

Stable [Actions](https://webawesome.com/docs/components/?category=actions) [Since 3.0](https://webawesome.com/docs/resources/changelog#wa_300)

Dropdown items represent selectable entries within a dropdown menu, including standard actions, checkable items, and submenu triggers.

This component must be used as a child of [`<wa-dropdown>`](https://webawesome.com/docs/components/dropdown). Please see the [Dropdown docs](https://webawesome.com/docs/components/dropdown) to see examples of this component in action.

```html
<!-- dropdown is an overlay that won't render on a static stage, so the items show among dimmed siblings. -->
<div style="display: flex; flex-direction: column;">
  <wa-dropdown-item><wa-icon slot="icon" name="copy"></wa-icon>Copy<span slot="details">⌘C</span></wa-dropdown-item>
  <wa-dropdown-item data-anatomy-subject="true"
    ><wa-icon slot="icon" name="scissors"></wa-icon>Cut<span slot="details">⌘X</span></wa-dropdown-item
  >
  <wa-dropdown-item><wa-icon slot="icon" name="trash"></wa-icon>Delete</wa-dropdown-item>
</div>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/dropdown-item/dropdown-item.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/dropdown-item/dropdown-item.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaDropdownItem from '@awesome.me/webawesome/dist/react/dropdown-item/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The dropdown item's label. |
| \`details\` | Additional content or details to display after the label. |
| \`icon\` | An optional icon to display before the label. |
| \`submenu\` | \`\` Submenu items, typically elements, to create a nested menu. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`checked\` checked | \`type\` Set to true to check the dropdown item. Only valid when is checkbox. Type boolean Default false | |
| \`disabled\` disabled | \`boolean\` Disables the dropdown item. Type Default false | |
| \`download\` download | \`href\` Tells the browser to download the linked file as this filename. Only used when is present. Type string | |
| \`href\` href | \`string\` When set, selecting the item will navigate to this URL. The item remains a menu item for assistive devices, so make sure the label describes where the link goes. Ignored when the item has a submenu. Type | |
| \`rel\` rel | \`href\` When using , this attribute will map to the underlying link's rel attribute. Type string | |
| \`submenuOpen\` submenuOpen | \`boolean\` Whether the submenu is currently open. Type Default false | |
| \`target\` target | \`href\` Tells the browser where to open the link. Only used when is present. Type '\_blank' \\| '\_parent' \\| '\_self' \\| '\_top' | |
| \`type\` type | \`checkbox\` Set to to make the item a checkbox. Type 'normal' \\| 'checkbox' Default 'normal' | |
| \`value\` value | \`wa-select\` An optional value for the menu item. This is useful for determining which item was selected when listening to the dropdown's event. Type string | |
| \`variant\` variant | \`'danger' \\| 'default'\` The type of menu item to render. Type Default 'default' | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`closeSubmenu()\` | Closes the submenu. | |
| \`openSubmenu()\` | Opens the submenu. | |

### Events

| Name | Description |
| --- | --- |
| \`blur\` | Emitted when the dropdown item loses focus. |
| \`focus\` | Emitted when the dropdown item gains focus. |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`active\` | Applied when the item is the active item in the menu. | \`:state(active)\` |
| \`checked\` | Applied when the item is checked. | \`:state(checked)\` |
| \`disabled\` | Applied when the item is disabled. | \`:state(disabled)\` |
| \`has-submenu\` | Applied when the item has a submenu. | \`:state(has-submenu)\` |
| \`link\` | \`href\` Applied when the item is a link (i.e. is set). | \`:state(link)\` |
| \`submenu-open\` | Applied when the item's submenu is open. | \`:state(submenu-open)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`checkmark\` | \`\` The submenu indicator icon (a element). | \`::part(submenu-icon)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)