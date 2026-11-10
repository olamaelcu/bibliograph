# Format Date

`<wa-format-date>`

Stable [Helpers](https://webawesome.com/docs/components/?category=helpers) [Since 2.0](https://webawesome.com/docs/resources/changelog#wa_200)

Formats a date or time for display using the specified locale and options. Powered by the Intl.DateTimeFormat API for consistent, localized output.

```html
<!-- Web Awesome 3 release date 🎉 -->
<wa-format-date date="2025-12-02T00:00:00-05:00"></wa-format-date>
```

Localization is handled by the browser's [`Intl.DateTimeFormat` API](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat). No language packs are required.

The `date` attribute determines the date/time to use when formatting. It must be a string that [`Date.parse()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/parse) can interpret or a [`Date`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date) object set via JavaScript. If omitted, the current date/time will be assumed.

**Always use ISO 8601 date strings.**  
Ambiguous formats like `03/04/2020` can be read as March 4 or April 3 depending on the user's browser and locale. A valid [ISO 8601 date time string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/parse#Date_Time_String_Format) parses the same for every client.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/format-date/format-date.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/format-date/format-date.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/format-date/format-date.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaFormatDate from '@awesome.me/webawesome/dist/react/format-date/index.js';
```

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`date\` date | \`date.toISOString()\` The date/time to format. If not set, the current date and time will be used. When passing a string, it's strongly recommended to use the ISO 8601 format to ensure timezones are handled correctly. To convert a date to this format in JavaScript, use . Type Date \\| string Default new Date() | |
| \`day\` day | \`'numeric' \\| '2-digit'\` The format for displaying the day. Type | |
| \`era\` era | \`'narrow' \\| 'short' \\| 'long'\` The format for displaying the era. Type | |
| \`hour\` hour | \`'numeric' \\| '2-digit'\` The format for displaying the hour. Type | |
| \`hourFormat\` hour-format | \`'auto' \\| '12' \\| '24'\` The format for displaying the hour. Type Default 'auto' | |
| \`minute\` minute | \`'numeric' \\| '2-digit'\` The format for displaying the minute. Type | |
| \`month\` month | \`'numeric' \\| '2-digit' \\| 'narrow' \\| 'short' \\| 'long'\` The format for displaying the month. Type | |
| \`second\` second | \`'numeric' \\| '2-digit'\` The format for displaying the second. Type | |
| \`timeZone\` time-zone | \`string\` The time zone to express the time in. Type | |
| \`timeZoneName\` time-zone-name | \`'short' \\| 'long'\` The format for displaying the time. Type | |
| \`weekday\` weekday | \`'narrow' \\| 'short' \\| 'long'\` The format for displaying the weekday. Type | |
| \`year\` year | \`'numeric' \\| '2-digit'\` The format for displaying the year. Type | |

## Examples

### Date & Time Format

Formatting options are based on those found in the [`Intl.DateTimeFormat` API](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat). When formatting options are provided, the date/time will be formatted according to those values. When no formatting options are provided, a localized, numeric date will be displayed instead.

```html
<!-- Human-readable date -->
<wa-format-date month="long" day="numeric" year="numeric"></wa-format-date><br />

<!-- Time -->
<wa-format-date hour="numeric" minute="numeric"></wa-format-date><br />

<!-- Weekday -->
<wa-format-date weekday="long"></wa-format-date><br />

<!-- Month -->
<wa-format-date month="long"></wa-format-date><br />

<!-- Year -->
<wa-format-date year="numeric"></wa-format-date><br />

<!-- No formatting options -->
<wa-format-date></wa-format-date>
```

### Hour Format

By default, the browser will determine whether to use 12-hour or 24-hour time. To force one or the other, set the `hour-format` attribute to `12` or `24`.

```html
<wa-format-date hour="numeric" minute="numeric" hour-format="12"></wa-format-date><br />
<wa-format-date hour="numeric" minute="numeric" hour-format="24"></wa-format-date>
```

### Localization

Use the `lang` attribute to set the date/time formatting locale.

```html
English: <wa-format-date lang="en"></wa-format-date><br />
French: <wa-format-date lang="fr"></wa-format-date><br />
Russian: <wa-format-date lang="ru"></wa-format-date>
```
