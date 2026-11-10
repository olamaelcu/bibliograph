# Select

`<wa-select>`

Stable [Forms](https://webawesome.com/docs/components/?category=forms) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Selects let users choose one or more values from a dropdown list of predefined options. Use them in forms when a fixed set of choices needs to fit in limited space.

```html
<wa-select label="Coffee order" placeholder="How do you take it?">
  <wa-option value="espresso">Espresso</wa-option>
  <wa-option value="latte">Latte</wa-option>
  <wa-option value="cappuccino">Cappuccino</wa-option>
  <wa-option value="cold-brew">Cold brew</wa-option>
  <wa-option value="drip">Drip</wa-option>
</wa-select>
```

```html
<wa-select label="Coffee order" hint="We'll grind it fresh to order." value="latte">
  <wa-icon slot="start" name="mug-hot"></wa-icon>
  <wa-option value="espresso">Espresso</wa-option>
  <wa-option value="latte">Latte</wa-option>
  <wa-option value="cappuccino">Cappuccino</wa-option>
  <wa-option value="cold-brew">Cold brew</wa-option>
  <wa-option value="drip">Drip</wa-option>
</wa-select>
```

This component works with standard `<form>` elements. See [form controls](https://webawesome.com/docs/form-controls) for form submission and client-side validation.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/select/select.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/select/select.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/select/select.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaSelect from '@awesome.me/webawesome/dist/react/select/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | \`\` The listbox options. Must be elements. You can use to group items visually. |
| \`clear-icon\` | An icon to use in lieu of the default clear icon. |
| \`end\` | \`\` An element, such as , placed at the start of the combobox. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`'filled' \\| 'outlined' \\| 'filled-outlined'\` The select's visual appearance. Type Default 'outlined' | |
| \`disabled\` disabled | \`boolean\` Disables the select control. Type Default false | |
| \`form\` | \`

\` By default, form controls are associated with the nearest containing element. This attribute allows you to place the form control outside of a form and associate it with the form that has this id. The form must be in the same document or shadow root for this to work. Type HTMLFormElement \\| null | |
| \`getTag\` | \`(option: WaOption, index: number) => TemplateResult \\| string \\| HTMLElement\` A function that customizes the tags to be rendered when multiple=true. The first argument is the option, the second is the current tag's index. The function should return either a Lit TemplateResult or a string containing trusted HTML of the symbol to render at the specified value. Type | |
| \`hint\` hint | \`hint\` The select's . If you need to display HTML, use the hint slot instead. Type string Default '' | |
| \`label\` label | \`label\` The select's . If you need to display HTML, use the label slot instead. Type string Default '' | |
| \`maxOptionsVisible\` max-options-visible | \`multiple\` The maximum number of selected options to show when is true. After the maximum, "+n" will be shown to indicate the number of additional items that are selected. Set to 0 to remove the limit. Type number Default 3 | |
| \`multiple\` multiple | \`boolean\` Allows more than one option to be selected. Type Default false | |
| \`name\` name | \`string \\| null\` The name of the select, submitted as a name/value pair with form data. Type Default '' | |
| \`open\` open | \`show()\` Indicates whether or not the select is open. You can toggle this attribute to show and hide the menu, or you can use the and hide() methods and this attribute will reflect the select's open state. Type boolean Default false | |
| \`pill\` pill | \`boolean\` Draws a pill-style select with rounded edges. Type Default false | |
| \`placeholder\` placeholder | \`string\` Placeholder text to show as a hint when the select is empty. Type Default '' | |
| \`placement\` placement | \`'top' \\| 'bottom'\` The preferred placement of the select's menu. Note that the actual placement may vary as needed to keep the listbox inside of the viewport. Type Default 'bottom' | |
| \`required\` required | \`boolean\` The select's required attribute. Type Default false | |
| \`size\` size | \`'xs' \\| 's' \\| 'm' \\| 'l' \\| 'xl' \\| 'small' \\| 'medium' \\| 'large'\` The select's size. Type Default 'm' | |
| \`validationTarget\` | \`undefined \\| HTMLElement\` Where to anchor native constraint validation Type | |
| \`validators\` | \`observedAttributes\` Validators are static because they have , essentially attributes to "watch" for changes. Whenever these attributes change, we want to be notified and update the validator. Type Validator\[\] Default \[\] | |
| \`value\` value | The select's value. This will be a string for single select or an array for multi-select. | |
| \`withClear\` with-clear | \`boolean\` Adds a clear button when the select is not empty. Type Default false | |
| \`withHint\` with-hint | \`true\` Only required for SSR. Set to if you're slotting in a hint element so the server-rendered markup includes the hint before the component hydrates on the client. Type boolean Default false | |
| \`withLabel\` with-label | \`true\` Only required for SSR. Set to if you're slotting in a label element so the server-rendered markup includes the label before the component hydrates on the client. Type boolean Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`blur()\` | Removes focus from the control. | |
| \`focus()\` | Sets focus on the control. | \`options: FocusOptions\` |
| \`formStateRestoreCallback()\` | Called when the browser is trying to restore element’s state to state in which case reason is "restore", or when the browser is trying to fulfill autofill on behalf of user in which case reason is "autocomplete". In the case of "restore", state is a string, File, or FormData object previously set as the second argument to setFormValue. | \`state: string \\| File \\| FormData \\| null, reason: 'autocomplete' \\| 'restore'\` |
| \`hide()\` | Hides the listbox. | |
| \`resetValidity()\` | Reset validity is a way of removing manual custom errors and native validation. | |
| \`setCustomValidity()\` | Do not use this when creating a "Validator". This is intended for end users of components. We track manually defined custom errors so we don't clear them on accident in our validators. | \`message: string\` |
| \`show()\` | Shows the listbox. | |

### Events

| Name | Description |
| --- | --- |
| \`blur\` | Emitted when the control loses focus. |
| \`change\` | Emitted when the control's value changes. |
| \`focus\` | Emitted when the control gains focus. |
| \`input\` | Emitted when the control receives input. |
| \`wa-after-hide\` | Emitted after the select's menu closes and all animations are complete. |
| \`wa-after-show\` | Emitted after the select's menu opens and all animations are complete. |
| \`wa-clear\` | Emitted when the control's value is cleared. |
| \`wa-hide\` | Emitted when the select's menu closes. |
| \`wa-invalid\` | Emitted when the form control has been checked for validity and its constraints aren't satisfied. |
| \`wa-show\` | Emitted when the select's menu opens. |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--hide-duration\` | \`var(--wa-transition-fast)\` The duration of the hide animation. Default |
| \`--show-duration\` | \`var(--wa-transition-fast)\` The duration of the show animation. Default |
| \`--tag-max-size\` | \`multiple\` When using , the max size of tags before their content is truncated. Default 10ch |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`blank\` | The select is empty. | \`:state(blank)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`clear-button\` | The clear button. | \`::part(clear-button)\` |
| \`combobox\` | The container the wraps the start, end, value, clear icon, and expand button. | \`::part(combobox)\` |
| \`display-input\` | \`\` The element that displays the selected option's label, an element. | \`::part(display-input)\` |
| \`end\` | \`end\` The container that wraps the slot. | \`::part(end)\` |
| \`expand-icon\` | The container that wraps the expand icon. | \`::part(expand-icon)\` |
| \`form-control\` | The form control that wraps the label, input, and hint. | \`::part(form-control)\` |
| \`form-control-input\` | The select's wrapper. | \`::part(form-control-input)\` |
| \`form-control-label\` | The label. | \`::part(form-control-label)\` |
| \`hint\` | The hint's wrapper. | \`::part(hint)\` |
| \`listbox\` | The listbox container where options are slotted. | \`::part(listbox)\` |
| \`start\` | \`start\` The container that wraps the slot. | \`::part(start)\` |
| \`tag\` | The individual tags that represent each multiselect option. | \`::part(tag)\` |
| \`tag\_\_content\` | The tag's content part. | \`::part(tag\_\_content)\` |
| \`tag\_\_remove-button\` | The tag's remove button. | \`::part(tag\_\_remove-button)\` |
| \`tag\_\_remove-button\_\_base\` | The tag's remove button base part. | \`::part(tag\_\_remove-button\_\_base)\` |
| \`tags\` | \`multiselect\` The container that houses option tags when is used. | \`::part(tags)\` |
| \`label\` | \`form-control-label\` Deprecated. Use the part instead. | \`::part(label)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-button>`](https://webawesome.com/docs/components/button)
-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)
-   [`<wa-option>`](https://webawesome.com/docs/components/option)
-   [`<wa-popup>`](https://webawesome.com/docs/components/popup)
-   [`<wa-spinner>`](https://webawesome.com/docs/components/spinner)
-   [`<wa-tag>`](https://webawesome.com/docs/components/tag)

## Examples

### Label

Use the `label` attribute to give the select an accessible label. For labels that contain HTML, use the `label` slot instead.

```html
<wa-select label="Country">
  <wa-option value="us">United States</wa-option>
  <wa-option value="ca">Canada</wa-option>
  <wa-option value="mx">Mexico</wa-option>
</wa-select>
```

### Hint

Add a descriptive hint with the `hint` attribute. For hints that contain HTML, use the `hint` slot instead.

```html
<wa-select label="Experience" hint="Tell us how comfortable you are with the command line.">
  <wa-option value="1">Novice</wa-option>
  <wa-option value="2">Intermediate</wa-option>
  <wa-option value="3">Advanced</wa-option>
</wa-select>
```

### Placeholder

Use the `placeholder` attribute to show prompt text before a selection is made.

```html
<wa-select placeholder="Select one">
  <wa-option value="option-1">Option 1</wa-option>
  <wa-option value="option-2">Option 2</wa-option>
  <wa-option value="option-3">Option 3</wa-option>
</wa-select>
```

### Initial Value

Use the `selected` attribute on individual options to set the initial selection, just like native HTML.

```html
<wa-select label="Default branch">
  <wa-option value="main" selected>main</wa-option>
  <wa-option value="develop">develop</wa-option>
  <wa-option value="staging">staging</wa-option>
</wa-select>
```

When the `multiple` attribute is present, add `selected` to each option that should start selected.

```html
<wa-select label="Toppings" multiple>
  <wa-option value="mushrooms" selected>Mushrooms</wa-option>
  <wa-option value="olives" selected>Olives</wa-option>
  <wa-option value="peppers">Peppers</wa-option>
  <wa-option value="onions">Onions</wa-option>
</wa-select>
```

Framework users can bind directly to the `value` property for reactive data binding and form state management.

### Appearance

Use the `appearance` attribute to change the select's visual style.

```html
<div class="wa-stack">
  <wa-select appearance="outlined" value="outlined">
    <wa-option value="outlined">outlined</wa-option>
  </wa-select>
  <wa-select appearance="filled" value="filled">
    <wa-option value="filled">filled</wa-option>
  </wa-select>
  <wa-select appearance="filled-outlined" value="filled-outlined">
    <wa-option value="filled-outlined">filled-outlined</wa-option>
  </wa-select>
</div>
```

### Pill

Use the `pill` attribute to give the select rounded edges.

```html
<wa-select pill placeholder="Select one">
  <wa-option value="option-1">Option 1</wa-option>
  <wa-option value="option-2">Option 2</wa-option>
  <wa-option value="option-3">Option 3</wa-option>
</wa-select>
```

### Size

Use the `size` attribute to change a select's size.

```html
<div class="wa-stack">
  <wa-select size="xs" placeholder="Extra small">
    <wa-option value="option-1">Option 1</wa-option>
    <wa-option value="option-2">Option 2</wa-option>
  </wa-select>
  <wa-select size="s" placeholder="Small">
    <wa-option value="option-1">Option 1</wa-option>
    <wa-option value="option-2">Option 2</wa-option>
  </wa-select>
  <wa-select size="m" placeholder="Medium">
    <wa-option value="option-1">Option 1</wa-option>
    <wa-option value="option-2">Option 2</wa-option>
  </wa-select>
  <wa-select size="l" placeholder="Large">
    <wa-option value="option-1">Option 1</wa-option>
    <wa-option value="option-2">Option 2</wa-option>
  </wa-select>
  <wa-select size="xl" placeholder="Extra large">
    <wa-option value="option-1">Option 1</wa-option>
    <wa-option value="option-2">Option 2</wa-option>
  </wa-select>
</div>
```

### Disabled

Use the `disabled` attribute to disable a select.

```html
<wa-select placeholder="Disabled" disabled>
  <wa-option value="option-1">Option 1</wa-option>
  <wa-option value="option-2">Option 2</wa-option>
  <wa-option value="option-3">Option 3</wa-option>
</wa-select>
```

### Clearable

Use the `with-clear` attribute to let people reset their choice. The clear button only appears once an option is selected.

```html
<wa-select with-clear value="option-1">
  <wa-option value="option-1">Option 1</wa-option>
  <wa-option value="option-2">Option 2</wa-option>
  <wa-option value="option-3">Option 3</wa-option>
</wa-select>
```

### Multiple

To let people choose more than one option, add the `multiple` attribute. Pair it with `with-clear` so a long selection is easy to reset.

```html
<wa-select label="Notify me about" multiple with-clear>
  <wa-option value="mentions" selected>Mentions</wa-option>
  <wa-option value="replies" selected>Replies</wa-option>
  <wa-option value="reactions">Reactions</wa-option>
  <wa-option value="follows">New followers</wa-option>
  <wa-option value="releases">Releases</wa-option>
</wa-select>
```

**Multiple selections can grow the control vertically.**  
Use the `max-options-visible` attribute to cap how many tags show at once before the rest collapse into a count.

### Grouping Options

Use [`<wa-divider>`](https://webawesome.com/docs/components/divider) to separate groups of options visually. You can also add `<small>` labels, but note that most assistive technologies won't announce them.

```html
<wa-select label="Add a language" placeholder="Select one">
  <small>Frontend</small>
  <wa-option value="ts">TypeScript</wa-option>
  <wa-option value="css">CSS</wa-option>
  <wa-divider></wa-divider>
  <small>Backend</small>
  <wa-option value="go">Go</wa-option>
  <wa-option value="rust">Rust</wa-option>
  <wa-option value="python">Python</wa-option>
</wa-select>
```

### Placement

Set the `placement` attribute to control where the listbox opens. Valid placements are `bottom` (default) and `top`; the actual position may flip to keep the panel in the viewport.

```html
<wa-select placement="top" placeholder="Opens upward">
  <wa-option value="option-1">Option 1</wa-option>
  <wa-option value="option-2">Option 2</wa-option>
  <wa-option value="option-3">Option 3</wa-option>
</wa-select>
```

### Start & End Decorations

Use the `start` and `end` slots to add presentational elements such as [`<wa-icon>`](https://webawesome.com/docs/components/icon) inside the combobox.

```html
<wa-select label="Destination" placeholder="Where to?" with-clear>
  <wa-icon slot="start" name="plane-departure" variant="solid"></wa-icon>
  <wa-option value="lax">Los Angeles</wa-option>
  <wa-option value="jfk">New York</wa-option>
  <wa-option value="nrt">Tokyo</wa-option>
</wa-select>
```

### Custom Tags

When multiple options can be selected, supply custom tags by passing a function to the `getTag` property. The function runs for each selected option and can return a string of HTML, a [Lit template](https://lit.dev/docs/templates/overview/), or an [`HTMLElement`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement). Its first argument is the [`<wa-option>`](https://webawesome.com/docs/components/option) element and its second is the tag's index.

Because custom tags render in a shadow root, style them with the `style` attribute in your template, or add your own [parts](https://webawesome.com/docs/usage/#css-parts) and target them with [`::part()`](https://developer.mozilla.org/en-US/docs/Web/CSS/::part).

```html
<wa-select placeholder="Select one" multiple with-clear class="custom-tag">
  <wa-option value="email" selected>
    <wa-icon slot="start" name="envelope" variant="solid"></wa-icon>
    Email
  </wa-option>
  <wa-option value="phone" selected>
    <wa-icon slot="start" name="phone" variant="solid"></wa-icon>
    Phone
  </wa-option>
  <wa-option value="chat">
    <wa-icon slot="start" name="comment" variant="solid"></wa-icon>
    Chat
  </wa-option>
</wa-select>

<script type="module">
  await customElements.whenDefined('wa-select');
  const select = document.querySelector('.custom-tag');
  await select.updateComplete;

  select.getTag = (option, index) => {
    // Reuse the icon from the matching wa-option
    const name = option.querySelector('wa-icon[slot="start"]').name;

    // Return a string, a Lit Template, or an HTMLElement.
    // Include data-value so the tag can be removed properly.
    return `
      <wa-tag with-remove data-value="${option.value}">
        <wa-icon name="${name}"></wa-icon>
        ${option.label}
      </wa-tag>
    `;
  };
</script>
```

**Only pass content you trust to `getTag()`.**  
Unsanitized user input rendered into a tag can result in XSS vulnerabilities.

When using custom tags with `with-remove`, include the `data-value` attribute set to the option's value so the select knows which option to deselect when the tag's remove button is clicked.

### Lazy Loading Options

The select handles options that arrive after the initial render, similar to a native `<select>`:

-   **Empty select with a value:** a `<wa-select>` created without options but given a `value` starts with an empty value. When an option whose value matches is added later, the select updates to match.
-   **Multiple select with partial options:** a `<wa-select multiple>` with an initial value respects only the options present in the DOM. When the remaining selected options load later — and the user hasn't changed the selection — they're added automatically.

```html
<form id="lazy-options-example">
  <div>
    <wa-select name="select-1" value="foo" label="Single select (with existing options)">
      <wa-option value="bar">Bar</wa-option>
      <wa-option value="baz">Baz</wa-option>
    </wa-select>

    <wa-divider></wa-divider>

    <wa-button appearance="filled" type="button">Add "foo" option</wa-button>
  </div>

  <br />

  <div>
    <wa-select name="select-2" value="foo" label="Single select (with no existing options)"> </wa-select>

    <wa-divider></wa-divider>

    <wa-button appearance="filled" type="button">Add "foo" option</wa-button>
  </div>

  <br />

  <div>
    <wa-select name="select-3" multiple label="Multiple select (with existing selected options)">
      <wa-option value="bar" selected>Bar</wa-option>
      <wa-option value="baz" selected>Baz</wa-option>
    </wa-select>

    <wa-divider></wa-divider>

    <wa-button appearance="filled" type="button">Add "foo" option (selected)</wa-button>
  </div>

  <br />

  <div>
    <wa-select name="select-4" value="foo" multiple label="Multiple select (with no existing options)"> </wa-select>

    <wa-divider></wa-divider>

    <wa-button appearance="filled" type="button">Add "foo" option</wa-button>
  </div>

  <br /><br />

  <div style="display: flex; gap: 16px;">
    <wa-button appearance="filled" type="reset">Reset</wa-button>
    <wa-button appearance="filled" type="submit" variant="neutral">Show FormData</wa-button>
  </div>

  <br />

  <pre hidden><code id="lazy-options-example-form-data"></code></pre>

  <br />
</form>

<script type="module">
  function addFooOption(e) {
    const addFooButton = e.target.closest("wa-button[type='button']");
    if (!addFooButton) {
      return;
    }
    const select = addFooButton.parentElement.querySelector('wa-select');

    if (select.querySelector("wa-option[value='foo']")) {
      // Foo already exists. no-op.
      return;
    }

    const option = document.createElement('wa-option');
    option.setAttribute('value', 'foo');
    option.selected = true;
    option.innerText = 'Foo';

    // For the multiple select with existing selected options, make the new option selected
    if (select.getAttribute('name') === 'select-3') {
      option.selected = true;
    }

    select.append(option);
  }

  function handleLazySubmit(event) {
    event.preventDefault();

    const formData = new FormData(event.target);
    const codeElement = document.querySelector('#lazy-options-example-form-data');

    const obj = {};
    for (const key of formData.keys()) {
      const val = formData.getAll(key).length > 1 ? formData.getAll(key) : formData.get(key);
      obj[key] = val;
    }

    codeElement.textContent = JSON.stringify(obj, null, 2);

    const preElement = codeElement.parentElement;
    preElement.removeAttribute('hidden');
  }

  const container = document.querySelector('#lazy-options-example');
  container.addEventListener('click', addFooOption);
  container.addEventListener('submit', handleLazySubmit);
</script>
```

Throughout, the select prioritizes user interactions and explicit selections over programmatic changes, keeping behavior predictable even with dynamically loaded content.
