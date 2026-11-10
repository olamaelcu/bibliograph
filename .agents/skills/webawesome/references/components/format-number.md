# Format Number

`<wa-format-number>`

Stable [Helpers](https://webawesome.com/docs/components/?category=helpers) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Formats a number for display using the specified locale and options, including currency, percent, and unit styles. Powered by the Intl.NumberFormat API.

```html
<div class="format-number-overview">
  <wa-format-number value="1000"></wa-format-number>

  <wa-divider></wa-divider>

  <wa-input type="number" value="1000" label="Number to Format" style="max-width: 180px;"></wa-input>
</div>

<script>
  const container = document.querySelector('.format-number-overview');
  const formatter = container.querySelector('wa-format-number');
  const input = container.querySelector('wa-input');

  input.addEventListener('input', () => (formatter.value = input.value || 0));
</script>
```

Localization is handled by the browser's [`Intl.NumberFormat` API](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/NumberFormat). No language packs are required.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/format-number/format-number.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/format-number/format-number.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/format-number/format-number.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaFormatNumber from '@awesome.me/webawesome/dist/react/format-number/index.js';
```

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`currency\` currency | \`string\` The ISO 4217 currency code to use when formatting. Type Default 'USD' | |
| \`currencyDisplay\` currency-display | \`'symbol' \\| 'narrowSymbol' \\| 'code' \\| 'name'\` How to display the currency. Type Default 'symbol' | |
| \`maximumFractionDigits\` maximum-fraction-digits | \`number\` The maximum of fraction digits to use. Possible values are 0-100. Type number | |
| \`maximumSignificantDigits\` maximum-significant-digits | \`number\` The maximum of significant digits to use,. Possible values are 1-21. Type number | |
| \`minimumFractionDigits\` minimum-fraction-digits | \`number\` The minimum of fraction digits to use. Possible values are 0-100. Type number | |
| \`minimumIntegerDigits\` minimum-integer-digits | \`number\` The minimum of integer digits to use. Possible values are 1-21. Type number | |
| \`minimumSignificantDigits\` minimum-significant-digits | \`number\` The minimum of significant digits to use. Possible values are 1-21. Type number | |
| \`type\` type | \`'currency' \\| 'decimal' \\| 'percent'\` The formatting style to use. Type Default 'decimal' | |
| \`value\` value | \`number\` The to format. Type number Default 0 | |
| \`withoutGrouping\` without-grouping | \`boolean\` Turns off grouping separators. Type Default false | |

## Examples

### Percentage

To get the value as a percent, set the `type` attribute to `percent`.

```html
<wa-format-number type="percent" value="0"></wa-format-number><br />
<wa-format-number type="percent" value="0.25"></wa-format-number><br />
<wa-format-number type="percent" value="0.50"></wa-format-number><br />
<wa-format-number type="percent" value="0.75"></wa-format-number><br />
<wa-format-number type="percent" value="1"></wa-format-number>
```

### Localization

Use the `lang` attribute to set the number formatting locale.

```html
English: <wa-format-number value="2000" lang="en" minimum-fraction-digits="2"></wa-format-number><br />
German: <wa-format-number value="2000" lang="de" minimum-fraction-digits="2"></wa-format-number><br />
Russian: <wa-format-number value="2000" lang="ru" minimum-fraction-digits="2"></wa-format-number>
```

### Currency

To format a number as a monetary value, set the `type` attribute to `currency` and set the `currency` attribute to the desired ISO 4217 currency code. You should also specify `lang` to ensure the number is formatted correctly for the target locale.

```html
<wa-format-number type="currency" currency="USD" value="2000" lang="en-US"></wa-format-number><br />
<wa-format-number type="currency" currency="GBP" value="2000" lang="en-GB"></wa-format-number><br />
<wa-format-number type="currency" currency="EUR" value="2000" lang="de"></wa-format-number><br />
<wa-format-number type="currency" currency="RUB" value="2000" lang="ru"></wa-format-number><br />
<wa-format-number type="currency" currency="CNY" value="2000" lang="zh-cn"></wa-format-number>
```
