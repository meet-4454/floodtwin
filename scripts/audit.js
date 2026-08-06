/* Provenance audit: turn on EVERY feature and record EVERY network request the
 * app makes, so each one can be traced to a named real source. Also measures
 * cold-load timing. */
const puppeteer = require('/home/meet/render-tools/node_modules/puppeteer');
const fs = require('fs');
const OUT = '/tmp/claude-1010/-home-meet-Meet/f46209d5-e81c-4f80-bd97-ddd08c379c0c/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const say = (...a) => {
  log.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  fs.writeFileSync(OUT + '/audit-result.txt', log.join('\n'));
  console.log(log[log.length - 1]);
};

(async () => {
  const b = await puppeteer.launch({
    headless: 'new', protocolTimeout: 700000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1500, height: 920 });
  const reqs = new Map();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('response', r => {
    const u = new URL(r.url());
    // collapse frame indices / tile coords so the list is readable
    const path = u.pathname.replace(/\d+/g, 'N');
    const k = `${u.host}${path}`;
    const e = reqs.get(k) || { n: 0, bytes: 0, status: new Set() };
    e.n++; e.status.add(r.status());
    reqs.set(k, e);
  });

  // ── cold load timing ──
  const t0 = Date.now();
  await p.goto('http://localhost:9121/twin', { waitUntil: 'domcontentloaded' });
  let ready = -1;
  for (let i = 0; i < 400; i++) {
    await sleep(120);
    if (!(await p.$('.boot'))) { ready = Date.now() - t0; break; }
  }
  say(`COLD LOAD to interactive: ${(ready / 1000).toFixed(2)}s  [software GL renderer]`);
  await sleep(3000);

  const click = lbl => p.evaluate(l => [...document.querySelectorAll('.lyr-feature')]
    .find(r => r.querySelector('.lyr-label').innerText.startsWith(l))
    ?.querySelector('.lyr-toggle').click(), lbl);

  // ── turn on EVERYTHING ──
  for (const f of ['Road passability', 'Critical assets', 'Sewerage network']) {
    await click(f); await sleep(7000);
  }
  await p.evaluate(() => {
    const s = window.__ftTwin.store.getState();
    for (const c of ['hospital','school','college','fire_station','police','pharmacy']) s.setFeature('assets.' + c, true);
  });
  await sleep(6000);
  await click('Drainage network');
  for (let i = 0; i < 300; i++) { await sleep(1000); if (await p.evaluate(() => !!window.__ftEngine?.layers?.drainage)) break; }
  await sleep(6000);
  say('all layers on');

  // exercise the timeline + both datasets + search + locality
  await p.evaluate(() => { const el = document.querySelector('.time-slider');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '9');
    el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(6000);
  await p.evaluate(() => [...document.querySelectorAll('.seg button')].find(x => x.textContent.includes('Live'))?.click());
  await sleep(12000);
  await p.evaluate(() => { const el = document.querySelector('.time-slider');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '60');
    el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(7000);
  await p.type('.search input', 'Cyber');
  await sleep(4000);
  say('exercised timeline, both datasets, search');

  say('');
  say('=== EVERY NETWORK REQUEST THE APP MADE ===');
  const rows = [...reqs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [k, e] of rows) say(`  ${String(e.n).padStart(4)}x  [${[...e.status].join(',')}]  ${k}`);
  say('');
  say('errors:', [...new Set(errs)].slice(0, 8).join(' | ') || 'none');
  say('DONE');
  await b.close();
})().catch(e => { say('FAIL ' + e.message); process.exit(1); });
