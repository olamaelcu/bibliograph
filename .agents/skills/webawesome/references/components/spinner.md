# Spinner

`<wa-spinner>`

Stable [Feedback](https://webawesome.com/docs/components/?category=feedback) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Spinners indicate that an operation is in progress when the duration is unknown. Use them for loading states where a determinate progress bar isn't practical.

```html
<wa-spinner></wa-spinner>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/spinner/spinner.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/spinner/spinner.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaSpinner from '@awesome.me/webawesome/dist/react/spinner/index.js';
```

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--indicator-color\` | The color of the spinner's indicator. |
| \`--speed\` | The time it takes for the spinner to complete one animation cycle. |
| \`--track-color\` | The color of the track. |
| \`--track-width\` | The width of the track. |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`spinner\` | The component's outer wrapper. | \`::part(spinner)\` |
| \`base\` | \`spinner\` Deprecated. Use the part instead. | \`::part(base)\` |

## Examples

### Size

Spinners are sized based on the current font size. To change the size, set `font-size` on the spinner itself or on a parent element.

```html
<wa-spinner></wa-spinner>
<wa-spinner style="font-size: 2rem;"></wa-spinner>
<wa-spinner style="font-size: 3rem;"></wa-spinner>
```

### Track Width

Use the `--track-width` custom property to change the thickness of the spinner's track.

```html
<wa-spinner style="font-size: 50px; --track-width: 10px;"></wa-spinner>
```

### Colors

Use the `--track-color` and `--indicator-color` custom properties to recolor the spinner.

```html
<wa-spinner style="font-size: 3rem; --indicator-color: var(--wa-color-success-fill-loud); --track-color: var(--wa-color-success-fill-quiet);"></wa-spinner>
```

### Speed

Use the `--speed` custom property to set how long one full rotation takes.

```html
<wa-spinner style="font-size: 3rem; --speed: 4s;"></wa-spinner>
```
