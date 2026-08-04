import { html } from 'hono/html';
import { getClientAssets } from '../assets.js';

const assets = getClientAssets();

export type HtmlContent = ReturnType<typeof html>;

export function Layout(props: { title: string; content: HtmlContent }) {
  return html`<!DOCTYPE html>
<html lang="en" class="wa-theme-shoelace wa-palette-shoelace">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${props.title}</title>
  ${assets.css.map((href) => html`<link rel="stylesheet" href="${href}">`)}
  <script>
    (function () {
      try {
        var dark = localStorage.getItem('wa-color-scheme');
        if (dark === null) dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        else dark = dark === 'dark';
        if (dark) document.documentElement.classList.add('wa-dark');
      } catch (e) {}
    })();
  </script>
  <script type="module" src="${assets.js}"></script>
</head>
<body>
  ${props.content}
</body>
</html>`;
}
