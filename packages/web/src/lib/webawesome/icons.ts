// Lucide icons, registered as a Web Awesome icon library.
//
// The SVGs are imported as asset URLs rather than inlined, and the mutator
// rewrites their fill/stroke so `<wa-icon>` can size and colour them with
// `currentColor` — the same approach Livtet uses.
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

import arrowRightUrl from 'lucide-static/icons/arrow-right.svg?url';
import bookOpenUrl from 'lucide-static/icons/book-open.svg?url';
import chevronRightUrl from 'lucide-static/icons/chevron-right.svg?url';
import circleCheckUrl from 'lucide-static/icons/circle-check.svg?url';
import circleStarUrl from 'lucide-static/icons/circle-star.svg?url';
import copyUrl from 'lucide-static/icons/copy.svg?url';
import databaseUrl from 'lucide-static/icons/database.svg?url';
import keyRoundUrl from 'lucide-static/icons/key-round.svg?url';
import layersUrl from 'lucide-static/icons/layers.svg?url';
import listUrl from 'lucide-static/icons/list.svg?url';
import moonUrl from 'lucide-static/icons/moon.svg?url';
import networkUrl from 'lucide-static/icons/network.svg?url';
import searchUrl from 'lucide-static/icons/search.svg?url';
import sendUrl from 'lucide-static/icons/send.svg?url';
import shieldCheckUrl from 'lucide-static/icons/shield-check.svg?url';
import squarePenUrl from 'lucide-static/icons/square-pen.svg?url';
import sunUrl from 'lucide-static/icons/sun.svg?url';
import terminalUrl from 'lucide-static/icons/terminal.svg?url';
import userRoundUrl from 'lucide-static/icons/user-round.svg?url';
import waypointsUrl from 'lucide-static/icons/waypoints.svg?url';

const iconUrls = {
  'arrow-right': arrowRightUrl,
  'book-open': bookOpenUrl,
  'chevron-right': chevronRightUrl,
  'circle-check': circleCheckUrl,
  'circle-star': circleStarUrl,
  copy: copyUrl,
  database: databaseUrl,
  'key-round': keyRoundUrl,
  layers: layersUrl,
  list: listUrl,
  moon: moonUrl,
  network: networkUrl,
  search: searchUrl,
  send: sendUrl,
  'shield-check': shieldCheckUrl,
  'square-pen': squarePenUrl,
  sun: sunUrl,
  terminal: terminalUrl,
  'user-round': userRoundUrl,
  waypoints: waypointsUrl
} as const;

export type IconName = keyof typeof iconUrls;

const fallbackUrl = searchUrl;

registerIconLibrary('lucide', {
  resolver: (iconName) => {
    if (iconName in iconUrls) return iconUrls[iconName as IconName];
    if (import.meta.env.DEV) {
      console.warn(
        `[webawesome] unknown lucide icon "${iconName}". Known names: ${Object.keys(iconUrls).join(', ')}`
      );
    }
    return fallbackUrl;
  },
  mutator: (svg) => {
    // Lucide ships fixed stroke attributes; `currentColor` is what lets
    // `<wa-icon variant>` and surrounding text colour apply.
    for (const element of svg.querySelectorAll('path, rect, line, circle')) {
      element.setAttribute('fill', 'none');
      element.setAttribute('stroke', 'currentColor');
    }
  }
});
