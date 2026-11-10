# Radio Group

`<wa-radio-group>`

Stable [Forms](https://webawesome.com/docs/components/?category=forms) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Radio groups wrap a set of radios so they function as a single form control with one shared value. They handle keyboard navigation, labeling, and validation for the group as a whole.

```html
<wa-radio-group label="Coffee roast" name="roast" value="medium">
  <wa-radio value="light">Light roast</wa-radio>
  <wa-radio value="medium">Medium roast</wa-radio>
  <wa-radio value="dark">Dark roast</wa-radio>
</wa-radio-group>
```

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/radio-group/radio-group.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/radio-group/radio-group.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaRadioGroup from '@awesome.me/webawesome/dist/react/radio-group/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | \`\` The default slot where elements are placed. |
| \`hint\` | \`hint\` Text that describes how to use the radio group. Alternatively, you can use the attribute. |
| \`label\` | \`label\` The radio group's . Required for proper accessibility. Alternatively, you can use the label attribute. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`defaultValue\` value | \`string \\| null\` The default value of the form control. Primarily used for resetting the form control. Type | |
| \`disabled\` disabled | \`boolean\` Disables the radio group and all child radios. Type Default false | |
| \`form\` | \`

\` By default, form controls are associated with the nearest containing element. This attribute allows you to place the form control outside of a form and associate it with the form that has this id. The form must be in the same document or shadow root for this to work. Type HTMLFormElement \\| null | |
| \`hint\` hint | \`hint\` The radio groups's . If you need to display HTML, use the hint slot instead. Type string Default '' | |
| \`label\` label | \`label\` The radio group's . Required for proper accessibility. If you need to display HTML, use the label slot instead. Type string Default '' | |
| \`name\` name | \`string \\| null\` The name of the radio group, submitted as a name/value pair with form data. Type Default null | |
| \`orientation\` orientation | \`'horizontal' \\| 'vertical'\` The orientation in which to show radio items. Type Default 'vertical' | |
| \`required\` required | \`boolean\` Ensures a child radio is checked before allowing the containing form to submit. Type Default false | |
| \`size\` size | \`\` The radio group's size. When present, this size will be applied to all items inside. Type 'xs' \\| 's' \\| 'm' \\| 'l' \\| 'xl' \\| 'small' \\| 'medium' \\| 'large' | |
| \`validationTarget\` | \`undefined \\| HTMLElement\` We use the first available radio as the validationTarget similar to native HTML that shows the validation popup on the first radio element. Type | |
| \`validators\` | \`observedAttributes\` Validators are static because they have , essentially attributes to "watch" for changes. Whenever these attributes change, we want to be notified and update the validator. Type Validator\[\] Default \[\] | |
| \`value\` | The current value of the radio group, submitted as a name/value pair with form data. | |
| \`withHint\` with-hint | \`true\` Only required for SSR. Set to if you're slotting in a hint element so the server-rendered markup includes the hint before the component hydrates on the client. Type boolean Default false | |
| \`withLabel\` with-label | \`true\` Only required for SSR. Set to if you're slotting in a label element so the server-rendered markup includes the label before the component hydrates on the client. Type boolean Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`focus()\` | Sets focus on the radio group. | \`options: FocusOptions\` |
| \`formStateRestoreCallback()\` | Called when the browser is trying to restore element’s state to state in which case reason is "restore", or when the browser is trying to fulfill autofill on behalf of user in which case reason is "autocomplete". In the case of "restore", state is a string, File, or FormData object previously set as the second argument to setFormValue. | \`state: string \\| File \\| FormData \\| null, reason: 'autocomplete' \\| 'restore'\` |
| \`resetValidity()\` | Reset validity is a way of removing manual custom errors and native validation. | |
| \`setCustomValidity()\` | Do not use this when creating a "Validator". This is intended for end users of components. We track manually defined custom errors so we don't clear them on accident in our validators. | \`message: string\` |

### Events

| Name | Description |
| --- | --- |
| \`change\` | Emitted when the radio group's selected value changes. |
| \`input\` | Emitted when the radio group receives user input. |
| \`wa-invalid\` | Emitted when the form control has been checked for validity and its constraints aren't satisfied. |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`form-control\` | The form control that wraps the label, input, and hint. | \`::part(form-control)\` |
| \`form-control-input\` | The element that wraps the grouped radios, styled as a flex container by default. | \`::part(form-control-input)\` |
| \`form-control-label\` | The label. | \`::part(form-control-label)\` |
| \`hint\` | The hint's wrapper. | \`::part(hint)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)
-   [`<wa-radio>`](https://webawesome.com/docs/components/radio)

## Examples

### Initial Value

Use the `value` attribute on the radio group to set the initially selected radio. Match it to the `value` of the radio that should start checked, just like native HTML.

```html
<wa-radio-group label="Coffee roast" name="roast" value="dark">
  <wa-radio value="light">Light roast</wa-radio>
  <wa-radio value="medium">Medium roast</wa-radio>
  <wa-radio value="dark">Dark roast</wa-radio>
</wa-radio-group>
```

To target checked radios with CSS, use the `:state(checked)` selector.

### Hint

Add descriptive hint to a radio group with the `hint` attribute. For hints that contain HTML, use the `hint` slot instead.

```html
<wa-radio-group label="Coffee roast" hint="Pick the roast we'll grind for your order." name="roast" value="medium">
  <wa-radio value="light">Light roast</wa-radio>
  <wa-radio value="medium">Medium roast</wa-radio>
  <wa-radio value="dark">Dark roast</wa-radio>
</wa-radio-group>
```

### Radio Buttons

Set the `appearance` attribute to `button` on all radios to render a radio button group.

```html
<div class="wa-stack">
  <wa-radio-group
    label="Color scheme"
    hint="Choose how the interface should appear."
    orientation="horizontal"
    name="scheme"
    value="auto"
  >
    <wa-radio appearance="button" value="light">Light</wa-radio>
    <wa-radio appearance="button" value="dark">Dark</wa-radio>
    <wa-radio appearance="button" value="auto">Auto</wa-radio>
  </wa-radio-group>

  <wa-radio-group
    label="Color scheme"
    hint="Choose how the interface should appear."
    orientation="vertical"
    name="scheme"
    value="auto"
    style="max-width: 300px;"
  >
    <wa-radio appearance="button" value="light">Light</wa-radio>
    <wa-radio appearance="button" value="dark">Dark</wa-radio>
    <wa-radio appearance="button" value="auto">Auto</wa-radio>
  </wa-radio-group>
</div>
```

### Disabled

To disable the entire radio group, add the `disabled` attribute to the radio group.

```html
<wa-radio-group label="Shipping speed" disabled>
  <wa-radio value="standard">Standard</wa-radio>
  <wa-radio value="express">Express</wa-radio>
  <wa-radio value="overnight">Overnight</wa-radio>
</wa-radio-group>
```

To disable individual options, add the `disabled` attribute to the respective options.

```html
<wa-radio-group label="Shipping speed">
  <wa-radio value="standard">Standard</wa-radio>
  <wa-radio value="express">Express</wa-radio>
  <wa-radio value="overnight" disabled>Overnight</wa-radio>
</wa-radio-group>
```

### Orientation

The default orientation for radio items is `vertical`. Set the `orientation` to `horizontal` to lay items out on the same row.

```html
<wa-radio-group
  label="Shipping speed"
  hint="Choose how fast you'd like your order."
  orientation="horizontal"
  name="shipping"
  value="standard"
>
  <wa-radio value="standard">Standard</wa-radio>
  <wa-radio value="express">Express</wa-radio>
  <wa-radio value="overnight">Overnight</wa-radio>
</wa-radio-group>
```

### Size

The size of radios will be determined by the Radio Group's `size` attribute.

```html
<div class="wa-stack">
  <wa-radio-group label="Extra small" size="xs" value="medium">
    <wa-radio value="light">Light roast</wa-radio>
    <wa-radio value="medium">Medium roast</wa-radio>
    <wa-radio value="dark">Dark roast</wa-radio>
  </wa-radio-group>
  <wa-radio-group label="Small" size="s" value="medium">
    <wa-radio value="light">Light roast</wa-radio>
    <wa-radio value="medium">Medium roast</wa-radio>
    <wa-radio value="dark">Dark roast</wa-radio>
  </wa-radio-group>
  <wa-radio-group label="Medium" size="m" value="medium">
    <wa-radio value="light">Light roast</wa-radio>
    <wa-radio value="medium">Medium roast</wa-radio>
    <wa-radio value="dark">Dark roast</wa-radio>
  </wa-radio-group>
  <wa-radio-group label="Large" size="l" value="dark">
    <wa-radio value="light">Light roast</wa-radio>
    <wa-radio value="medium">Medium roast</wa-radio>
    <wa-radio value="dark">Dark roast</wa-radio>
  </wa-radio-group>
  <wa-radio-group label="Extra large" size="xl" value="dark">
    <wa-radio value="light">Light roast</wa-radio>
    <wa-radio value="medium">Medium roast</wa-radio>
    <wa-radio value="dark">Dark roast</wa-radio>
  </wa-radio-group>
</div>
```

If you need to have radios of varying sizes, place the `size` attribute on individual radio items instead.

```html
<wa-radio-group label="Mixed sizes" value="m">
  <wa-radio value="xs" size="xs">Extra Small</wa-radio>
  <wa-radio value="s" size="s">Small</wa-radio>
  <wa-radio value="m" size="m">Medium</wa-radio>
  <wa-radio value="l" size="l">Large</wa-radio>
  <wa-radio value="xl" size="xl">Extra Large</wa-radio>
</wa-radio-group>
```

### Validation

Set the `required` attribute to make selecting an option mandatory. If a value has not been selected, it will prevent the form from submitting and display an error message.

```html
<form class="validation">
  <wa-radio-group label="Coffee roast" name="roast" required>
    <wa-radio value="light">Light roast</wa-radio>
    <wa-radio value="medium">Medium roast</wa-radio>
    <wa-radio value="dark">Dark roast</wa-radio>
  </wa-radio-group>
  <br />
  <wa-button appearance="filled" type="submit" variant="neutral">Submit</wa-button>
</form>

<script>
  const form = document.querySelector('.validation');

  // Handle form submit
  form.addEventListener('submit', event => {
    event.preventDefault();
    alert('All fields are valid!');
  });
</script>
```

### Custom Validity

Use the `setCustomValidity()` method to set a custom validation message. This will prevent the form from submitting and make the browser display the error message you provide. To clear the error, call this function with an empty string.

```html
<form class="custom-validity">
  <wa-radio-group label="Coffee roast" name="roast" value="light">
    <wa-radio value="light">Light roast</wa-radio>
    <wa-radio value="medium">Medium roast</wa-radio>
    <wa-radio value="dark">Dark roast</wa-radio>
  </wa-radio-group>
  <br />
  <wa-button appearance="filled" type="submit" variant="neutral">Submit</wa-button>
</form>

<script>
  const form = document.querySelector('.custom-validity');
  const radioGroup = form.querySelector('wa-radio-group');
  const errorMessage = 'Sorry, we only have dark roast today';

  // Set initial validity as soon as the element is defined
  customElements.whenDefined('wa-radio-group').then(() => {
    radioGroup.setCustomValidity(errorMessage);
  });

  // Update validity when a selection is made
  form.addEventListener('change', () => {
    const isValid = radioGroup.value === 'dark';
    radioGroup.setCustomValidity(isValid ? '' : errorMessage);
  });

  // Handle form submit
  form.addEventListener('submit', event => {
    event.preventDefault();
    alert('All fields are valid!');
  });
</script>
```
