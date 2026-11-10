# Progress Bar

`<wa-progress-bar>`

Stable [Feedback](https://webawesome.com/docs/components/?category=feedback) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Progress bars show how far along an ongoing operation is as a horizontal fill. Use them for file uploads, multi-step flows, or any task with measurable progress.

```html
<wa-progress-bar value="40"></wa-progress-bar>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/progress-bar/progress-bar.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/progress-bar/progress-bar.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaProgressBar from '@awesome.me/webawesome/dist/react/progress-bar/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | A label to show inside the progress indicator. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`indeterminate\` indeterminate | \`boolean\` When true, percentage is ignored, the label is hidden, and the progress bar is drawn in an indeterminate state. Type Default false | |
| \`label\` label | \`string\` A custom label for assistive devices. Type Default '' | |
| \`value\` value | \`number\` The current progress as a percentage, 0 to 100. Type Default 0 | |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--indicator-color\` | \`var(--wa-color-brand-fill-loud)\` The color of the indicator. Default |
| \`--track-color\` | \`var(--wa-color-neutral-fill-normal)\` The color of the track. Default |
| \`--track-height\` | \`1rem\` The height of the track. Default |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`indicator\` | The progress bar's indicator. | \`::part(indicator)\` |
| \`label\` | The progress bar's label. | \`::part(label)\` |
| \`progress-bar\` | The component's outer wrapper. | \`::part(progress-bar)\` |
| \`base\` | \`progress-bar\` Deprecated. Use the part instead. | \`::part(base)\` |

## Examples

### Label

Use the `label` attribute to tell assistive devices how to announce the progress bar.

```html
<wa-progress-bar value="50" label="Upload progress"></wa-progress-bar>
```

### Indeterminate

Add the `indeterminate` attribute when an operation is pending but its progress can't be measured. In this state, `value` is ignored and the label, if present, isn't shown.

```html
<wa-progress-bar indeterminate></wa-progress-bar>
```

### Customizing

Set the `--track-height` custom property to change the bar's thickness, and `--track-color` / `--indicator-color` to recolor it.

```html
<wa-progress-bar
  value="60"
  style="
    --track-height: 1.5rem;
    --track-color: var(--wa-color-neutral-fill-quiet);
    --indicator-color: var(--wa-color-success-fill-loud);
  "
></wa-progress-bar>
```

### Showing Values

Use the default slot to show a value inside the bar.

```html
<div class="wa-stack">
  <wa-progress-bar value="50" id="progress-bar-demo">50%</wa-progress-bar>

  <wa-divider></wa-divider>

  <div class="wa-cluster">
    <wa-button pill appearance="filled">
      <wa-icon name="minus" label="Decrease"></wa-icon>
    </wa-button>
    <wa-button pill appearance="filled">
      <wa-icon name="plus" label="Increase"></wa-icon>
    </wa-button>
  </div>
</div>

<script>
  const progressBar = document.querySelector('#progress-bar-demo');
  const subtractButton = document.querySelector('wa-button:has(wa-icon[name="minus"])');
  const addButton = document.querySelector('wa-button:has(wa-icon[name="plus"])');

  addButton.addEventListener('click', () => {
    const value = Math.min(100, progressBar.value + 10);
    progressBar.value = value;
    progressBar.textContent = `${value}%`;
  });

  subtractButton.addEventListener('click', () => {
    const value = Math.max(0, progressBar.value - 10);
    progressBar.value = value;
    progressBar.textContent = `${value}%`;
  });
</script>
```
