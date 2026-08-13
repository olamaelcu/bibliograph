import animateCountUp from 'countup-animation';

type Counter = { el: HTMLElement; last: number };

function setup(): void {
  const bookEl = document.getElementById('book-count');
  const statusEl = document.getElementById('status-count');
  const contributorEl = document.getElementById('contributor-count');
  const sseStatusEl = document.getElementById('sse-status');
  if (!bookEl || !statusEl || !contributorEl || !sseStatusEl) return;
  const sseStatus: HTMLElement = sseStatusEl;

  const fields: Record<'books' | 'statuses' | 'contributors', Counter> = {
    books: { el: bookEl, last: 0 },
    statuses: { el: statusEl, last: 0 },
    contributors: { el: contributorEl, last: 0 },
  };

  function animateField(field: Counter, newValue: number): void {
    field.el.innerText = String(newValue - field.last);
    animateCountUp(field.el, 5000, null, field.last);
    field.last = newValue;
  }

  function connect(): void {
    sseStatus.textContent = 'connecting\u2026';
    const es = new EventSource('/api/live-counts');
    es.onmessage = (e: MessageEvent<string>) => {
      const data = JSON.parse(e.data) as { books: number; statuses: number; contributors: number };
      animateField(fields.books, data.books);
      animateField(fields.statuses, data.statuses);
      animateField(fields.contributors, data.contributors);
      sseStatus.textContent = 'live';
    };
    es.onerror = () => {
      sseStatus.textContent = 'reconnecting\u2026';
      es.close();
      setTimeout(connect, 3000);
    };
  }
  connect();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setup);
} else {
  setup();
}
