// Web Awesome — Shoelace theme + palette (light + dark)
import '@awesome.me/webawesome/dist/styles/themes/shoelace.css';
import '@awesome.me/webawesome/dist/styles/color/palettes/shoelace.css';
import '@awesome.me/webawesome/dist/styles/native.css';
import '@awesome.me/webawesome/dist/styles/utilities.css';

// Cherry-picked components (side-effect registration)
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/copy-button/copy-button.js';
import '@awesome.me/webawesome/dist/components/skeleton/skeleton.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';

// Lucide icons, bundled locally (Web Awesome lucide guide, resolver -> local URLs)
import { registerIconLibrary } from '@awesome.me/webawesome/dist/webawesome.js';
import iconBookOpen from 'lucide-static/icons/book-open.svg?url';
import iconBook from 'lucide-static/icons/book.svg?url';
import iconBookmarkCheck from 'lucide-static/icons/bookmark-check.svg?url';
import iconRss from 'lucide-static/icons/rss.svg?url';
import iconExternalLink from 'lucide-static/icons/external-link.svg?url';
import iconHome from 'lucide-static/icons/home.svg?url';
import iconShieldCheck from 'lucide-static/icons/shield-check.svg?url';
import iconRadio from 'lucide-static/icons/radio.svg?url';
import iconFileText from 'lucide-static/icons/file-text.svg?url';
import iconSquarePen from 'lucide-static/icons/square-pen.svg?url';
import iconList from 'lucide-static/icons/list.svg?url';

import './live-counts.js';

const icons: Record<string, string> = {
  'book-open': iconBookOpen,
  book: iconBook,
  'bookmark-check': iconBookmarkCheck,
  rss: iconRss,
  'external-link': iconExternalLink,
  home: iconHome,
  'shield-check': iconShieldCheck,
  radio: iconRadio,
  'file-text': iconFileText,
  'square-pen': iconSquarePen,
  list: iconList,
};

registerIconLibrary('lucide', {
  resolver: (name) => icons[name],
  mutator: (svg) => {
    svg.querySelectorAll('path').forEach((p) => {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
    });
  },
});
