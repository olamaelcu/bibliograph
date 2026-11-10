# Known Date

`<wa-known-date>`

Experimental [Forms](https://webawesome.com/docs/components/?category=forms) [Since 3.8](https://webawesome.com/docs/resources/changelog#wa_380)

Known dates let users enter dates they already know - birthdays, expirations, document dates - through three separate day, month, and year fields shown in the locale's natural order.

Known Date collects a date the user already knows — a birthday, a passport issue date, an expiration — through three separate fields for day, month, and year. It follows the [UK Government Design System date input pattern](https://design-system.service.gov.uk/components/date-input/): a labeled `<fieldset>` wraps three plain `<input>` elements, the user types each part themselves, and the host submits a single canonical ISO date.

```html
<wa-known-date label="When was your passport issued?"></wa-known-date>
```

**Need a calendar, ranges, or browsing?**  
Use [`<wa-date-input>`](https://webawesome.com/docs/components/date-input) instead. Known Date is intentionally simple: no popup calendar, no auto-advance between fields, and no clever parsing.

## Form Submission

The hidden form value is canonical ISO 8601 (`YYYY-MM-DD`), regardless of the locale used to render the fields:

| Entry | Form value |
| --- | --- |
| Complete, valid date | \`YYYY-MM-DD\` (e.g. 2007-03-27) |
| Partial (one or two fields) | (empty) — omitted from form data |
| Invalid date (e.g. 30 February) | (empty) |

```html
<form id="kd-form-demo">
  <wa-known-date name="dob" label="Date of birth" required value="2007-03-27"></wa-known-date>
  <br />
  <wa-button type="submit" appearance="filled" variant="neutral">Submit</wa-button>
</form>

<pre id="kd-form-demo-output"></pre>

<style>
  #kd-form-demo-output {
    margin-block-start: 1rem;
    margin-block-end: 0;
    padding: 0.75rem;
    background: var(--wa-color-surface-lowered);
    border-radius: var(--wa-border-radius-m);
    font-size: 0.875em;
  }

  #kd-form-demo-output:empty {
    display: none;
  }
</style>

<script>
  const form = document.getElementById('kd-form-demo');
  const output = document.getElementById('kd-form-demo-output');

  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const entries = Object.fromEntries(data.entries());
    const formatted = JSON.stringify(entries, null, 2);
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
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/known-date/known-date.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/known-date/known-date.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/known-date/known-date.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaKnownDate from '@awesome.me/webawesome/dist/react/known-date/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| \`hint\` | \`hint\` Text that describes how to use the known date. Alternatively, use the attribute. |
| \`label\` | \`label\` The known date's group . Alternatively, use the label attribute. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`WaKnownDateAppearance\` The known date's visual appearance. Type Default 'outlined' | |
| \`autocomplete\` autocomplete | \`bday\` Browser autofill family. When set to , the three fields receive bday-day, bday-month, and bday-year respectively. The field-agnostic directives off and on are applied to all three fields. Any other value is forwarded only to the year field. Type string Default '' | |
| \`defaultValue\` value | \`string\` The default value used for form reset. Type | |
| \`disabled\` disabled | \`boolean\` Disables the known date. Type Default false | |
| \`form\` | \`

\` By default, form controls are associated with the nearest containing element. This attribute allows you to place the form control outside of a form and associate it with the form that has this id. The form must be in the same document or shadow root for this to work. Type HTMLFormElement \\| null | |
| \`hint\` hint | \`hint\` The known date's . If you need to display HTML, use the hint slot instead. Type string Default '' | |
| \`label\` label | \`label\` The known date's . If you need to display HTML, use the label slot instead. Type string Default '' | |
| \`locale\` locale | \`lang\` BCP-47 locale override. When empty, the inherited attribute is used. Type string Default '' | |
| \`max\` max | \`YYYY-MM-DD\` Latest selectable date as . Type string Default '' | |
| \`min\` min | \`YYYY-MM-DD\` Earliest selectable date as . Type string Default '' | |
| \`name\` name | \`string \\| null\` The name submitted with form data. Type Default '' | |
| \`parts\` | \`DateParts\` The three field strings. Stored verbatim so user-typed digits round-trip faithfully. Type Default { ...EMPTY\_PARTS } | |
| \`pill\` pill | \`boolean\` Draws pill-style fields with rounded edges. Type Default false | |
| \`readonly\` readonly | \`boolean\` Makes the fields non-editable. Type Default false | |
| \`required\` required | \`boolean\` Makes the known date required for form submission. Type Default false | |
| \`size\` size | \`WaKnownDateSize \\| 'small' \\| 'medium' \\| 'large'\` The known date's size. Type Default 'm' | |
| \`validationTarget\` | \`display: none\` Anchor native validation popups on a real visible input. The hidden mirror handles form data, but anchoring a popup on content would render it at offset (0, 0). Type undefined \\| HTMLElement | |
| \`validators\` | \`observedAttributes\` Validators are static because they have , essentially attributes to "watch" for changes. Whenever these attributes change, we want to be notified and update the validator. Type Validator\[\] Default \[\] | |
| \`value\` | \`YYYY-MM-DD\` The committed value as an ISO string. The setter also accepts a Date or null. Reading returns an empty string when the value is blank or any field is only partially filled. Type string | |
| \`valueAsDate\` | \`Date\` The committed value as a , or null when the value is empty/invalid. Type Date \\| null | |
| \`valueInput\` | \`HTMLInputElement\` Hidden mirror used for native constraint validation (min/max/required + valid-date roundtrip). Type | |
| \`withHint\` with-hint | \`true\` Only required for SSR. Set to if you're slotting in a hint element. Type boolean Default false | |
| \`withLabel\` with-label | \`true\` Only required for SSR. Set to if you're slotting in a label element. Type boolean Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`blur()\` | Removes focus from the known date. | |
| \`focus()\` | Focuses the first empty field, or the first field when all are filled. | \`options: FocusOptions\` |
| \`formStateRestoreCallback()\` | Called when the browser is trying to restore element’s state to state in which case reason is "restore", or when the browser is trying to fulfill autofill on behalf of user in which case reason is "autocomplete". In the case of "restore", state is a string, File, or FormData object previously set as the second argument to setFormValue. | \`state: string \\| File \\| FormData \\| null\` |
| \`resetValidity()\` | Reset validity is a way of removing manual custom errors and native validation. | |
| \`setCustomValidity()\` | Do not use this when creating a "Validator". This is intended for end users of components. We track manually defined custom errors so we don't clear them on accident in our validators. | \`message: string\` |

### Events

| Name | Description |
| --- | --- |
| \`blur\` | Emitted when the control loses focus. |
| \`change\` | Emitted when the committed value transitions to a new ISO date. |
| \`focus\` | Emitted when the control gains focus. |
| \`input\` | Emitted as the user types in any field. |
| \`wa-invalid\` | Emitted when the form control has been checked for validity and its constraints aren't satisfied. |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`blank\` | The known date has no committed value. | \`:state(blank)\` |
| \`disabled\` | The known date is disabled. | \`:state(disabled)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`field\` | Each field block (label + input). | \`::part(field)\` |
| \`field-day\` | Added to the day field block. | \`::part(field-day)\` |
| \`field-input\` | \`\` The native inside a field. | \`::part(field-input)\` |
| \`field-label\` | The text label above each field's input. | \`::part(field-label)\` |
| \`field-month\` | Added to the month field block. | \`::part(field-month)\` |
| \`field-year\` | Added to the year field block. | \`::part(field-year)\` |
| \`fields\` | The flex row holding the three field blocks. | \`::part(fields)\` |
| \`fieldset\` | \`

\` The element grouping the three fields (or a role="group" div). | \`::part(fieldset)\` |
| \`form-control\` | The form control's outer wrapper. | \`::part(form-control)\` |
| \`form-control-input\` | Alias on the fields row matching other form controls. | \`::part(form-control-input)\` |
| \`form-control-label\` | The wrapper inside the legend that styles the visible label text. | \`::part(form-control-label)\` |
| \`hint\` | The hint's wrapper. | \`::part(hint)\` |
| \`known-date\` | The component's outer wrapper. | \`::part(known-date)\` |
| \`legend\` | \`\` The element (when a label is present). | \`::part(legend)\` |
| \`base\` | \`known-date\` Deprecated. Use the part instead. | \`::part(base)\` |
| \`label\` | \`form-control-label\` Deprecated. Use the part instead. | \`::part(label)\` |

## Examples

### Initial Value

Set the `value` attribute to an ISO date to pre-fill the three fields.

```html
<wa-known-date label="Date of birth" value="1990-04-15"></wa-known-date>
```

### Hint

Use the `hint` attribute (or slot) to show an example value. The hint is associated with each field via `aria-describedby`, so screen readers announce it when any field receives focus.

```html
<wa-known-date label="When was your passport issued?" hint="For example, 27 3 2007"></wa-known-date>
```

### Locale-Aware Field Order

The three fields render in the natural order for the inherited `lang` (or the explicit `locale` attribute). The labels stay the same; only the position changes.

```html
<div class="wa-stack">
  <wa-known-date label="UK order" lang="en-GB"></wa-known-date>
  <wa-known-date label="US order" lang="en-US"></wa-known-date>
  <wa-known-date label="Japanese order" lang="ja-JP"></wa-known-date>
</div>
```

### Min & Max

Constrain the accepted range with `min` and `max`. Values outside the range are reported as invalid.

```html
<wa-known-date label="Birthday" min="1900-01-01" max="2099-12-31"></wa-known-date>
```

### Required

Set `required` to make the date input required for form submission. Like other form controls, validation surfaces through the browser's native constraint validation flow: submitting a form with an empty or partially filled date input prevents submission and shows the browser's validation message. No error appears while the user is simply filling in or tabbing between the fields.

```html
<form>
  <wa-known-date label="Date of birth" required></wa-known-date>
  <br />
  <wa-button type="submit" appearance="filled" variant="neutral">Submit</wa-button>
</form>
```

### Disabled

Use the `disabled` attribute to disable a date field.

```html
<wa-known-date label="Birthday" value="2007-03-27" disabled></wa-known-date>
```

### Readonly

Use the `readonly` attribute to keep a value visible but uneditable. Unlike `disabled`, a readonly date field stays focusable and its value is still submitted with the form.

```html
<wa-known-date label="Member since" value="2007-03-27" readonly></wa-known-date>
```

### Autocomplete

Set `autocomplete="bday"` to enable browser autofill for birthdays. The host expands the family into per-field tokens (`bday-day`, `bday-month`, `bday-year`).

```html
<wa-known-date label="Date of birth" autocomplete="bday"></wa-known-date>
```

### Size

```html
<div class="wa-stack">
  <wa-known-date label="Extra small" size="xs"></wa-known-date>
  <wa-known-date label="Small" size="s"></wa-known-date>
  <wa-known-date label="Medium (default)" size="m"></wa-known-date>
  <wa-known-date label="Large" size="l"></wa-known-date>
  <wa-known-date label="Extra large" size="xl"></wa-known-date>
</div>
```

### Appearance

```html
<div class="wa-stack">
  <wa-known-date label="Outlined (default)" appearance="outlined"></wa-known-date>
  <wa-known-date label="Filled" appearance="filled"></wa-known-date>
  <wa-known-date label="Filled outlined" appearance="filled-outlined"></wa-known-date>
</div>
```

### Pill

Use the `pill` attribute to give each field rounded edges.

```html
<wa-known-date label="Pill" pill></wa-known-date>
```
