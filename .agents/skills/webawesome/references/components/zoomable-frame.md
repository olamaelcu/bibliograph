# Zoomable Frame

`<wa-zoomable-frame>`

Stable [Media](https://webawesome.com/docs/components/?category=media) [Since 3.0](https://webawesome.com/docs/resources/changelog#wa_300)

Zoomable frames embed iframe content with built-in controls for zooming, panning, and managing interaction.

```html
<wa-zoomable-frame src="/examples/themes/showcase" zoom="0.5"> </wa-zoomable-frame>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/zoomable-frame/zoomable-frame.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/zoomable-frame/zoomable-frame.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/zoomable-frame/zoomable-frame.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaZoomableFrame from '@awesome.me/webawesome/dist/react/zoomable-frame/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| \`zoom-in-icon\` | The slot that contains the zoom in icon. |
| \`zoom-out-icon\` | The slot that contains the zoom out icon. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`allowfullscreen\` allowfullscreen | \`boolean\` Allows fullscreen mode. Type Default false | |
| \`contentDocument\` | \`document\` Returns the internal iframe's object. (Readonly property) Type Document \\| null | |
| \`contentWindow\` | \`window\` Returns the internal iframe's object. (Readonly property) Type Window \\| null | |
| \`loading\` loading | \`'eager' \\| 'lazy'\` Controls iframe loading behavior. Type Default 'eager' | |
| \`referrerpolicy\` referrerpolicy | \`string\` Controls referrer information. Type | |
| \`sandbox\` sandbox | \`string\` Security restrictions for the iframe. Type | |
| \`src\` src | \`string\` The URL of the content to display. Type | |
| \`srcdoc\` srcdoc | \`string\` Inline HTML to display. Type | |
| \`withoutControls\` without-controls | \`boolean\` Removes the zoom controls. Type Default false | |
| \`withoutInteraction\` without-interaction | \`boolean\` Disables interaction when present. Type Default false | |
| \`withThemeSync\` with-theme-sync | \`boolean\` Enables automatic theme syncing (light/dark mode and theme selector classes) from the host document to the iframe. Type Default false | |
| \`zoom\` zoom | \`number\` The current zoom of the frame, e.g. 0 = 0% and 1 = 100%. Type Default 1 | |
| \`zoomLevels\` zoom-levels | \`string\` The zoom levels to step through when using zoom controls. This does not restrict programmatic changes to the zoom. Type Default '25% 50% 75% 100% 125% 150% 175% 200%' | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`zoomIn()\` | Zooms in to the next available zoom level. | |
| \`zoomOut()\` | Zooms out to the previous available zoom level. | |

### Events

| Name | Description |
| --- | --- |
| \`error\` | Emitted from the internal iframe when it fails to load. |
| \`load\` | Emitted when the internal iframe when it finishes loading. |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`controls\` | The container that surrounds zoom control buttons. | \`::part(controls)\` |
| \`iframe\` | \`\` The internal element. | \`::part(iframe)\` |
| \`zoom-in-button\` | The zoom in button. | \`::part(zoom-in-button)\` |
| \`zoom-out-button\` | The zoom out button. | \`::part(zoom-out-button)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)

## Examples

### External Content

Use the `src` attribute to embed external websites or resources. The URL must be accessible, and cross-origin restrictions may apply due to the Same-Origin Policy, potentially limiting access to the iframe's content.

```html
<wa-zoomable-frame src="https://example.com/"> </wa-zoomable-frame>
```

### Aspect Ratio

The frame fills 100% width with a 16:9 aspect ratio by default. Change it with the `aspect-ratio` CSS property.

```html
<wa-zoomable-frame src="https://example.com/" style="aspect-ratio: 4/3;"> </wa-zoomable-frame>
```

### Inline Content

Use the `srcdoc` attribute or property to render custom HTML directly in the frame, without an external resource.

```html
<wa-zoomable-frame srcdoc="<html><body><h1>Hello, World!</h1><p>This is inline content.</p></body></html>">
</wa-zoomable-frame>
```

When both `src` and `srcdoc` are specified, `srcdoc` takes precedence.

### Zoom

Set the `zoom` attribute to control the frame's zoom level. Use `1` for 100%, `2` for 200%, `0.5` for 50%, and so on.

Define specific zoom increments with the `zoom-levels` attribute using space-separated percentages and decimal values like `zoom-levels="0.25 0.5 75% 100%"`.

```html
<wa-zoomable-frame src="/examples/themes/showcase" zoom="0.5" zoom-levels="50% 0.75 100%"> </wa-zoomable-frame>
```

### Zoom Controls

Add the `without-controls` attribute to hide the zoom control interface from the frame.

```html
<wa-zoomable-frame src="/examples/themes/showcase" without-controls zoom="0.5"> </wa-zoomable-frame>
```

### User Interaction

Apply the `without-interaction` attribute to make the frame non-interactive. This also prevents keyboard navigation into the frame, which may impact accessibility for some users.

```html
<wa-zoomable-frame src="/examples/themes/showcase" zoom="0.5" without-interaction> </wa-zoomable-frame>
```

### Theme Sync

By default, the frame does not sync theme classes into the iframe. Add the `with-theme-sync` attribute to mirror the host page's light/dark mode and [theme selector classes](https://webawesome.com/docs/theming-overview) (such as `wa-theme-*`, `wa-brand-*`, and `wa-palette-*`) into the iframe document. This is useful when the iframe renders Web Awesome styles that should match the host page's theme.

```html
<wa-zoomable-frame src="/examples/themes/showcase" zoom="0.5" with-theme-sync> </wa-zoomable-frame>
```
