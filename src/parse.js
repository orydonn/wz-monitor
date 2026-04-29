// In-page extraction of task cards from the /freelancer "Новые" feed.
// Runs inside the browser via page.evaluate (passed as a self-invoking string).
// Layout (as of 2026-04-29):
//   <div class="some-card-wrapper">
//     <a href="/freelancer/<id>?from=detail">…</a>
//     <div class="order-header">
//       <h3 class="title"><span>…</span></h3>
//       <div class="order-time-container ..."><div class="time-title">6ч 0м</div></div>
//       <div class="order-money-icon param price-order-in-list">
//         <div class="param-title">2000</div>
//       </div>
//     </div>
//     <div class="order-body">
//       <div class="new-order-description-container">
//         <div class="new-order-short-description">… short …</div>
//         <div class="new-order-full-description">… full …</div>
//       </div>
//     </div>
//   </div>

export const extractInPage = `(() => {
  const origin = location.origin;
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const text = (root, sel) => {
    const el = root && root.querySelector(sel);
    return el ? norm(el.textContent || '') : '';
  };

  const links = document.querySelectorAll('a[href^="/freelancer/"]');
  const seen = new Set();
  const tasks = [];

  for (const a of links) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\\/freelancer\\/(\\d+)(?:[?\\/]|$)/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const card = a.parentElement || a;

    const title =
      text(card, 'h3.title') ||
      text(card, 'h3') ||
      text(card, '.title-container') ||
      norm(a.getAttribute('title') || '') ||
      norm(a.textContent || '');

    const deadline =
      text(card, '.time-title') ||
      text(card, '.order-time-container');

    const priceRaw =
      text(card, '.price-order-in-list .param-title') ||
      text(card, '.price-order-in-list') ||
      text(card, '.order-money-icon .param-title') ||
      text(card, '[class*="price"]');
    const price = priceRaw ? (/[₽$€]/.test(priceRaw) ? priceRaw : priceRaw + ' ₽') : '';

    const description =
      text(card, '.new-order-full-description') ||
      text(card, '.new-order-short-description') ||
      text(card, '.order-body') ||
      text(card, '[class*="description"]') ||
      '';

    const url = origin + href.split('?')[0];

    tasks.push({
      id,
      title: title.slice(0, 200),
      price: price.slice(0, 80),
      deadline: deadline.slice(0, 80),
      description: description.slice(0, 600),
      url,
    });
  }

  return tasks;
})()`;
