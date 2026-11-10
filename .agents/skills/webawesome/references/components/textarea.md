# Textarea

`<wa-textarea>`

Stable [Forms](https://webawesome.com/docs/components/?category=forms) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Textareas collect multi-line text input from the user, with optional resizing and character counting.

```html
<wa-textarea label="Feedback"></wa-textarea>
```

This component works with standard `<form>` elements. See [form controls](https://webawesome.com/docs/form-controls) for form submission and client-side validation.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/textarea/textarea.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/textarea/textarea.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaTextarea from '@awesome.me/webawesome/dist/react/textarea/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| \`hint\` | \`hint\` Text that describes how to use the input. Alternatively, you can use the attribute. |
| \`label\` | \`label\` The textarea's . Alternatively, you can use the label attribute. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`'filled' \\| 'outlined' \\| 'filled-outlined'\` The textarea's visual appearance. Type Default 'outlined' | |
| \`autocapitalize\` autocapitalize | \`'off' \\| 'none' \\| 'on' \\| 'sentences' \\| 'words' \\| 'characters'\` Controls whether and how text input is automatically capitalized as it is entered by the user. Type | |
| \`autocomplete\` autocomplete | \`string\` Specifies what permission the browser has to provide assistance in filling out form field values. Refer to this page on MDN for available values. Type | |
| \`autocorrect\` autocorrect | \`"off"\` Indicates whether the browser's autocorrect feature is on or off. When set as an attribute, use or "on". When set as a property, use true or false. Type boolean | |
| \`autofocus\` autofocus | \`boolean\` Indicates that the input should receive focus on page load. Type | |
| \`defaultValue\` value | \`string\` The default value of the form control. Primarily used for resetting the form control. Type | |
| \`disabled\` disabled | \`boolean\` Disables the textarea. Type Default false | |
| \`enterkeyhint\` enterkeyhint | \`'enter' \\| 'done' \\| 'go' \\| 'next' \\| 'previous' \\| 'search' \\| 'send'\` Used to customize the label or icon of the Enter key on virtual keyboards. Type | |
| \`form\` | \`

\` By default, form controls are associated with the nearest containing element. This attribute allows you to place the form control outside of a form and associate it with the form that has this id. The form must be in the same document or shadow root for this to work. Type HTMLFormElement \\| null | |
| \`hint\` hint | \`hint\` The textarea's . If you need to display HTML, use the hint slot instead. Type string Default '' | |
| \`inputmode\` inputmode | \`'none' \\| 'text' \\| 'decimal' \\| 'numeric' \\| 'tel' \\| 'search' \\| 'email' \\| 'url'\` Tells the browser what type of data will be entered by the user, allowing it to display the appropriate virtual keyboard on supportive devices. Type | |
| \`label\` label | \`label\` The textarea's . If you need to display HTML, use the label slot instead. Type string Default '' | |
| \`maxlength\` maxlength | \`number\` The maximum length of input that will be considered valid. Type | |
| \`minlength\` minlength | \`number\` The minimum length of input that will be considered valid. Type | |
| \`name\` name | \`string \\| null\` The name of the textarea, submitted as a name/value pair with form data. Type Default null | |
| \`placeholder\` placeholder | \`string\` Placeholder text to show as a hint when the input is empty. Type Default '' | |
| \`readonly\` readonly | \`boolean\` Makes the textarea readonly. Type Default false | |
| \`required\` required | \`boolean\` Makes the textarea a required field. Type Default false | |
| \`resize\` resize | \`'none' \\| 'vertical' \\| 'horizontal' \\| 'both' \\| 'auto'\` Controls how the textarea can be resized. Type Default 'vertical' | |
| \`rows\` rows | \`number\` The of rows to display by default. Type number Default 4 | |
| \`size\` size | \`'xs' \\| 's' \\| 'm' \\| 'l' \\| 'xl' \\| 'small' \\| 'medium' \\| 'large'\` The textarea's size. Type Default 'm' | |
| \`spellcheck\` spellcheck | \`boolean\` Enables spell checking on the textarea. Type Default true | |
| \`validationTarget\` | \`undefined \\| HTMLElement\` Override this to change where constraint validation popups are anchored. Type | |
| \`validators\` | \`observedAttributes\` Validators are static because they have , essentially attributes to "watch" for changes. Whenever these attributes change, we want to be notified and update the validator. Type Validator\[\] Default \[\] | |
| \`value\` | The current value of the input, submitted as a name/value pair with form data. | |
| \`withCount\` with-count | \`maxlength\` Shows a character count below the textarea. When is set, shows remaining characters instead. Type boolean Default false | |
| \`withHint\` with-hint | \`true\` Only required for SSR. Set to if you're slotting in a hint element so the server-rendered markup includes the hint before the component hydrates on the client. Type boolean Default false | |
| \`withLabel\` with-label | \`true\` Only required for SSR. Set to if you're slotting in a label element so the server-rendered markup includes the label before the component hydrates on the client. Type boolean Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`blur()\` | Removes focus from the textarea. | |
| \`focus()\` | Sets focus on the textarea. | \`options: FocusOptions\` |
| \`formStateRestoreCallback()\` | Called when the browser is trying to restore element’s state to state in which case reason is "restore", or when the browser is trying to fulfill autofill on behalf of user in which case reason is "autocomplete". In the case of "restore", state is a string, File, or FormData object previously set as the second argument to setFormValue. | \`state: string \\| File \\| FormData \\| null, reason: 'autocomplete' \\| 'restore'\` |
| \`resetValidity()\` | Reset validity is a way of removing manual custom errors and native validation. | |
| \`scrollPosition()\` | Gets or sets the textarea's scroll position. | \`position: { top?: number; left?: number }\` |
| \`select()\` | Selects all the text in the textarea. | |
| \`setCustomValidity()\` | Do not use this when creating a "Validator". This is intended for end users of components. We track manually defined custom errors so we don't clear them on accident in our validators. | \`message: string\` |
| \`setRangeText()\` | Replaces a range of text with a new string. | \`replacement: string, start: number, end: number, selectMode: 'select' \\| 'start' \\| 'end' \\| 'preserve'\` |
| \`setSelectionRange()\` | Sets the start and end positions of the text selection (0-based). | \`selectionStart: number, selectionEnd: number, selectionDirection: 'forward' \\| 'backward' \\| 'none'\` |

### Events

| Name | Description |
| --- | --- |
| \`blur\` | Emitted when the control loses focus. |
| \`change\` | Emitted when an alteration to the control's value is committed by the user. |
| \`focus\` | Emitted when the control gains focus. |
| \`input\` | Emitted when the control receives input. |
| \`wa-invalid\` | Emitted when the form control has been checked for validity and its constraints aren't satisfied. |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`blank\` | The textarea is empty. | \`:state(blank)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`count\` | \`with-count\` The character count element, rendered when the attribute is present. | \`::part(count)\` |
| \`form-control-label\` | The label. | \`::part(form-control-label)\` |
| \`hint\` | The hint's wrapper. | \`::part(hint)\` |
| \`textarea\` | \`\` The internal control. | \`::part(textarea)\` |
| \`textarea-adjuster\` | \`resize\` The invisible sizer that grows the control to fit its content when is auto. | \`::part(textarea-adjuster)\` |
| \`textarea-wrapper\` | The component's outer wrapper. | \`::part(textarea-wrapper)\` |
| \`base\` | \`textarea-wrapper\` Deprecated. Use the part instead. | \`::part(base)\` |
| \`label\` | \`form-control-label\` Deprecated. Use the part instead. | \`::part(label)\` |

## Examples

### Label

Use the `label` attribute to give the textarea an accessible label. For labels that contain HTML, use the `label` slot instead.

```html
<wa-textarea label="Comments"></wa-textarea>
```

### Hint

Add a descriptive hint to a textarea with the `hint` attribute. For hints that contain HTML, use the `hint` slot instead.

```html
<wa-textarea label="Feedback" hint="Please tell us what you think."></wa-textarea>
```

### Placeholder

Use the `placeholder` attribute to add a placeholder.

```html
<wa-textarea label="Comments" placeholder="Share your thoughts"></wa-textarea>
```

### Appearance

Use the `appearance` attribute to change the textarea's visual appearance.

```html
<div class="wa-stack">
  <wa-textarea appearance="outlined" placeholder="outlined"></wa-textarea>
  <wa-textarea appearance="filled" placeholder="filled"></wa-textarea>
  <wa-textarea appearance="filled-outlined" placeholder="filled-outlined"></wa-textarea>
</div>
```

### Disabled

Use the `disabled` attribute to disable a textarea.

```html
<wa-textarea placeholder="Disabled" disabled></wa-textarea>
```

### Readonly

Use the `readonly` attribute to keep a value visible but uneditable. Unlike `disabled`, a readonly textarea stays focusable and its value is still submitted with the form.

```html
<wa-textarea label="Release notes" value="Fixed a handful of bugs and polished the edges." readonly></wa-textarea>
```

### Size

Use the `size` attribute to change a textarea's size.

```html
<div class="wa-stack">
  <wa-textarea size="xs" placeholder="Extra small"></wa-textarea>
  <wa-textarea size="s" placeholder="Small"></wa-textarea>
  <wa-textarea size="m" placeholder="Medium"></wa-textarea>
  <wa-textarea size="l" placeholder="Large"></wa-textarea>
  <wa-textarea size="xl" placeholder="Extra large"></wa-textarea>
</div>
```

### Rows

Use the `rows` attribute to change the number of text rows that show by default.

```html
<wa-textarea rows="2"></wa-textarea>
```

### Resize

Use the `resize` attribute to control how the user can resize the textarea.

| Mode | Behavior | Best for |
| --- | --- | --- |
| \`vertical\` (default) | Drag the bottom edge to change the height | Most multi-line fields |
| \`none\` | Resizing is disabled | Fixed layouts where height must hold |
| \`horizontal\` | Drag the side edge to change the width | Adjusting line length |
| \`both\` | Drag the corner to change width and height | Free-form editing |
| \`auto\` | Grows to fit its content as the user types | Inputs whose length varies a lot |

The default, `vertical`, lets the user drag the bottom edge to resize the field.

```html
<wa-textarea label="Feedback" resize="vertical"></wa-textarea>
```

Set `resize` to `auto` and the textarea grows to fit its content as the user types.

```html
<wa-textarea label="Comments" resize="auto"></wa-textarea>
```

### Character Count

Add the `with-count` attribute to show a character count below the textarea. When combined with `maxlength`, the count shows remaining characters instead.

```html
<div class="wa-stack">
  <wa-textarea label="Comments" hint="Share your thoughts with us" with-count></wa-textarea>
  <wa-textarea label="Bio" hint="Tell us a little about yourself" with-count maxlength="100"></wa-textarea>
</div>
```

**The character count is announced to screen readers.**  
It's exposed through a live region so assistive technologies announce updates as the user types.

### Initial Value

Use the `value` attribute to set an initial value.

```html
<wa-textarea value="Write something awesome!"></wa-textarea>
```
