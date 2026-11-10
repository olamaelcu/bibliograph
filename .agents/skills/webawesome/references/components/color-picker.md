# Color Picker

`<wa-color-picker>`

Stable [Forms](https://webawesome.com/docs/components/?category=forms) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Color pickers let users choose a color from a visual palette or by entering a value. They support HEX, RGB, HSL, and HSV formats with optional alpha channel and swatch presets.

```html
<wa-color-picker label="Select a color"></wa-color-picker>
```

This component works with standard `<form>` elements. See [form controls](https://webawesome.com/docs/form-controls) for form submission and client-side validation.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/color-picker/color-picker.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/color-picker/color-picker.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/color-picker/color-picker.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaColorPicker from '@awesome.me/webawesome/dist/react/color-picker/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| \`hint\` | \`hint\` The color picker's form . Alternatively, you can use the hint attribute. |
| \`label\` | \`label\` The color picker's form . Alternatively, you can use the label attribute. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`defaultValue\` value | \`string \\| null\` The default value of the form control. Primarily used for resetting the form control. Type | |
| \`disabled\` disabled | \`boolean\` Disables the color picker. Type Default false | |
| \`form\` | \`

\` By default, form controls are associated with the nearest containing element. This attribute allows you to place the form control outside of a form and associate it with the form that has this id. The form must be in the same document or shadow root for this to work. Type HTMLFormElement \\| null | |
| \`format\` format | \`'hex' \\| 'rgb' \\| 'hsl' \\| 'hsv'\` The format to use. If opacity is enabled, these will translate to HEXA, RGBA, HSLA, and HSVA respectively. The color picker will accept user input in any format (including CSS color names) and convert it to the desired format. Type Default 'hex' | |
| \`hint\` hint | \`hint\` The color picker's . If you need to display HTML, use the hint slot instead. Type string Default '' | |
| \`label\` label | \`label\` The color picker's . This will not be displayed, but it will be announced by assistive devices. If you need to display HTML, you can use the label slot\` instead. Type string Default '' | |
| \`name\` name | \`string \\| null\` The name of the form control, submitted as a name/value pair with form data. Type Default null | |
| \`opacity\` opacity | \`boolean\` Shows the opacity slider. Enabling this will cause the formatted value to be HEXA, RGBA, or HSLA. Type Default false | |
| \`open\` open | \`show()\` Indicates whether or not the popup is open. You can toggle this attribute to show and hide the popup, or you can use the and hide() methods and this attribute will reflect the popup's open state. Type boolean Default false | |
| \`placement\` placement | \`'top' \\| 'top-start' \\| 'top-end' \\| 'bottom' \\| 'bottom-start' \\| 'bottom-end' \\| 'right' \\| 'right-start' \\| 'right-end' \\| 'left' \\| 'left-start' \\| 'left-end'\` The preferred placement of the color picker's popup. Note that the actual placement will vary as configured to keep the panel inside of the viewport. Type Default 'bottom-start' | |
| \`required\` required | \`boolean\` Makes the color picker a required field. Type Default false | |
| \`size\` size | \`'xs' \\| 's' \\| 'm' \\| 'l' \\| 'xl' \\| 'small' \\| 'medium' \\| 'large'\` Determines the size of the color picker's trigger Type Default 'm' | |
| \`swatches\` swatches | \`;\` One or more predefined color swatches to display as presets in the color picker. Can include any format the color picker can parse, including HEX(A), RGB(A), HSL(A), HSV(A), and CSS color names. Each color must be separated by a semicolon (). Alternatively, you can pass an array of color values or an array of { color, label } objects to this property using JavaScript. When using objects with labels, the label will be used for the swatch's accessible name instead of the raw color value. Type string \\| string\[\] \\| WaColorPickerSwatch\[\] Default '' | |
| \`uppercase\` uppercase | \`boolean\` By default, values are lowercase. With this attribute, values will be uppercase instead. Type Default false | |
| \`validationTarget\` | \`undefined \\| HTMLElement\` Override this to change where constraint validation popups are anchored. Type | |
| \`validators\` | \`observedAttributes\` Validators are static because they have , essentially attributes to "watch" for changes. Whenever these attributes change, we want to be notified and update the validator. Type Validator\[\] Default \[\] | |
| \`value\` | \`format\` The current value of the color picker. The value's will vary based the format attribute. To get the value in a specific format, use the getFormattedValue() method. The value is submitted as a name/value pair with form data. | |
| \`withHint\` with-hint | \`true\` Only required for SSR. Set to if you're slotting in a hint element so the server-rendered markup includes the hint before the component hydrates on the client. Type boolean Default false | |
| \`withLabel\` with-label | \`true\` Only required for SSR. Set to if you're slotting in a label element so the server-rendered markup includes the label before the component hydrates on the client. Type boolean Default false | |
| \`withoutFormatToggle\` without-format-toggle | \`boolean\` Removes the button that lets users toggle between format. Type Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`blur()\` | Removes focus from the color picker. | |
| \`focus()\` | Sets focus on the color picker. | \`options: FocusOptions\` |
| \`formStateRestoreCallback()\` | Called when the browser is trying to restore element’s state to state in which case reason is "restore", or when the browser is trying to fulfill autofill on behalf of user in which case reason is "autocomplete". In the case of "restore", state is a string, File, or FormData object previously set as the second argument to setFormValue. | \`state: string \\| File \\| FormData \\| null, reason: 'autocomplete' \\| 'restore'\` |
| \`getFormattedValue()\` | Returns the current value as a string in the specified format. | \`format: 'hex' \\| 'hexa' \\| 'rgb' \\| 'rgba' \\| 'hsl' \\| 'hsla' \\| 'hsv' \\| 'hsva'\` |
| \`getHexString()\` | Generates a hex string from HSV values. Hue must be 0-360. All other arguments must be 0-100. | \`hue: number, saturation: number, brightness: number, alpha:\` |
| \`hide()\` | Hides the color picker panel | |
| \`reportValidity()\` | Checks for validity and shows the browser's validation message if the control is invalid. | |
| \`resetValidity()\` | Reset validity is a way of removing manual custom errors and native validation. | |
| \`setCustomValidity()\` | Do not use this when creating a "Validator". This is intended for end users of components. We track manually defined custom errors so we don't clear them on accident in our validators. | \`message: string\` |
| \`show()\` | Shows the color picker panel. | |

### Events

| Name | Description |
| --- | --- |
| \`blur\` | Emitted when the color picker loses focus. |
| \`change\` | Emitted when the color picker's value changes. |
| \`focus\` | Emitted when the color picker receives focus. |
| \`input\` | Emitted when the color picker receives input. |
| \`wa-after-hide\` | |
| \`wa-after-show\` | |
| \`wa-hide\` | |
| \`wa-invalid\` | Emitted when the form control has been checked for validity and its constraints aren't satisfied. |
| \`wa-show\` | |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--grid-handle-size\` | The size of the color grid's handle. |
| \`--grid-height\` | The height of the color grid. |
| \`--grid-width\` | The width of the color grid. |
| \`--slider-handle-size\` | The diameter of the slider's handle. |
| \`--slider-height\` | The height of the hue and alpha sliders. |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`color-picker\` | The dropdown panel that holds the grid, sliders, and swatches. | \`::part(color-picker)\` |
| \`eyedropper-button\` | The eye dropper button. | \`::part(eyedropper-button)\` |
| \`eyedropper-button\_\_base\` | \`button\` The eye dropper 's exported button part. | \`::part(eyedropper-button\_\_base)\` |
| \`eyedropper-button\_\_caret\` | \`caret\` The eye dropper button's exported part. | \`::part(eyedropper-button\_\_caret)\` |
| \`eyedropper-button\_\_end\` | \`end\` The eye dropper button's exported part. | \`::part(eyedropper-button\_\_end)\` |
| \`eyedropper-button\_\_label\` | \`label\` The eye dropper button's exported part. | \`::part(eyedropper-button\_\_label)\` |
| \`eyedropper-button\_\_start\` | \`start\` The eye dropper button's exported part. | \`::part(eyedropper-button\_\_start)\` |
| \`form-control\` | The form control that wraps the label, input, and hint. | \`::part(form-control)\` |
| \`form-control-input\` | The color picker's trigger button. | \`::part(form-control-input)\` |
| \`form-control-label\` | The label. | \`::part(form-control-label)\` |
| \`format-button\` | The format button. | \`::part(format-button)\` |
| \`format-button\_\_base\` | \`button\` The format 's exported button part. | \`::part(format-button\_\_base)\` |
| \`format-button\_\_caret\` | \`caret\` The format button's exported part. | \`::part(format-button\_\_caret)\` |
| \`format-button\_\_end\` | \`end\` The format button's exported part. | \`::part(format-button\_\_end)\` |
| \`format-button\_\_label\` | \`label\` The format button's exported part. | \`::part(format-button\_\_label)\` |
| \`format-button\_\_start\` | \`start\` The format button's exported part. | \`::part(format-button\_\_start)\` |
| \`grid\` | The color grid. | \`::part(grid)\` |
| \`grid-handle\` | The color grid's handle. | \`::part(grid-handle)\` |
| \`hint\` | The hint's wrapper. | \`::part(hint)\` |
| \`hue-slider\` | The hue slider. | \`::part(hue-slider)\` |
| \`hue-slider-handle\` | The hue slider's handle. | \`::part(hue-slider-handle)\` |
| \`input\` | The text input. | \`::part(input)\` |
| \`opacity-slider\` | The opacity slider. | \`::part(opacity-slider)\` |
| \`opacity-slider-handle\` | The opacity slider's handle. | \`::part(opacity-slider-handle)\` |
| \`preview\` | The preview color. | \`::part(preview)\` |
| \`slider\` | Hue and opacity sliders. | \`::part(slider)\` |
| \`slider-handle\` | Hue and opacity slider handles. | \`::part(slider-handle)\` |
| \`swatch\` | Each individual swatch. | \`::part(swatch)\` |
| \`swatches\` | The container that holds the swatches. | \`::part(swatches)\` |
| \`trigger\` | The color picker's dropdown trigger. | \`::part(trigger)\` |
| \`trigger-container\` | The container that wraps the color picker's trigger. | \`::part(trigger-container)\` |
| \`base\` | \`color-picker\` Deprecated. Use the part instead. | \`::part(base)\` |

### Dependencies

This component automatically imports the following elements. Sub-dependencies, if any exist, will also be included in this list.

-   [`<wa-button>`](https://webawesome.com/docs/components/button)
-   [`<wa-button-group>`](https://webawesome.com/docs/components/button-group)
-   [`<wa-icon>`](https://webawesome.com/docs/components/icon)
-   [`<wa-input>`](https://webawesome.com/docs/components/input)
-   [`<wa-popup>`](https://webawesome.com/docs/components/popup)
-   [`<wa-spinner>`](https://webawesome.com/docs/components/spinner)
-   [`<wa-visually-hidden>`](https://webawesome.com/docs/components/visually-hidden)

## Examples

### Label

Use the `label` attribute to give the color picker an accessible label. For labels that contain HTML, use the `label` slot instead.

```html
<wa-color-picker label="Brand color"></wa-color-picker>
```

### Hint

Add a descriptive hint with the `hint` attribute. For hints that contain HTML, use the `hint` slot instead.

```html
<wa-color-picker label="Accent" hint="Pick something with enough contrast to read against white."></wa-color-picker>
```

### Initial Value

Use the `value` attribute to set a starting color. The value's format follows the `format` attribute, but any parsable color (including CSS color names) is accepted as input.

```html
<wa-color-picker value="#4a90e2" label="Select a color"></wa-color-picker>
```

### Format

Set the color picker's format with the `format` attribute. Valid options are `hex`, `rgb`, `hsl`, and `hsv`. The input still accepts any parsable format regardless of this setting.

To stop people from cycling through formats themselves, add the `without-format-toggle` attribute.

```html
<div class="wa-grid" style="--min-column-size: 12ch;">
  <wa-color-picker format="hex" value="#4a90e2" label="Pick a hex color"></wa-color-picker>
  <wa-color-picker format="rgb" value="rgb(80, 227, 194)" label="Pick an RGB color"></wa-color-picker>
  <wa-color-picker format="hsl" value="hsl(290, 87%, 47%)" label="Pick an HSL color"></wa-color-picker>
  <wa-color-picker format="hsv" value="hsv(55, 89%, 97%)" label="Pick an HSV color"></wa-color-picker>
</div>
```

### Opacity

Use the `opacity` attribute to add an opacity slider. With opacity enabled, the value is shown as HEXA, RGBA, HSLA, or HSVA to match the `format`.

```html
<wa-color-picker value="#f5a623ff" opacity label="Select a color"></wa-color-picker>
```

### Uppercase Values

By default, values are lowercase. Add the `uppercase` attribute to display them in uppercase instead.

```html
<wa-color-picker value="#4a90e2" uppercase label="Select a color"></wa-color-picker>
```

### Swatches

Use the `swatches` attribute to offer preset colors. Any format the picker can parse works (including [CSS color names](https://www.w3schools.com/colors/colors_names.asp)), and each value must be separated by a semicolon (`;`).

```html
<wa-color-picker
  label="Select a color"
  swatches="
    #d0021b; #f5a623; #f8e71c; #8b572a; #7ed321; #417505; #bd10e0; #9013fe;
    #4a90e2; #50e3c2; #b8e986; #000; #444; #888; #ccc; #fff;
  "
></wa-color-picker>
```

To give swatches accessible names, set the `swatches` property in JavaScript to an array of `{ color, label }` objects — each `label` becomes that swatch's accessible name instead of the raw color value. (Their appearance is identical, so this isn't a live example.)

```js
const picker = document.querySelector('wa-color-picker');
picker.swatches = [
  { color: '#d0021b', label: 'Red' },
  { color: '#f5a623', label: 'Orange' },
  { color: '#417505', label: 'Green' },
  { color: '#4a90e2', label: 'Blue' },
];
```

To offer a fully transparent option, include the `transparent` keyword as a swatch. It renders with a checkerboard pattern, and selecting it sets the value to black with zero alpha, e.g. `#00000000`.

```html
<wa-color-picker
  label="Select a color"
  opacity
  swatches="transparent; #d0021b; #f5a623; #f8e71c; #7ed321; #4a90e2; #9013fe; #000;"
></wa-color-picker>
```

Transparent swatches require the `opacity` attribute. Without it, the alpha channel is discarded and selecting the swatch yields opaque black.

### Placement

Set the `placement` attribute to control where the dropdown opens. The actual position may shift to keep the panel inside the viewport.

```html
<div class="wa-cluster wa-align-items-baseline">
  <wa-color-picker placement="top-start" label="Select a color"></wa-color-picker>
  <wa-color-picker placement="bottom-end" label="Select a color"></wa-color-picker>
  <wa-color-picker placement="right" label="Select a color"></wa-color-picker>
  <wa-color-picker placement="left" label="Select a color"></wa-color-picker>
</div>
```

### Size

Use the `size` attribute to change the color picker's trigger size.

```html
<div class="wa-cluster wa-align-items-baseline">
  <wa-color-picker size="xs" label="Extra small"></wa-color-picker>
  <wa-color-picker size="s" label="Small"></wa-color-picker>
  <wa-color-picker size="m" label="Medium"></wa-color-picker>
  <wa-color-picker size="l" label="Large"></wa-color-picker>
  <wa-color-picker size="xl" label="Extra large"></wa-color-picker>
</div>
```

### Disabled

Use the `disabled` attribute to disable a color picker.

```html
<wa-color-picker disabled label="Select a color"></wa-color-picker>
```

### Applying the Selected Color

The color picker emits an `input` event as the user picks, so you can apply the chosen color to your UI in real time. Here, changing the color themes a preview card.

```html
<div class="color-apply-demo">
  <div class="color-apply-preview">
    <wa-icon name="palette"></wa-icon>
    <div>
      <strong>Brand preview</strong>
      <p>Pick a color to theme this card in real time.</p>
    </div>
  </div>

  <wa-divider></wa-divider>

  <wa-color-picker label="Accent color" value="#6e40c9"></wa-color-picker>
</div>

<script>
  const demo = document.querySelector('.color-apply-demo');
  const picker = demo.querySelector('wa-color-picker');
  const preview = demo.querySelector('.color-apply-preview');

  picker.addEventListener('input', () => {
    preview.style.setProperty('--accent', picker.value);
  });
</script>

<style>
  .color-apply-demo .color-apply-preview {
    --accent: #6e40c9;
    display: flex;
    align-items: center;
    gap: var(--wa-space-m);
    margin-block-end: 1rem;
    padding: var(--wa-space-l);
    border-radius: var(--wa-border-radius-l);
    border-inline-start: 4px solid var(--accent);
    background-color: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .color-apply-demo .color-apply-preview wa-icon {
    color: var(--accent);
    font-size: 1.5rem;
  }

  .color-apply-demo .color-apply-preview strong {
    color: var(--accent);
  }

  .color-apply-demo .color-apply-preview p {
    margin: 0.25rem 0 0;
  }
</style>
```
