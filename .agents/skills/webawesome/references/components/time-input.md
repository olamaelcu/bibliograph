# Time Input

`<wa-time-input>`

Experimental [Forms](https://webawesome.com/docs/components/?category=forms) [Since 3.8](https://webawesome.com/docs/resources/changelog#wa_380)

Time pickers let users enter a time through a segmented field or select one visually from a popup column picker. They support 12- and 24-hour formats, optional seconds, and locale-aware segment order.

Time Input is the time-of-day counterpart to [Date Input](https://webawesome.com/docs/components/date-input). It renders a segmented input with hour, minute, optional seconds, and optional AM/PM spinbutton segments in the user's locale order, alongside a popup column picker modeled on Chrome's native time UI.

Type digits to fill the focused segment (focus auto-advances when a segment can accept no further digit), use the arrow keys to step through values, and press `Alt+Down Arrow` to open the popup. The entire segmented input is one tab stop.

```html
<wa-time-input label="Pick a time"></wa-time-input>
```

```html
<wa-time-input label="Meeting time" hint="Choose a time that works for you." value="14:30">
  <wa-icon slot="start" name="clock"></wa-icon>
</wa-time-input>
```

## Form Submission

The hidden form value is canonical 24-hour time, regardless of the user's locale or `hour-format`:

| Input | Form value | Notes |
| --- | --- | --- |
| Whole-minute steps (default) | \`HH:mm\` | \`step="60"\` or any multiple; e.g. 14:30 |
| Sub-minute steps | \`HH:mm:ss\` | \`step\` When < 60 and the seconds segment shows; e.g. 14:30:15 |
| 12-hour UI | 24-hour | \`2:30 PM\` submits as 14:30 |
| Partial input | (empty) | Until every required segment is filled |

The example below renders a working form. Submit it (or change the time) and watch the console. The time input submits its value just like a native `<input type="time">`, regardless of how the user typed or what locale they used.

```html
<form id="tp-form-demo">
  <wa-time-input name="meeting_time" label="Meeting time" required value="14:30"></wa-time-input>
  <br />
  <wa-button type="submit" appearance="filled" variant="neutral">Submit</wa-button>
</form>
<pre id="tp-form-demo-output"></pre>
<style>
  #tp-form-demo-output {
    margin-block-start: 1rem;
    margin-block-end: 0;
    padding: 0.75rem;
    background: var(--wa-color-surface-lowered);
    border-radius: var(--wa-border-radius-m);
    font-size: 0.875em;
  }

  #tp-form-demo-output:empty {
    display: none;
  }
</style>

<script>
  const form = document.getElementById('tp-form-demo');
  const output = document.getElementById('tp-form-demo-output');

  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const entries = Object.fromEntries(data.entries());
    const formatted = JSON.stringify(entries, null, 2);
    console.log('Submitted FormData:', entries);
    output.textContent = 'Submitted FormData:\n' + formatted;
  });
</script>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/time-input/time-input.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/time-input/time-input.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/time-input/time-input.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaTimeInput from '@awesome.me/webawesome/dist/react/time-input/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| \`clear-icon\` | An icon to use in lieu of the default clear icon. |
| \`end\` | An element placed at the end of the input. |
| \`expand-icon\` | The icon to show on the popup toggle button. Defaults to a clock icon. |
| \`footer\` | Content shown below the column picker in the popup. Replaces the default Now button when present. |
| \`hint\` | \`hint\` Text that describes how to use the time picker. Alternatively, use the attribute. |
| \`label\` | \`label\` The time picker's . Alternatively, use the label attribute. |
| \`start\` | An element placed at the start of the input. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`'filled' \\| 'outlined' \\| 'filled-outlined'\` The time picker's visual appearance. Type Default 'outlined' | |
| \`assumeInteractionOn\` | \`input\` Every segment edit dispatches , so a single observed input event marks the field as interacted with. Type string\[\] Default \['input'\] | |
| \`autocomplete\` autocomplete | \`on\` Forwarded to the hidden form input to enable browser autofill (/off/custom tokens). Type string Default '' | |
| \`defaultValue\` value | \`string\` The default value of the form control. Used for form reset. Type | |
| \`disabled\` disabled | \`boolean\` Disables the time picker. Type Default false | |
| \`distance\` distance | \`number\` Distance in pixels between the popup and the input. Type Default 0 | |
| \`form\` | \`

\` By default, form controls are associated with the nearest containing element. This attribute allows you to place the form control outside of a form and associate it with the form that has this id. The form must be in the same document or shadow root for this to work. Type HTMLFormElement \\| null | |
| \`hint\` hint | \`hint\` The time picker's . If you need to display HTML, use the hint slot instead. Type string Default '' | |
| \`hourFormat\` hour-format | \`auto\` Whether the UI uses a 12-hour or 24-hour clock. follows the resolved locale. Type WaTimeInputHourFormat Default 'auto' | |
| \`label\` label | \`label\` The time picker's . If you need to display HTML, use the label slot instead. Type string Default '' | |
| \`max\` max | \`string\` The latest selectable time in wire format. Type Default '' | |
| \`min\` min | \`max\` The earliest selectable time in wire format. May be later than to represent an overnight range. The picker delegates reversed-range semantics to the mirrored native . Type string Default '' | |
| \`name\` name | \`string \\| null\` The time picker's name, submitted as a name/value pair with form data. Type Default '' | |
| \`open\` open | \`boolean\` Whether the popup is open. Type Default false | |
| \`pill\` pill | \`boolean\` Draws a pill-style time picker with rounded edges. Type Default false | |
| \`placement\` placement | \`WaTimeInputPlacement\` Preferred popup placement. Type Default 'bottom-start' | |
| \`readonly\` readonly | \`boolean\` Makes the input non-editable. The popup still opens for browsing. Type Default false | |
| \`required\` required | \`boolean\` Makes the time picker required for form submission. Type Default false | |
| \`size\` size | \`WaTimeInputSize \\| 'small' \\| 'medium' \\| 'large'\` The time picker's size. Type Default 'm' | |
| \`step\` step | \`\` The granularity, in seconds, matching HTML . Default 60 hides the seconds segment. Values below 60 reveal the seconds segment. 'any' disables stepMismatch enforcement. Type number \\| 'any' Default 60 | |
| \`validationTarget\` | \`undefined \\| HTMLElement\` Override this to change where constraint validation popups are anchored. Type | |
| \`validators\` | \`observedAttributes\` Validators are static because they have , essentially attributes to "watch" for changes. Whenever these attributes change, we want to be notified and update the validator. Type Validator\[\] Default \[\] | |
| \`value\` | \`\` The time picker's value as a wire-format string matching HTML : HH:mm, HH:mm:ss, or HH:mm:ss.sss (always 24-hour). The setter also accepts a Date (extracts local h/m/s) or null. Type string | |
| \`valueAsDate\` | \`Date\` The time as a (today + wire value), or null when empty. Type Date \\| null | |
| \`valueAsNumber\` | \`NaN\` Milliseconds since midnight, or when empty. Type number | |
| \`withClear\` with-clear | \`boolean\` Shows a clear button when the time picker has a value. Type Default false | |
| \`withHint\` with-hint | \`true\` Only required for SSR. Set to if you're slotting in a hint element. Type boolean Default false | |
| \`withLabel\` with-label | \`true\` Only required for SSR. Set to if you're slotting in a label element. Type boolean Default false | |
| \`withNow\` with-now | \`boolean\` Renders a "Now" button in the popup footer. Type Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`blur()\` | Removes focus from the time picker. | |
| \`focus()\` | Sets focus on the first empty (else first) segment. | \`options: FocusOptions\` |
| \`formStateRestoreCallback()\` | Called when the browser is trying to restore element’s state to state in which case reason is "restore", or when the browser is trying to fulfill autofill on behalf of user in which case reason is "autocomplete". In the case of "restore", state is a string, File, or FormData object previously set as the second argument to setFormValue. | \`state: string \\| File \\| FormData \\| null\` |
| \`hide()\` | Closes the popup. | |
| \`resetValidity()\` | Reset validity is a way of removing manual custom errors and native validation. | |
| \`setCustomValidity()\` | Do not use this when creating a "Validator". This is intended for end users of components. We track manually defined custom errors so we don't clear them on accident in our validators. | \`message: string\` |
| \`show()\` | Opens the popup. | |

### Events

| Name | Description |
| --- | --- |
| \`blur\` | Emitted when the control loses focus. |
| \`change\` | Emitted when the committed value changes. |
| \`focus\` | Emitted when the control receives focus. |
| \`input\` | Emitted as the user types into a segment or interacts with the popup columns. |
| \`wa-after-hide\` | Emitted after the popup closes and animations complete. |
| \`wa-after-show\` | Emitted after the popup opens and animations complete. |
| \`wa-clear\` | Emitted when the clear button is activated. |
| \`wa-hide\` | Emitted when the popup is about to close. Cancelable. |
| \`wa-invalid\` | Emitted when the form control has been checked for validity and its constraints aren't satisfied. |
| \`wa-show\` | Emitted when the popup is about to open. Cancelable. |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--column-item-height\` | \`2.25em\` Height of each option inside a popup column. Default |
| \`--column-width\` | \`3em\` Width of each popup column. Default |
| \`--hide-duration\` | \`var(--wa-transition-fast)\` The duration of the hide animation. Default |
| \`--show-duration\` | \`var(--wa-transition-fast)\` The duration of the show animation. Default |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`blank\` | The time picker has no committed value. | \`:state(blank)\` |
| \`disabled\` | The time picker is disabled. | \`:state(disabled)\` |
| \`open\` | The popup is open. | \`:state(open)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`clear-button\` | The clear button. | \`::part(clear-button)\` |
| \`column\` | Each column listbox. | \`::part(column)\` |
| \`column-item\` | Each option inside a column. | \`::part(column-item)\` |
| \`column-item-selected\` | The currently selected option inside a column. | \`::part(column-item-selected)\` |
| \`columns\` | The row of column listboxes inside the popup. | \`::part(columns)\` |
| \`end\` | \`end\` The container that wraps the slot. | \`::part(end)\` |
| \`expand-button\` | The popup toggle button. | \`::part(expand-button)\` |
| \`expand-icon\` | The expand icon wrapper. | \`::part(expand-icon)\` |
| \`form-control\` | The form control that wraps the label, input, and hint. | \`::part(form-control)\` |
| \`form-control-input\` | The input's wrapper. | \`::part(form-control-input)\` |
| \`form-control-label\` | The label. | \`::part(form-control-label)\` |
| \`hint\` | The hint's wrapper. | \`::part(hint)\` |
| \`input\` | The segmented input group. | \`::part(input)\` |
| \`input-wrapper\` | The container around the start slot, segmented input, clear button, and expand button. | \`::part(input-wrapper)\` |
| \`now-button\` | \`with-now\` The default "Now" button rendered in the popup footer when is set. | \`::part(now-button)\` |
| \`popup\` | The popup container. | \`::part(popup)\` |
| \`segment\` | \`\[part~="segment"\]\` Each editable segment (hour/minute/second/AM-PM spinbutton). Use to style all. | \`::part(segment)\` |
| \`segment-literal\` | Inert literal text between segments (separators). | \`::part(segment-literal)\` |
| \`start\` | \`start\` The container that wraps the slot. | \`::part(start)\` |
| \`time-input\` | The component's outer wrapper. | \`::part(time-input)\` |
| \`base\` | \`time-input\` Deprecated. Use the part instead. | \`::part(base)\` |
| \`label\` | \`form-control-label\` Deprecated. Use the part instead. | \`::part(label)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)
-   [`<wa-popup>`](https://webawesome.com/docs/components/popup)

## Examples

### Initial Value

Set the `value` attribute to a time string to pre-populate the input.

```html
<wa-time-input label="Meeting time" value="14:30"></wa-time-input>
```

### Label

Use the `label` attribute to give the time input an accessible label. For labels that contain HTML, use the `label` slot instead.

```html
<wa-time-input label="What time works for you?"></wa-time-input>
```

### Hint

Add descriptive hint to a time input with the `hint` attribute. For hints that contain HTML, use the `hint` slot instead.

```html
<wa-time-input label="Wake up" hint="Set the time your alarm should go off."></wa-time-input>
```

### Start & End Decorations

Use the `start` and `end` slots to add presentational elements like [`<wa-icon>`](https://webawesome.com/docs/components/icon) inside the input.

```html
<div class="wa-stack">
  <wa-time-input label="Start">
    <wa-icon name="hourglass-start" slot="start"></wa-icon>
  </wa-time-input>
  <wa-time-input label="End">
    <wa-icon name="hourglass-end" slot="end"></wa-icon>
  </wa-time-input>
</div>
```

### Clearable

Add the `with-clear` attribute to let users wipe their selection in a single click. The clear button only appears once a value is set.

```html
<wa-time-input label="Alarm" with-clear value="07:00"></wa-time-input>
```

### Min & Max

Constrain the selectable range. The picker delegates reversed-range (overnight) semantics to the native `<input type="time">`, so `min="22:00" max="06:00"` represents an overnight range.

```html
<wa-time-input label="Office hours" min="09:00" max="17:00"></wa-time-input>
```

### Step

The `step` attribute is in **seconds**, matching the HTML spec. The default is `60` (one minute). Set `step` below `60` to expose a seconds segment; set it to a multiple of `60` to populate the minute column at that stride.

```html
<div class="wa-stack">
  <wa-time-input label="Every 5 minutes" step="300"></wa-time-input>
  <wa-time-input label="With seconds" step="1"></wa-time-input>
</div>
```

### 12-Hour vs 24-Hour

By default, `hour-format="auto"` follows the resolved locale. Pass `hour-format="12"` or `hour-format="24"` to override.

```html
<div class="wa-stack">
  <wa-time-input label="12-hour" hour-format="12" value="09:00"></wa-time-input>
  <wa-time-input label="24-hour" hour-format="24" value="09:00"></wa-time-input>
</div>
```

### Localized

The segment order, separators, and AM/PM strings all derive from the page's locale. Set the `lang` attribute on the host (or an ancestor) to change locales.

```html
<div class="wa-stack">
  <wa-time-input lang="en-US" label="English (US)" value="14:30"></wa-time-input>
  <wa-time-input lang="en-GB" label="English (UK)" value="14:30"></wa-time-input>
  <wa-time-input lang="de-DE" label="German" value="14:30"></wa-time-input>
</div>
```

### "Now" Button

Add a quick-pick "Now" button in the popup footer with `with-now`.

```html
<wa-time-input label="When?" with-now></wa-time-input>
```

### Size

Use the `size` attribute to match the time input to surrounding form controls.

```html
<div class="wa-stack">
  <wa-time-input size="xs" label="Extra small"></wa-time-input>
  <wa-time-input size="s" label="Small"></wa-time-input>
  <wa-time-input size="m" label="Medium"></wa-time-input>
  <wa-time-input size="l" label="Large"></wa-time-input>
  <wa-time-input size="xl" label="Extra large"></wa-time-input>
</div>
```

### Appearance

Use the `appearance` attribute to switch between the default outlined input, a filled background, or a filled input with an outlined border.

```html
<div class="wa-stack">
  <wa-time-input appearance="outlined" label="Outlined"></wa-time-input>
  <wa-time-input appearance="filled" label="Filled"></wa-time-input>
  <wa-time-input appearance="filled-outlined" label="Filled outlined"></wa-time-input>
</div>
```

### Pill

Use the `pill` attribute to give the input fully rounded edges.

```html
<wa-time-input pill label="Pill"></wa-time-input>
```

### Disabled

Use the `disabled` attribute to disable the time input entirely. Disabled time inputs don't accept input, are skipped during tabbing, and don't submit a value with the form.

```html
<wa-time-input label="Disabled" value="09:00" disabled></wa-time-input>
```

### Readonly

Use the `readonly` attribute to make the time input non-editable while still allowing it to be focused and to submit its value with the form. The popup still opens for browsing.

```html
<wa-time-input label="Read-only" value="09:00" readonly></wa-time-input>
```
