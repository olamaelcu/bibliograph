# Progress Ring

`<wa-progress-ring>`

Stable [Feedback](https://webawesome.com/docs/components/?category=feedback) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Progress rings show how far along a determinate operation is using a circular indicator. Use them as a compact alternative to progress bars when horizontal space is limited.

```html
<wa-progress-ring value="25"></wa-progress-ring>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/progress-ring/progress-ring.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/progress-ring/progress-ring.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/progress-ring/progress-ring.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaProgressRing from '@awesome.me/webawesome/dist/react/progress-ring/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | A label to show inside the ring. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`label\` label | \`string\` A custom label for assistive devices. Type Default '' | |
| \`value\` value | \`number\` The current progress as a percentage, 0 to 100. Type Default 0 | |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--indicator-color\` | The color of the indicator. |
| \`--indicator-transition-duration\` | The duration of the indicator's transition when the value changes. |
| \`--indicator-width\` | The width of the indicator. Defaults to the track width. |
| \`--size\` | The diameter of the progress ring (cannot be a percentage). |
| \`--track-color\` | The color of the track. |
| \`--track-width\` | The width of the track. |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`indicator\` | The progress ring's indicator. | \`::part(indicator)\` |
| \`label\` | The progress ring label. | \`::part(label)\` |
| \`progress-ring\` | The component's outer wrapper. | \`::part(progress-ring)\` |
| \`track\` | The progress ring's track. | \`::part(track)\` |
| \`base\` | \`progress-ring\` Deprecated. Use the part instead. | \`::part(base)\` |

## Examples

### Label

Use the `label` attribute to tell assistive devices how to announce the progress ring.

```html
<wa-progress-ring value="25" label="Sync progress"></wa-progress-ring>
```

### Size

Use the `--size` custom property to set the diameter of the ring.

```html
<wa-progress-ring value="50" style="--size: 200px;"></wa-progress-ring>
```

### Track & Indicator Width

Use the `--track-width` and `--indicator-width` custom properties to set the width of the ring's track and indicator independently.

```html
<wa-progress-ring value="50" style="--track-width: 6px; --indicator-width: 12px;"></wa-progress-ring>
```

### Colors

Use the `--track-color` and `--indicator-color` custom properties to recolor the ring.

```html
<wa-progress-ring
  value="50"
  style="
    --track-color: var(--wa-color-success-fill-quiet);
    --indicator-color: var(--wa-color-success-fill-loud);
  "
></wa-progress-ring>
```

### Showing Values

Use the default slot to show a value inside the ring.

```html
<div class="progress-ring-overview">
  <wa-progress-ring value="50" class="progress-ring-values">50%</wa-progress-ring>

  <wa-divider></wa-divider>

  <div class="wa-cluster">
    <wa-button appearance="filled" circle><wa-icon name="minus" label="Decrease"></wa-icon></wa-button>
    <wa-button appearance="filled" circle><wa-icon name="plus" label="Increase"></wa-icon></wa-button>
  </div>
</div>

<script>
  const progressRing = document.querySelector('.progress-ring-values');
  const subtractButton = document.querySelector('.progress-ring-overview wa-button:has(wa-icon[name="minus"])');
  const addButton = document.querySelector('.progress-ring-overview wa-button:has(wa-icon[name="plus"])');

  addButton.addEventListener('click', () => {
    const value = Math.min(100, progressRing.value + 10);
    progressRing.value = value;
    progressRing.textContent = `${value}%`;
  });

  subtractButton.addEventListener('click', () => {
    const value = Math.max(0, progressRing.value - 10);
    progressRing.value = value;
    progressRing.textContent = `${value}%`;
  });
</script>
```
