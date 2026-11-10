# OTP Input

`<wa-otp-input>`

Experimental [Forms](https://webawesome.com/docs/components/?category=forms) [Since 3.11](https://webawesome.com/docs/resources/changelog#wa_3110)

OTP inputs collect one-time passcodes, PINs, and other fixed-length codes, one character per segment. Use them for SMS verification, two-factor authentication, and invite codes.

```html
<wa-otp-input label="Verification code"></wa-otp-input>
```

This component works with standard `<form>` elements. See [form controls](https://webawesome.com/docs/form-controls) for form submission and client-side validation.

## Accessibility Considerations

The component uses a single visually hidden `<input>` as the focus and form target — the visible segments are decorative. Screen readers announce it as one text field, named by the `label` attribute or slot. Always provide a label; without one, the field has no accessible name.

Keyboard interaction follows the single-input model:

| Key | Behavior |
| --- | --- |
| ← → | Move between segments |
| Tab | Moves focus to the next form control |
| Enter | Submits the containing form |
| Backspace | Clears the current segment and moves back (no character shift) |
| Delete | Clears the current segment without moving |

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/otp-input/otp-input.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/otp-input/otp-input.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/otp-input/otp-input.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaOtpInput from '@awesome.me/webawesome/dist/react/otp-input/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| \`hint\` | \`hint\` Optional text. Use this for hints that contain HTML. When hint attribute is set it takes priority. |
| \`label\` | \`label\` An optional . Use this for labels that contain HTML. When label attribute is set it takes priority. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`appearance\` appearance | \`'outlined' \\| 'filled' \\| 'filled-outlined' \\| 'contained'\` Visual appearance of the segments. Type Default 'outlined' | |
| \`autocomplete\` autocomplete | \`autocomplete\` The attribute forwarded to the underlying input. Type string Default 'one-time-code' | |
| \`autofocus\` autofocus | \`boolean\` Automatically focuses the field when the page loads. Type Default false | |
| \`autosubmit\` autosubmit | \`boolean\` When true, the form is submitted automatically once all segments are filled. Type Default false | |
| \`case\` case | \`'preserve' \\| 'upper' \\| 'lower'\` Case transformation applied to entered characters. Type Default 'preserve' | |
| \`defaultValue\` value | \`value\` The default . Used to restore the field on form reset. Reflects the value HTML attribute. Type string \\| null | |
| \`disabled\` disabled | \`boolean\` Disables the form control. Type Default false | |
| \`effectiveLength\` | \`format\` Number of segments derived from (count of #) or length. Type number | |
| \`form\` | \`

\` By default, form controls are associated with the nearest containing element. This attribute allows you to place the form control outside of a form and associate it with the form that has this id. The form must be in the same document or shadow root for this to work. Type HTMLFormElement \\| null | |
| \`format\` format | \`#\` Segment format string using as a segment placeholder and any other character as a literal separator. Setting format overrides length (the segment count is derived from the number of # characters). Type string Default '' | |
| \`hint\` hint | \`hint\` Hint text shown below the segments. Use the slot for HTML content. Type string Default '' | |
| \`input\` | \`\` The real used for form association and validation (visually hidden). Type (HTMLElement & { value: unknown }) \\| HTMLInputElement \\| HTMLTextAreaElement \\| undefined | |
| \`label\` label | \`label\` A shown above the segments. Use the label slot for HTML content. Type string Default '' | |
| \`length\` length | \`format\` Number of character segments to display. Overridden by when set. Type number Default 6 | |
| \`mask\` mask | \`--mask-char\` When true, entered characters are displayed as instead of their real value. Type boolean Default false | |
| \`name\` name | \`string \\| null\` The name of the input, submitted as a name/value pair with form data. Type Default null | |
| \`readonly\` readonly | \`boolean\` Makes the field readonly — the value displays but cannot be edited by the user. Type Default false | |
| \`required\` required | \`boolean\` Makes the field required. A partially-filled field is always invalid regardless of this attribute. Type Default false | |
| \`size\` size | \`'xs' \\| 's' \\| 'm' \\| 'l' \\| 'xl' \\| 'small' \\| 'medium' \\| 'large'\` The size of each segment. Type Default 'm' | |
| \`type\` type | \`'numeric' \\| 'alpha' \\| 'alphanumeric'\` Allowed character class. Type Default 'numeric' | |
| \`validationTarget\` | \`undefined \\| HTMLElement\` Override this to change where constraint validation popups are anchored. Type | |
| \`validators\` | \`observedAttributes\` Validators are static because they have , essentially attributes to "watch" for changes. Whenever these attributes change, we want to be notified and update the validator. Type Validator\[\] Default \[\] | |
| \`value\` | \`string\` The current value of the OTP field, submitted as a name/value pair with form data. Type | |
| \`withMask\` with-mask | \`--mask-char\` When true, empty segments show as a hint instead of appearing blank, similar to how a password field communicates its expected length before anything is typed. Type boolean Default false | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`blur()\` | Removes focus from the field. | |
| \`clear()\` | Clears the current value and returns focus to the field. | |
| \`focus()\` | Focuses the field. | \`options: FocusOptions\` |
| \`formStateRestoreCallback()\` | Called when the browser is trying to restore element’s state to state in which case reason is "restore", or when the browser is trying to fulfill autofill on behalf of user in which case reason is "autocomplete". In the case of "restore", state is a string, File, or FormData object previously set as the second argument to setFormValue. | \`state: string \\| File \\| FormData \\| null, reason: 'autocomplete' \\| 'restore'\` |
| \`resetValidity()\` | Reset validity is a way of removing manual custom errors and native validation. | |
| \`select()\` | Selects all entered characters in the hidden input. | |
| \`setCustomValidity()\` | Do not use this when creating a "Validator". This is intended for end users of components. We track manually defined custom errors so we don't clear them on accident in our validators. | \`message: string\` |

### Events

| Name | Description |
| --- | --- |
| \`blur\` | Emitted when the control loses focus. |
| \`change\` | Emitted when the value changes and the field loses focus. |
| \`focus\` | Emitted when the control gains focus. |
| \`input\` | Emitted when a character is entered or removed. |
| \`wa-clear\` | Emitted when the control's value is cleared. |
| \`wa-complete\` | \`preventDefault()\` Emitted once when all segments are filled. Cancelable — call to stop autosubmit from submitting the form for this completion. |
| \`wa-invalid\` | Emitted when the form control has been checked for validity and its constraints aren't satisfied. |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--mask-char\` | \`mask\` Character shown in place of entered values when is set, and as a hint in empty segments when with-mask is set. Default '•' |
| \`--segment-border-radius\` | \`var(--wa-form-control-border-radius)\` Corner radius of each segment. Default |
| \`--segment-gap\` | \`contained\` Gap between segments (not used in appearance). Default var(--wa-space-xs) |
| \`--segment-size\` | \`2.5em\` Width and height of each segment cell. Default |

### Custom States

| Name | Description | CSS selector |
| --- | --- | --- |
| \`--blank\` | Applied when no characters have been entered. | \`:state(--blank)\` |
| \`--filled\` | Applied when all segments are filled. | \`:state(--filled)\` |
| \`disabled\` | Applied when the component is disabled. | \`:state(disabled)\` |
| \`readonly\` | Applied when the component is readonly. | \`:state(readonly)\` |
| \`user-invalid\` | Applied when validation fails after interaction. | \`:state(user-invalid)\` |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`hint\` | The hint element. | \`::part(hint)\` |
| \`label\` | The label element. | \`::part(label)\` |
| \`segment\` | An individual character segment cell. | \`::part(segment)\` |
| \`segment-literal\` | Inert literal text between segment groups (e.g. space or dash). | \`::part(segment-literal)\` |
| \`segments\` | The wrapper around all segment cells and separators. | \`::part(segments)\` |

## Examples

### Label

Use the `label` attribute to give the field an accessible label. For labels that contain HTML, use the `label` slot instead.

```html
<wa-otp-input label="Security code"></wa-otp-input>
```

### Hint

Add descriptive hint text with the `hint` attribute. For hints that contain HTML, use the `hint` slot instead.

```html
<wa-otp-input label="Sign-in code" hint="Check your email for a 6-digit code."></wa-otp-input>
```

### Length

Use the `length` attribute to change the number of segments. The default is 6.

```html
<div class="wa-stack">
  <wa-otp-input label="Card PIN" length="4"></wa-otp-input>
  <wa-otp-input label="Backup code" length="8"></wa-otp-input>
</div>
```

### Type

Use the `type` attribute to restrict which characters are accepted.

```html
<div class="wa-stack">
  <wa-otp-input label="Numeric" type="numeric"></wa-otp-input>
  <wa-otp-input label="Alpha" type="alpha"></wa-otp-input>
  <wa-otp-input label="Alphanumeric" type="alphanumeric"></wa-otp-input>
</div>
```

| Type | Accepts | Best for |
| --- | --- | --- |
| \`numeric\` default | Digits 0–9 | SMS and 2FA codes, PINs |
| \`alpha\` | Letters A–Z | Letter-only codes |
| \`alphanumeric\` | Letters and digits | Invite codes, serial numbers |

The `numeric` type also sets the `inputmode` attribute on the underlying input, so mobile devices show the numeric keyboard.

### Format

Use the `format` attribute to arrange segments into groups with literal separators. The `#` character marks a segment; any other character becomes a visual separator. Setting `format` overrides `length`, so there is no need to specify both.

```html
<div class="wa-stack">
  <!-- Two groups of three with a space: e.g. "ABC DEF" -->
  <wa-otp-input label="Invite code" type="alphanumeric" format="### ###"></wa-otp-input>
  <!-- Three groups of four joined by dashes: e.g. "1234-5678-9012" -->
  <wa-otp-input label="License key" type="alphanumeric" format="####-####-####"></wa-otp-input>
</div>
```

### Case

Use the `case` attribute to transform characters as they are entered. The default is `preserve`. Use `upper` to force uppercase or `lower` to force lowercase.

```html
<div class="wa-stack">
  <wa-otp-input label="Upper" type="alpha" case="upper"></wa-otp-input>
  <wa-otp-input label="Lower" type="alpha" case="lower"></wa-otp-input>
</div>
```

### Mask

Add the `mask` attribute to display entered characters using `--mask-char` (a bullet, `•`, by default) instead of their real value. The value remains accessible via the `value` property, masking is display-only, and only visual: screen readers still announce entered characters.

```html
<wa-otp-input label="PIN" mask length="4"></wa-otp-input>
```

Add the `with-mask` attribute to also show `--mask-char` as a hint in each empty segment, so the field reads like a password field even before anything is typed.

```html
<wa-otp-input label="PIN" mask with-mask length="4"></wa-otp-input>
```

Customize the character with the `--mask-char` custom property. It must be a quoted string.

```html
<wa-otp-input id="custom-mask-char" label="PIN" mask with-mask length="4"></wa-otp-input>

<style>
  #custom-mask-char {
    --mask-char: '*';
  }
</style>
```

### Appearance

Use the `appearance` attribute to change the visual style of the segments. The default is `outlined`.

```html
<div class="wa-stack">
  <wa-otp-input label="Outlined" appearance="outlined"></wa-otp-input>
  <wa-otp-input label="Filled" appearance="filled"></wa-otp-input>
  <wa-otp-input label="Filled outlined" appearance="filled-outlined"></wa-otp-input>
  <wa-otp-input label="Contained" appearance="contained"></wa-otp-input>
</div>
```

### Size

Use the `size` attribute to change the size of each segment. The default is `m`.

```html
<div class="wa-stack">
  <wa-otp-input label="Extra small" size="xs"></wa-otp-input>
  <wa-otp-input label="Small" size="s"></wa-otp-input>
  <wa-otp-input label="Medium" size="m"></wa-otp-input>
  <wa-otp-input label="Large" size="l"></wa-otp-input>
  <wa-otp-input label="Extra large" size="xl"></wa-otp-input>
</div>
```

### Disabled

Use the `disabled` attribute to prevent interaction.

```html
<wa-otp-input label="Verification code" disabled value="391824"></wa-otp-input>
```

### Readonly

Use the `readonly` attribute to display a value without allowing edits. Unlike `disabled`, a readonly field still receives focus and participates in form submission.

```html
<wa-otp-input label="Confirmation code" readonly value="483920"></wa-otp-input>
```

### Initial Value

Use the `value` attribute to prefill the segments — for example, when a code arrives in a link's query parameter.

```html
<wa-otp-input label="Magic link code" value="271828"></wa-otp-input>
```

### Pasting

Pasting a full code fills all segments in one step. Characters that don't match the `type` attribute are silently dropped, so pasting `"ABC-123"` into a `numeric` field produces `123`.

```html
<wa-copy-button value="314159">
  <wa-button appearance="filled">
    <wa-icon slot="start" name="clipboard"></wa-icon>
    Copy code: 314159
  </wa-button>
</wa-copy-button>

<wa-divider></wa-divider>

<wa-otp-input label="Paste your code below"></wa-otp-input>
```

### Autofill

The `autocomplete` attribute defaults to `one-time-code`, which tells browsers and operating systems to offer autofill for SMS-delivered verification codes. Set `autocomplete="off"` to disable this — for example, when the field is used for a PIN that shouldn't be suggested by the browser.

On Android, Chrome can also read the code from an incoming SMS with the [WebOTP API](https://developer.mozilla.org/en-US/docs/Web/API/WebOTP_API), no manual entry required. Feature-detect it and set the field's `value` from the result:

```html
<wa-otp-input id="sms-code" label="Verification code"></wa-otp-input>

<script>
  if ('OTPCredential' in window) {
    navigator.credentials
      .get({ otp: { transport: ['sms'] } })
      .then(otp => {
        document.getElementById('sms-code').value = otp.code;
      })
      .catch(() => {
        // The prompt was dismissed or timed out
      });
  }
</script>
```

### Autosubmit

Add the `autosubmit` attribute to submit the containing form automatically when the last segment is filled. The `wa-complete` event fires first and is cancelable — call `preventDefault()` to stop the submission.

```html
<form class="autosubmit">
  <wa-otp-input name="code" label="SMS verification code" autosubmit></wa-otp-input>
</form>

<script type="module">
  const form = document.querySelector('.autosubmit');

  form.addEventListener('submit', event => {
    event.preventDefault();
    alert(`Submitted code: ${new FormData(event.target).get('code')}`);
  });
</script>
```

To run your own logic on completion instead — verify the code over the network, unlock a button — listen for the `wa-complete` event without setting `autosubmit`.

### Validation

Add the `required` attribute to require a value before submission. A partial entry (some segments filled, but not all) is always invalid regardless of `required`, with the `tooShort` validity flag set.

```html
<form class="validation">
  <wa-otp-input name="code" label="Two-factor code" required></wa-otp-input>
  <br />
  <wa-button appearance="filled" type="submit">Continue</wa-button>
</form>

<script type="module">
  const form = document.querySelector('.validation');

  form.addEventListener('submit', event => {
    event.preventDefault();
    alert('Code accepted!');
  });
</script>
```

### Custom Validity

Use the `setCustomValidity()` method to set a custom validation message. This will prevent the form from submitting and make the browser display the error message you provide. To clear the error, call this function with an empty string.

```html
<form class="custom-validity">
  <wa-otp-input name="code" label="Verification code" hint="The correct code is 314159." required></wa-otp-input>
  <br />
  <wa-button appearance="filled" type="submit">Verify</wa-button>
</form>

<script type="module">
  const form = document.querySelector('.custom-validity');
  const otp = form.querySelector('wa-otp-input');

  otp.addEventListener('input', () => {
    // Only flag complete entries — partial input is already invalid via tooShort
    const isValid = otp.value.length < otp.length || otp.value === '314159';
    otp.setCustomValidity(isValid ? '' : 'That code didn’t match. Check your device and try again.');
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    alert('Code accepted!');
  });
</script>
```

### Customizing

Use the `--segment-size`, `--segment-gap`, and `--segment-border-radius` custom properties along with [CSS parts](#css-parts) to style the segments, including their border and background.

```html
<wa-otp-input id="styled-otp" label="Card PIN" length="4"></wa-otp-input>

<style>
  #styled-otp {
    --segment-size: 3.5rem;
    --segment-gap: 0.75rem;
    --segment-border-radius: 0.75rem;
  }

  #styled-otp::part(segment) {
    font-size: 1.5rem;
    font-weight: 700;
    background-color: var(--wa-color-brand-fill-quiet);
    border-color: var(--wa-color-brand-border-loud);
  }
</style>
```

Combine CSS parts with [custom states](https://webawesome.com/docs/form-controls#custom-validation-styles) to react to what the control is doing. For example, coloring the segments green once the code is fully entered (`--filled`), or red while it's invalid (`invalid`). This example uses `invalid` rather than `user-invalid` so the customization is visible right away, without requiring you to interact with the field first. Type a full code to see it turn green instead:

```html
<wa-otp-input class="stateful-otp" label="Two-factor code" required></wa-otp-input>

<style>
  .stateful-otp:state(--filled)::part(segment) {
    background-color: var(--wa-color-success-fill-quiet);
    border-color: var(--wa-color-success-border-loud);
  }

  .stateful-otp:state(invalid)::part(segment) {
    border-color: var(--wa-color-danger-border-loud);
  }
</style>
```
