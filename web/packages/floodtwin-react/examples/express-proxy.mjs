/* ─────────────────────────────────────────────────────────────────────────────
 * Reference proxy — Express, Connect, Vite, or plain node:http.
 *
 * The handler only uses the plain Node response API (statusCode / setHeader /
 * end), never Express's res.status().json(), so the same function mounts in any
 * of them — including as Vite dev middleware, which is what lets the starter
 * example run as ONE process instead of a server plus a dev server.
 *
 * Named .mjs so it is unambiguously an ES module: this file uses `import`, and
 * dropped into a CommonJS project as `.js` it would fail to parse. Copy it as-is,
 * or convert the two imports to `require` if your server is CJS.
 *
 * This is the piece that makes the key model work: your FRONTEND calls your own
 * origin, this handler forwards to FloodTwin with the secret key attached, and
 * the key never reaches a browser.
 *
 *     app.use('/api/floodtwin', floodtwinProxy({
 *       key: process.env.FLOODTWIN_API_KEY,          // never NEXT_PUBLIC_*, never VITE_*
 *       upstream: 'https://twin.floodresq.com',
 *     }));
 *
 * and then, in your React tree:
 *
 *     <FloodTwinConsole baseUrl="/api/floodtwin" />
 *
 * TWO THINGS THIS GETS RIGHT that a five-line proxy usually does not:
 *
 *  1. IT STREAMS. A cold console load pulls ~15 MB of simulation binaries and
 *     the drainage mount alone is 2.4 MB of geometry. Buffering those into a
 *     Buffer before replying costs a copy of every byte in your server's heap
 *     per concurrent viewer. The body is piped straight through.
 *
 *  2. IT FORWARDS CACHE VALIDATORS. FloodTwin serves the heavy files with ETag
 *     and Last-Modified so a repeat visit is a 304 with no body. Drop those
 *     headers and every reload re-downloads all 15 MB — the single most common
 *     way an integration ends up feeling slow.
 * ─────────────────────────────────────────────────────────────────────────── */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Path prefixes the console actually requests. Anything else is refused here
 *  rather than forwarded — your proxy should not be an open relay to another
 *  origin, and this is the whole surface. Keep in sync with FLOODTWIN_PATHS. */
const ALLOWED = [
  '/api/config',
  '/api/assets',
  '/api/locality',
  '/api/geocode/',
  '/api/route',
  '/api/live-forecast/',
  // Not requested by the console, but forwarded so you can surface your own
  // quota in your UI. It reports only YOUR key, and is never billed.
  '/api/usage',
  '/sim/',
  '/live/',
  '/drainage/',
  '/Gurugram_wards.geojson',
  '/Gurugram_district.geojson',
];

// Hop-by-hop headers are meaningless to forward and actively break things
// (a stale content-length on a re-encoded body truncates the response).
const STRIP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
]);

/** Reply with JSON using only the plain Node API, so this works under Express,
 *  Connect, Vite's dev middleware and node:http alike. */
function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function floodtwinProxy({ key, upstream, timeoutMs = 30000 } = {}) {
  if (!key) throw new Error('floodtwinProxy: `key` is required (server-side secret).');
  if (!upstream) throw new Error('floodtwinProxy: `upstream` is required.');
  const base = upstream.replace(/\/+$/, '');

  return async function handler(req, res) {
    // req.url is relative to the mount point under app.use() / middlewares.use().
    const path = req.url.split('?')[0];
    if (!ALLOWED.some((p) => path === p || path.startsWith(p))) {
      sendJson(res, 404, { error: 'not_a_floodtwin_path', path });
      return;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    // If the viewer navigates away mid-download, stop paying for the transfer.
    //
    // `close` fires on NORMAL completion as well as on a client hang-up, so the
    // writableFinished guard is load-bearing: without it every successful
    // response aborts the stream it has just finished, and the abort surfaces as
    // an unhandled 'error' on the pipe that takes the whole process down on the
    // first binary a console requests.
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });

    try {
      const upstreamRes = await fetch(base + req.url, {
        method: 'GET',
        headers: {
          'X-FloodTwin-Key': key,
          // Pass the validators through so FloodTwin can answer 304 and the
          // browser keeps using its cached copy of a 3 MB binary.
          ...(req.headers['if-none-match'] && { 'If-None-Match': req.headers['if-none-match'] }),
          ...(req.headers['if-modified-since'] && { 'If-Modified-Since': req.headers['if-modified-since'] }),
          // Forwarding this lets FloodTwin send its pre-gzipped copies rather
          // than compressing on the fly.
          ...(req.headers['accept-encoding'] && { 'Accept-Encoding': req.headers['accept-encoding'] }),
        },
        signal: ac.signal,
        redirect: 'follow',
      });

      upstreamRes.headers.forEach((value, name) => {
        if (!STRIP_RESPONSE.has(name.toLowerCase())) res.setHeader(name, value);
      });
      res.statusCode = upstreamRes.status;

      // 204/304 carry no body, and piping a null body throws.
      if (!upstreamRes.body || upstreamRes.status === 304 || upstreamRes.status === 204) {
        res.end();
        return;
      }
      // Stream: never buffer a 3 MB binary into this process's heap.
      // pipeline() (not .pipe()) so an aborted or failed transfer is delivered
      // to a callback instead of thrown as an unhandled 'error' event, and so
      // both ends are destroyed rather than leaked.
      await pipeline(Readable.fromWeb(upstreamRes.body), res).catch(() => {
        // Client hung up or upstream stalled; nothing left to say — the headers
        // are already on the wire.
        res.destroy();
      });
    } catch (err) {
      if (ac.signal.aborted) {
        sendJson(res, 504, { error: 'floodtwin_timeout' });
      } else {
        sendJson(res, 502, { error: 'floodtwin_unreachable', detail: String(err) });
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ── Runnable demo ────────────────────────────────────────────────────────────
 *   FLOODTWIN_API_KEY=ft_live_… FLOODTWIN_UPSTREAM=http://127.0.0.1:9121 \
 *     node express-proxy.js
 * then point <FloodTwinConsole baseUrl="http://localhost:3001/api/floodtwin" />
 * at it (or proxy /api/floodtwin from your own dev server).
 */
if (process.argv[1] && /express-proxy\.[mc]?js$/.test(process.argv[1])) {
  const { default: express } = await import('express');
  const app = express();
  app.use('/api/floodtwin', floodtwinProxy({
    key: process.env.FLOODTWIN_API_KEY,
    upstream: process.env.FLOODTWIN_UPSTREAM || 'https://twin.floodresq.com',
  }));
  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => console.log(`floodtwin proxy on :${port}/api/floodtwin`));
}
