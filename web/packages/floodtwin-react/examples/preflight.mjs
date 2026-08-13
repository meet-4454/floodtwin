#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * FloodTwin preflight — check a key before you write any code.
 *
 *   node preflight.mjs --key ft_live_… --upstream https://twin.example.com
 *
 * or with the environment your proxy will use:
 *
 *   FLOODTWIN_API_KEY=… FLOODTWIN_UPSTREAM=… node preflight.mjs
 *
 * Answers, in order: can I reach it, is my key good, what am I allowed to do,
 * does real data come back, and is caching working. Every failure prints what to
 * change rather than just a status code.
 *
 * Zero dependencies — Node 18+ only. Safe to run repeatedly; it fetches one
 * small file per scope and nothing billed beyond a single probe.
 * ─────────────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const KEY = arg('key') || process.env.FLOODTWIN_API_KEY || '';
const UPSTREAM = (arg('upstream') || process.env.FLOODTWIN_UPSTREAM || '').replace(/\/+$/, '');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

if (!UPSTREAM) {
  console.error(R('\n  No upstream given.\n'));
  console.error('  node preflight.mjs --key ft_live_… --upstream https://twin.example.com\n');
  console.error('  Ask AIResQ for the FloodTwin base URL if you do not have it.\n');
  process.exit(2);
}
if (!KEY) {
  console.error(R('\n  No key given.\n'));
  console.error('  node preflight.mjs --key ft_live_… --upstream ' + UPSTREAM + '\n');
  process.exit(2);
}

const hdr = { 'X-FloodTwin-Key': KEY };
let failed = 0;
const warn = [];

async function probe(path, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(UPSTREAM + path, { headers: { ...hdr, ...opts.headers } });
    return { res, ms: Date.now() - t0 };
  } catch (err) {
    return { err, ms: Date.now() - t0 };
  }
}

console.log(`\n  FloodTwin preflight`);
console.log(D(`  upstream  ${UPSTREAM}`));
console.log(D(`  key       ${KEY.slice(0, 12)}…${KEY.slice(-4)} (${KEY.length} chars)\n`));

// ── 1. Reachability ─────────────────────────────────────────────────────────
// /healthz is public, so this separates "network/DNS/firewall" from "key".
{
  const { res, err, ms } = await probe('/healthz');
  if (err) {
    console.log(`  ${R('✗')} unreachable — ${err.message}`);
    console.log(D('      Check the URL, DNS, and that your network can egress to it.'));
    console.log(D('      Nothing below can run until this passes.\n'));
    process.exit(1);
  }
  if (res.status === 200) {
    const body = await res.json().catch(() => ({}));
    const degraded = body.status !== 'ok';
    console.log(`  ${degraded ? Y('!') : G('✓')} reachable — ${body.status || res.status} ${D(`${ms}ms`)}`);
    if (degraded) {
      warn.push('Server reports degraded health; data may be incomplete.');
      console.log(D(`      checks: ${JSON.stringify(body.checks || {})}`));
    }
  } else {
    console.log(`  ${Y('!')} reachable but /healthz returned ${res.status}`);
    console.log(D('      Something is in front of FloodTwin (proxy? auth wall?) intercepting requests.'));
    warn.push('/healthz did not return 200.');
  }
}

// ── 2. Is the key accepted at all? ──────────────────────────────────────────
{
  const { res } = await probe('/sim/manifest.json');
  if (!res) { console.log(`  ${R('✗')} key check failed to complete\n`); process.exit(1); }

  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    console.log(`  ${R('✗')} key rejected — ${body.error || res.status}`);
    if (body.error === 'key_required') {
      console.log(D('      The header was not seen. If you are running this through your own'));
      console.log(D('      proxy, point --upstream at FloodTwin directly instead.'));
    } else {
      console.log(D('      The key is unknown, mistyped or revoked. Check for a truncated'));
      console.log(D('      copy-paste, then ask AIResQ to confirm it is active.'));
    }
    console.log();
    process.exit(1);
  }
  if (res.status === 200) {
    const man = await res.json().catch(() => ({}));
    console.log(`  ${G('✓')} key accepted`);
    console.log(D(`      dataset: ${man.n_hours ?? '?'} frames, ${man.n_nodes?.toLocaleString?.() ?? '?'} nodes, ${man.n_links?.toLocaleString?.() ?? '?'} links`));
  } else {
    console.log(`  ${Y('!')} unexpected ${res.status} on /sim/manifest.json`);
    failed++;
  }
}

// ── 3. Which scopes does this key actually carry? ───────────────────────────
// One cheap request per scope. `assets` and `geocode` are billed, so each is
// probed exactly once and with the smallest possible query.
const SCOPES = [
  ['sim', '/sim/manifest.json', 'Simulation data. Required — nothing works without it.'],
  ['drainage', '/drainage/outfalls.geojson', 'The 3-D pipe network and its inventories.'],
  ['config', '/api/config', 'Serves AIResQ\'s Mappls key. Not needed if you pass your own.'],
  ['live', '/api/live-forecast/latest', 'Daily forecast run metadata.'],
  ['assets', '/api/assets', 'Critical assets (hospitals, schools…). Billed.'],
  ['geocode', '/api/locality?pts=28.4595,77.0266', 'Search + hotspot names. Billed.'],
  ['route', '/api/route?pts=77.02,28.45;77.03,28.46', 'Routing. Billed.'],
];

console.log(`\n  ${D('scopes')}`);
const granted = [];
const denied = [];
for (const [scope, path, why] of SCOPES) {
  const { res } = await probe(path);
  if (!res) { console.log(`  ${Y('!')} ${scope.padEnd(9)} probe failed`); continue; }
  if (res.status === 403) {
    denied.push(scope);
    console.log(`  ${D('·')} ${scope.padEnd(9)} ${D('not granted')}  ${D(why)}`);
  } else if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    console.log(`  ${Y('!')} ${scope.padEnd(9)} ${Y(body.error === 'quota_exceeded' ? 'quota spent' : 'rate limited')}`);
    warn.push(`${scope}: ${body.error} — retry after ${res.headers.get('Retry-After')}s`);
  } else if (res.status < 400) {
    granted.push(scope);
    console.log(`  ${G('✓')} ${scope.padEnd(9)} ${D(why)}`);
  } else if (res.status === 502 || res.status === 503) {
    // Scope is granted; the UPSTREAM third party (Google, Mappls) is unhappy.
    granted.push(scope);
    console.log(`  ${Y('!')} ${scope.padEnd(9)} granted, but returned ${res.status} ${D('(third-party API not configured upstream)')}`);
    warn.push(`${scope} is granted but its upstream provider errored (${res.status}).`);
  } else {
    console.log(`  ${Y('!')} ${scope.padEnd(9)} unexpected ${res.status}`);
  }
}

if (!granted.includes('sim')) {
  console.log(`\n  ${R('✗')} Without the sim scope the console cannot start. Ask for it.`);
  failed++;
}

// ── 4. Real payload, not just a 200 ─────────────────────────────────────────
console.log(`\n  ${D('data transfer')}`);
{
  const { res, ms } = await probe('/sim/surface_grid_00.bin');
  if (res?.status === 200) {
    const buf = await res.arrayBuffer();
    const enc = res.headers.get('content-encoding');
    console.log(`  ${G('✓')} first depth grid — ${(buf.byteLength / 1024).toFixed(0)} KB ${D(`${ms}ms${enc ? `, ${enc}` : ''}`)}`);
    if (buf.byteLength === 0) { console.log(`  ${R('✗')} empty body`); failed++; }
  } else {
    console.log(`  ${R('✗')} could not fetch a depth grid (${res?.status})`);
    failed++;
  }
}

// ── 5. Usage + quota reporting ──────────────────────────────────────────────
{
  const { res } = await probe('/api/usage');
  if (res?.status === 200) {
    const u = await res.json();
    const t = u.today || {};
    const lim = u.limits || {};
    console.log(`  ${G('\u2713')} usage reporting available`);
    console.log(D(`      key ${u.key?.id} \u2014 ${(u.key?.scopes || []).join(', ')}`));
    console.log(D(`      today: ${t.calls ?? 0} calls, ${t.billed_calls ?? 0} billed, ` +
                  `${((t.bytes ?? 0) / 1e6).toFixed(1)} MB`));
    console.log(D(`      quota: ${t.quota_remaining ?? 'unmetered'} of ` +
                  `${lim.daily_billed_quota ?? '?'} left, resets ${t.resets_at ?? '?'}`));
    if (t.quota_exhausted) {
      warn.push('Daily billed quota is already exhausted for today.');
    }
  } else {
    console.log(`  ${Y('!')} /api/usage returned ${res?.status}`);
    warn.push('Usage reporting is unavailable; ask AIResQ to update the deployment.');
  }
}

// ── 6. Caching — the difference between a fast integration and a slow one ───
{
  const first = await probe('/sim/manifest.json');
  const etag = first.res?.headers.get('etag');
  if (!etag) {
    console.log(`  ${Y('!')} no ETag on the manifest`);
    warn.push('No ETag seen — repeat loads will re-download everything.');
  } else {
    const { res } = await probe('/sim/manifest.json', { headers: { 'If-None-Match': etag } });
    if (res?.status === 304) {
      console.log(`  ${G('✓')} conditional requests work ${D('(304 — repeat loads stay cheap)')}`);
    } else {
      console.log(`  ${Y('!')} expected 304 on If-None-Match, got ${res?.status}`);
      warn.push('Revalidation is not returning 304; check anything sitting in front of FloodTwin.');
    }
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log();
if (warn.length) {
  console.log(`  ${Y('warnings')}`);
  for (const w of warn) console.log(D(`   · ${w}`));
  console.log();
}

if (failed) {
  console.log(R(`  ${failed} blocking problem(s). See above.\n`));
  process.exit(1);
}

console.log(G('  Preflight passed.\n'));
console.log('  Next: put this key in your server environment (never in the browser),');
console.log('  mount the proxy, and render the console:\n');
console.log(D('    <FloodTwinConsole baseUrl="/api/floodtwin" />\n'));
if (denied.length) {
  console.log(D(`  Scopes you do NOT have: ${denied.join(', ')}.`));
  console.log(D('  The console degrades gracefully without them — ask AIResQ if you need one.\n'));
}
