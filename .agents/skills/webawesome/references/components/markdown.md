# Markdown

`<wa-markdown>`

Experimental [Media](https://webawesome.com/docs/components/?category=media) [Since 3.4](https://webawesome.com/docs/resources/changelog#wa_340)

Markdown elements render markdown content as HTML directly in the browser, making it easy to display user-generated content or documentation without a server-side build step.

The markdown component turns raw markdown into rendered HTML using the [Marked](https://marked.js.org/) library. Indentation is handled automatically. You can nest your markdown at any depth to match the surrounding HTML structure and the common leading whitespace will be stripped before parsing.

```html
<wa-markdown>
  <script type="text/markdown">
    ## Getting Started

    Here's a quick overview with **bold**, _italic_, and `inline code`.

    - Install the package
    - Import the component
    - Start writing markdown
  </script>
</wa-markdown>
```

**This component isn't suited for SEO-critical content.** Content renders client-side, so crawlers won't see it and it won't appear before JavaScript loads. It's best for prototypes, dashboards, and admin panels — not landing pages or blog posts.

**Do not use this component with unsanitized user input.** Markdown is parsed as-is without sanitization, so rendering untrusted content can lead to XSS vulnerabilities.

## API

### Importing

If you're using the autoloader or a hosted project, components load on demand — no manual import needed. To cherry-pick a component manually, use one of the following snippets.

\*\*CDN\*\*

Import this component directly from the CDN:

```js
import 'https://ka-f.webawesome.com/webawesome@3.12.0/components/markdown/markdown.js';
```

\*\*npm\*\*

After installing Web Awesome via npm, import this component:

```js
import '@awesome.me/webawesome/dist/components/markdown/markdown.js';
```

\*\*Self-Hosted\*\*

If you're self-hosting Web Awesome, import this component from your server:

```js
import './webawesome/dist/components/markdown/markdown.js';
```

\*\*React\*\*

To import this component for React 18 or below, use the following code:

```js
import WaMarkdown from '@awesome.me/webawesome/dist/react/markdown/index.js';
```

### Attributes & Properties

| Name | Description | Reflects |
| --- | --- | --- |
| \`marked\` | \`WaMarkdown.getMarked()\` A reference to the shared Marked instance for convenience. Equivalent to . Type Marked | |
| \`tabSize\` tab-size | \`number\` The tab stop width used when converting leading tabs to spaces during whitespace normalization. Type Default 4 | |

### Methods

| Name | Description | Arguments |
| --- | --- | --- |
| \`getMarked()\` | \`\` Returns the shared Marked instance used by all components. | |
| \`renderMarkdown()\` | Reads the script content, normalizes whitespace, parses markdown, and injects the result. | |
| \`updateAll()\` | \`\` Re-renders all connected instances. Call this after changing the Marked configuration. | |

### SSR

Learn more about [Server-Side Rendering (SSR)](https://webawesome.com/docs/ssr).

`<wa-markdown>` parses the content of its children at runtime, which requires a DOM. It can't render during SSR — use it on the client only.

## Examples

### Providing Content

Markdown must go inside a `<script type="text/markdown">` element, which must be a direct child of the markdown component. (The script is required to prevent the browser from parsing the content.) The rendered output is placed in the light DOM where it inherits your page's styles.

```html
<wa-markdown>
  <script type="text/markdown">
    Markdown with `<angle brackets>` and **formatting** that won't get parsed as HTML.
  </script>
</wa-markdown>
```

The [Marked](https://marked.js.org/) library is used under the hood to render markdown. Marked supports [GitHub Flavored Markdown](https://github.github.com/gfm/) (GFM) and the [CommonMark](https://commonmark.org/) specification. This includes headings, bold, italic, links, images, lists, blockquotes, code blocks, tables, task lists, strike-through, and auto-links. For a full breakdown of supported syntax, see the [Marked documentation](https://marked.js.org/#specifications).

### Whitespace Normalization

Indentation inside the script is automatically normalized before the markdown parser sees it. This lets you indent your content to match the surrounding HTML without it being treated as a code block. The normalization process:

1.  Converts leading tabs to spaces based on the configured tab stop width (default: 4)
2.  Trims blank lines from the start and end
3.  Determines the smallest indentation shared by all non-empty lines
4.  Removes that common prefix from every line

This means you can write markdown at any indentation level and it will render correctly. Even if the content is indented by 8 spaces to match the HTML structure, the output renders as though it had no extra indentation at all.

```html
<wa-markdown>
  <script type="text/markdown">
    ## Deeply Indented

    Even though this content is heavily indented in the source,
    the shared whitespace is stripped before parsing.

        Lines with extra indentation beyond the common
        prefix are preserved, like this code block.
  </script>
</wa-markdown>
```

For tab-indented source files, adjust the tab stop width with the `tab-size` attribute.

```html
<wa-markdown tab-size="2">
  <script type="text/markdown">
    ...
  </script>
</wa-markdown>
```

### Formatting Features

All standard markdown formatting supported by Marked is available, including headings, lists, blockquotes, code blocks, links, and images.

```html
<wa-markdown>
  <script type="text/markdown">
    ## Feature Overview

    Steps to set up your project:

    1. Clone the repository
    2. Install dependencies
    3. Run the dev server

    A relevant quote:

    > "Simplicity is the ultimate sophistication." — Leonardo da Vinci

    And an autolink: <https://developer.mozilla.org>
  </script>
</wa-markdown>
```

### Configuring Marked

All `<wa-markdown>` instances share a single [Marked](https://marked.js.org/using_advanced) instance. You can access it through any `<wa-markdown>` element's `marked` property. After making changes, call `WaMarkdown.updateAll()` to re-render every connected instance.

```html
<wa-markdown id="markdown__config">
  <script type="text/markdown">
    Visit https://developer.mozilla.org for documentation.
  </script>
</wa-markdown>

<script type="module">
  await customElements.whenDefined('wa-markdown');
  const md = document.getElementById('markdown__config');

  await new Promise(requestAnimationFrame);

  // Customize the link renderer to open links in a new tab
  const renderer = {
    link(href, title, text) {
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener">${text}</a>`;
    },
  };

  md.marked.use({ renderer });
  md.renderMarkdown();
</script>
```

**The Marked configuration is shared across every instance.** To make all `<wa-markdown>` elements pick up a change, call `WaMarkdown.updateAll()` instead of `renderMarkdown()` on a single element.

### Writing a Custom Marked Plugin

Custom [Marked extensions](https://marked.js.org/using_advanced#extensions) can be applied through any element's `marked` property. The example below adds support for `==highlight==` syntax, wrapping matched text in `<mark>` tags.

```html
<wa-markdown id="markdown__plugin">
  <script type="text/markdown">
    This text has a ==highlighted phrase== in the middle.
  </script>
</wa-markdown>

<script type="module">
  await customElements.whenDefined('wa-markdown');
  const md = document.getElementById('markdown__plugin');

  const highlight = {
    extensions: [
      {
        name: 'highlight',
        level: 'inline',
        start(src) {
          return src.indexOf('==');
        },
        tokenizer(src) {
          const match = src.match(/^==([^=]+)==/);
          if (match) {
            return {
              type: 'highlight',
              raw: match[0],
              text: match[1],
            };
          }
        },
        renderer(token) {
          return `<mark>${token.text}</mark>`;
        },
      },
    ],
  };

  md.marked.use(highlight);
  md.renderMarkdown();
</script>
```

### Updating Content Dynamically

The component parses and renders automatically when the script element is first slotted in. It does not watch for subsequent changes to the script's content. To re-render after modifying the source, update the script's `textContent` and call `renderMarkdown()`.

```html
<div id="markdown__dynamic">
  <wa-markdown id="markdown__dynamic-md">
    <script type="text/markdown">
      Click the button to swap this content out.
    </script>
  </wa-markdown>
  <br />
  <wa-button>Update content</wa-button>
</div>

<script type="module">
  await customElements.whenDefined('wa-markdown');
  const md = document.getElementById('markdown__dynamic-md');
  const button = document.querySelector('#markdown__dynamic wa-button');
  const script = md.querySelector('script[type="text/markdown"]');

  button.addEventListener('click', () => {
    script.textContent = '## Fresh Content\n\nThis was **swapped in** by calling `renderMarkdown()`.';
    md.renderMarkdown();
  });
</script>
```
