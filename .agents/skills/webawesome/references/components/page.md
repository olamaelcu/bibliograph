# Page

`<wa-page>`

Stable [Layout](https://webawesome.com/docs/components/?category=layout) [Since 3.0](https://webawesome.com/docs/resources/changelog#wa_300)

Pages scaffold an entire application layout with header, navigation, sidebar, main content, aside, and footer regions. Use them to structure full pages with minimal markup and responsive behavior built in.

The page component is designed to power full webpages. It is flexible enough to handle most modern designs and includes a simple mechanism for handling desktop and mobile navigation.

**Now Available in Web Awesome Core**  
Page moved over from Pro in [**3.5.0**](https://webawesome.com/docs/resources/changelog#wa_350). On an earlier Core version? Upgrade to use it.

## Layout Anatomy

This image depicts a page's anatomy, including the default positions of each section. The labels represent the [named slots](#slots) you can use to populate them.

Most slots are optional. Slots that have no content will not be shown, allowing you to opt-in to just the sections you actually need.

Slots

banner header subheader navigation-header navigation navigation-footer main-header main-footer aside footer

## Using wa-page

If you're not familiar with how slots work in HTML, you might want to [learn more about slots](https://webawesome.com/docs/usage/#slots) before using this component.

A number of sections are available as part of the page component, most of which are optional. Content is populated by [slotting elements](https://webawesome.com/docs/usage/#slots) into various locations.

This component _does not_ implement any [content sectioning](https://developer.mozilla.org/en-US/docs/Web/HTML/Element#content_sectioning) or "semantic elements" internally (such as `<main>`, `<header>`, `<footer>`, etc.). Instead, we recommend that you slot in content sectioning elements wherever you feel they're appropriate.

When using `<wa-page>`, make sure to zero out all paddings and margins on `<html>` and `<body>`, otherwise you may see unexpected gaps. We highly recommend adding the following styles when using `<wa-page>`:

```css
html,
body {
  min-height: 100%;
  padding: 0;
  margin: 0;
}
```

If you use [native styles](https://webawesome.com/docs/utilities/native/), this is already taken care of.

## Customization

### Sticky Sections

The following sections of a page are "sticky" by default, meaning they remain in position as the user scrolls.

-   `banner`
-   `header`
-   `subheader`
-   `menu` (`navigation` itself is not sticky, but its parent `menu` is)
-   `aside`

This is often desirable, but you can change this behavior using the `disable-sticky` attribute. Use a space-delimited list of names to tell the page which sections should not be sticky.

```html
<wa-page disable-sticky="header aside"> ... </wa-page>
```

### Skip to Content

The layout provides a "skip to content" link that's visually hidden until the user tabs into it. You don't have to do anything to configure this, unless you want to change the text displayed in the link. In that case, you can slot in your own text using the `skip-to-content` slot.

This example localizes the "skip to content" link for German users.

```html
<wa-page>
  ...
  <span slot="skip-to-content">Zum Inhalt springen</span>
  ...
</wa-page>
```

### Responsiveness

A page isn't very opinionated when it comes to responsive behaviors, but there are tools in place to help make responsiveness easy.

#### Default Slot Styles

Each slot is a [flex container](https://developer.mozilla.org/en-US/docs/Glossary/Flex_Container) and specifies some flex properties so that your content is reasonably responsive by default.

The following slots specify `justify-content: space-between` and `flex-wrap: wrap` to evenly distribute child elements horizontally and allow them to wrap when space is limited.

-   `header`
-   `subheader`
-   `main-header`
-   `main-footer`
-   `footer`

The following slots specify `flex-direction: column` to arrange child elements vertically.

-   `navigation-header`
-   `navigation` (or `menu`)
-   `navigation-footer`
-   `aside`

And the `banner` slot specifies `justify-content: center` to horizontally center its child elements.

You can override the default display and flex properties for each slot with your own CSS.

#### Responsive Navigation

When you use the `navigation` slot, your slotted content automatically collapses into a drawer on smaller screens. The breakpoint at which this occurs is `768px` by default, but you can change it using the `mobile-breakpoint` attribute, which takes either a number or a [CSS length](https://developer.mozilla.org/en-US/docs/Web/CSS/length).

```html
<wa-page mobile-breakpoint="600"> ... </wa-page>
```

By default, a "hamburger" button appears at the start of the `header` to toggle the navigation menu on smaller screens. You can customize what this looks like by slotting your own button into the `navigation-toggle` slot, or place the `data-toggle-nav` attribute on any button on your page. This _does not_ have to be a Web Awesome element.

The default button will not be shown when using either of these methods — if you want to use multiple navigation toggles on your page, add the `data-toggle-nav` attribute to multiple elements.

```html
<wa-page mobile-breakpoint="600">
  ...
  <wa-button data-toggle-nav>Menu</wa-button>
  ...
</wa-page>
```

Alternatively, you can apply `nav-state="open"` and `nav-state="closed"` to the layout component to show and hide the navigation, respectively.

```html
<wa-page nav-state="open"> ... </wa-page>
```

`<wa-page>` is given the attribute `view="mobile"` or `view="desktop"` when the viewport narrower or wider than the `mobile-breakpoint` value, respectively. You can leverage these attributes to change styles depending on the size of the viewport. This is especially useful to hide your `data-toggle-nav` button when the viewport is wider.

```css
wa-page[view='desktop'] [data-toggle-nav] {
  display: none;
}
```

If you use [native styles](https://webawesome.com/docs/utilities/native/), this is handled for you, and the `data-toggle-nav` button is already hidden on wider screens.

#### Custom Widths

You specify widths for some slots on your page with [CSS custom properties](#css-custom-properties) for `--menu-width`, `--main-width`, and `--aside-width`.

If you specify `--menu-width` to apply a specific width to your `navigation` slot, space will still be reserved on the page even below the `mobile-breakpoint`. To collapse this space on smaller screens, add the following code to your styles.

```css
wa-page[view='mobile'] {
  --menu-width: auto;
}
```

You can use a similar approach for `--aside-width` to hide the `aside` slot on smaller screens. Be sure to also specify `display: none` for the slot:

```css
wa-page[view='mobile'] {
  --aside-width: auto;

  [slot='aside'] {
    display: none;
  }
}
```

### Spacing

A page specifies default `padding` within each slot and a `gap` between the slot's direct children. You can drop elements into any slot, and reasonable spacing is already applied for you.

You can override the default spacing for each slot with your own CSS. In this example, we're setting custom `gap` and `padding` for the `footer` slot.

```css
[slot='footer'] {
  gap: var(--wa-space-xl);
  padding: var(--wa-space-xl);
}
```

## Utility Classes

[Native styles](https://webawesome.com/docs/utilities/native/) define a few useful defaults for `<wa-page>`, as well as two utility classes you can use for common responsive design tasks:

-   `.wa-mobile-only` hides an element on the desktop view
-   `.wa-desktop-only` hides an element on the mobile view

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/page/page.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/page/page.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/page/page.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaPage from '@awesome.me/webawesome/dist/react/page/index.js';
```

### Slots

| Name | Description |
| --- | --- |
| (default) | The page's main content. |
| \`aside\` | Content to be shown on the right side of the page. Typically contains a table of contents, ads, etc. This section "sticks" to the top as the page scrolls. |
| \`banner\` | The banner that gets display above the header. The banner will not be shown if no content is provided. |
| \`footer\` | The content to display in the footer. This is always displayed underneath the viewport so will always make the page "scrollable". |
| \`header\` | The header to display at the top of the page. If a banner is present, the header will appear below the banner. The header will not be shown if there is no content. |
| \`main-footer\` | Footer to display inline below the main content. |
| \`main-header\` | Header to display inline above the main content. |
| \`menu\` | \`navigation\` The left side of the page. If you slot an element in here, you will override the default slot and will be handling navigation on your own. This also will not disable the fallback behavior of the navigation button. This section "sticks" to the top as the page scrolls. |
| \`navigation\` | \`menu\` The main content to display in the navigation area. This is displayed on the left side of the page, if is not used. This section "sticks" to the top as the page scrolls. |
| \`navigation-footer\` | \`\` The footer for a navigation area. On mobile this will be the footer for . |
| \`navigation-header\` | \`\` The header for a navigation area. On mobile this will be the header for . |
| \`navigation-toggle\` | \`\` Use this slot to slot in your own button + icon for toggling the navigation drawer. By default it is a + a 3 bars \` Use this to slot in your own icon for toggling the navigation drawer. By default it is 3 bars . |
| \`skip-to-content\` | \`Skip to content\` The "skip to content" slot. You can override this If you would like to override the button and add additional "Skip to X", they can be inserted here. |
| \`subheader\` | \`header\` A sub to display below the header. This is a good place to put things like breadcrumbs. |

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`disableNavigationToggle\` disable-navigation-toggle | \`data-toggle-nav\` Determines whether or not to hide the default hamburger button. This will automatically flip to "true" if you add an element with anywhere in the element light DOM. Generally this will be set for you and you don't need to do anything, unless you're using SSR, in which case you should set this manually for initial page loads. Type boolean Default false | |
| \`mobileBreakpoint\` mobile-breakpoint | \`50em\` At what page width to hide the "navigation" slot and collapse into a hamburger button. Accepts both numbers (interpreted as px) and CSS lengths (e.g. ), which are resolved based on the root element. Type string Default '768px' | |
| \`navigationPlacement\` navigation-placement | \`'start' \\| 'end'\` Where to place the navigation when in the mobile viewport. Type Default 'start' | |
| \`navOpen\` nav-open | \`boolean\` Whether or not the navigation drawer is open. Note, the navigation drawer is only "open" on mobile views. Type Default false | |
| \`view\` view | \`mobile-breakpoint\` The view is a reflection of the "mobileBreakpoint", when the page is larger than the (768px by default), it is considered to be a "desktop" view. The view is merely a way to distinguish when to show/hide the navigation. You can use additional media queries to make other adjustments to content as necessary. The default is "desktop" because the "mobile navigation drawer" isn't accessible via SSR due to drawer requiring JS. Type 'mobile' \\| 'desktop' Default 'desktop' | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`hideNavigation()\` | Hides the mobile navigation drawer | |
| \`showNavigation()\` | Shows the mobile navigation drawer | |
| \`toggleNavigation()\` | Toggles the mobile navigation drawer | |
| \`visiblePixelsInViewport()\` | https://stackoverflow.com/a/26831113 This prevents awkward gaps when scrolling the page and the aside / menu dont "fill" the gaps. | \`element: HTMLElement \\| null\` |

### CSS Custom Properties

| Name | Description |
| --- | --- |
| \`--aside-width\` | \`auto\` The wide of the page's "aside" section. Default |
| \`--banner-height\` | \`0px\` The height of the banner. This gets calculated when the page initializes. If the height is known, you can set it here to prevent shifting when the page loads. Default |
| \`--header-height\` | \`0px\` The height of the header. This gets calculated when the page initializes. If the height is known, you can set it here to prevent shifting when the page loads. Default |
| \`--main-width\` | \`1fr\` The width of the page's "main" section. Default |
| \`--menu-width\` | \`auto\` The width of the page's "menu" section. Default |
| \`--subheader-height\` | \`0px\` The height of the subheader. This gets calculated when the page initializes. If the height is known, you can set it here to prevent shifting when the page loads. Default |

### CSS Parts

| Name | Description | CSS selector |
| --- | --- | --- |
| \`aside\` | The right hand side of the page. Used for things like table of contents, ads, etc. | \`::part(aside)\` |
| \`banner\` | The banner to show above header. | \`::part(banner)\` |
| \`body\` | The wrapper around menu, main, and aside. | \`::part(body)\` |
| \`drawer\` | \`\` The that contains the navigation on mobile viewports. | \`::part(drawer)\` |
| \`footer\` | The footer of the page. This is always below the initial viewport size. | \`::part(footer)\` |
| \`header\` | The header, usually for top level navigation / branding. | \`::part(header)\` |
| \`main\` | The wrapper around the main header, content, and footer. | \`::part(main)\` |
| \`main-content\` | The main content. | \`::part(main-content)\` |
| \`main-footer\` | The footer below main content. | \`::part(main-footer)\` |
| \`main-header\` | The header above main content. | \`::part(main-header)\` |
| \`menu\` | The left hand side of the page. Generally intended for navigation. | \`::part(menu)\` |
| \`navigation\` | \`

\` The that wraps the navigation slots on desktop viewports. | \`::part(navigation)\` |
| \`navigation-desktop\` | \`

\` The for navigation on desktop viewports. | \`::part(navigation-desktop)\` |
| \`navigation-footer\` | \`\` The footer for a navigation area. On mobile this will be the footer for . | \`::part(navigation-footer)\` |
| \`navigation-header\` | \`\` The header for a navigation area. On mobile this will be the header for . | \`::part(navigation-header)\` |
| \`navigation-toggle\` | \`\` The default that will toggle the for mobile viewports. | \`::part(navigation-toggle)\` |
| \`navigation-toggle-icon\` | \`\` The default displayed inside of the navigation-toggle button. | \`::part(navigation-toggle-icon)\` |
| \`page\` | The component's outer wrapper. | \`::part(page)\` |
| \`skip-to-content\` | The "skip to content" link that lets keyboard users bypass navigation. | \`::part(skip-to-content)\` |
| \`subheader\` | Shown below the header, usually intended for things like breadcrumbs and other page level navigation. | \`::part(subheader)\` |
| \`base\` | \`page\` Deprecated. Use the part instead. | \`::part(base)\` |

## Examples

Open demos in a new tab to examine their behavior in different window sizes. The previews below use simulated zooming which, depending on your browser, may not be accurate.

### Documentation

A sample documentation page using [all available slots](#slots). The navigation menu collapses into a drawer at a custom `mobile-breakpoint` of 920px. It can be opened using a button with `[data-toggle-nav]` that appears in the `subheader` slot. The `aside` slot is also hidden below 920px.

Open demo in a new window

### Media

A sample media app page using `header`, `navigation-header`, `main-header`, and `main-footer` along with the default slot. The navigation menu collapses into a drawer at the default `mobile-breakpoint` and can be opened using a button with `[data-toggle-nav]` that appears in the `header` slot.

Open demo in a new window
