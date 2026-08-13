/* ─────────────────────────────────────────────────────────────────────────────
 * Reference proxy — Next.js App Router.
 *
 * Save as: app/api/floodtwin/[...path]/route.ts
 * Then:    <FloodTwinConsole baseUrl="/api/floodtwin" />
 *
 * Set FLOODTWIN_API_KEY in the server environment. Do NOT name it
 * NEXT_PUBLIC_ANYTHING — that prefix is exactly what inlines a value into the
 * client bundle, which is the one thing a secret key must never be.
 *
 * `runtime = 'nodejs'` is deliberate: the edge runtime caps response sizes in a
 * way the simulation binaries exceed.
 * ─────────────────────────────────────────────────────────────────────────── */
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
// The upstream sets its own cache headers per file (immutable for the hashed
// binaries, no-store for the JSON). Let those through rather than having Next
// impose a blanket policy of its own.
export const dynamic = 'force-dynamic';

const UPSTREAM = (process.env.FLOODTWIN_UPSTREAM || 'https://twin.floodresq.com')
  .replace(/\/+$/, '');

/** Keep in sync with FLOODTWIN_PATHS exported by the package. */
const ALLOWED = [
  '/api/config', '/api/assets', '/api/locality', '/api/geocode/', '/api/route',
  '/api/live-forecast/', '/api/usage',
  '/sim/', '/live/', '/drainage/',
  '/Gurugram_wards.geojson', '/Gurugram_district.geojson',
];

const STRIP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-encoding',
  'content-length',
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const key = process.env.FLOODTWIN_API_KEY;
  if (!key) {
    return Response.json({ error: 'FLOODTWIN_API_KEY is not set' }, { status: 500 });
  }

  const { path } = await params;
  const rel = `/${(path || []).join('/')}`;
  if (!ALLOWED.some((p) => rel === p || rel.startsWith(p))) {
    return Response.json({ error: 'not_a_floodtwin_path', path: rel }, { status: 404 });
  }

  const search = req.nextUrl.search || '';
  const headers: Record<string, string> = { 'X-FloodTwin-Key': key };
  // Forward validators so a repeat visit gets a 304 instead of re-downloading
  // megabytes of simulation binary.
  const inm = req.headers.get('if-none-match');
  const ims = req.headers.get('if-modified-since');
  if (inm) headers['If-None-Match'] = inm;
  if (ims) headers['If-Modified-Since'] = ims;

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}${rel}${search}`, { headers, redirect: 'follow' });
  } catch (err) {
    return Response.json({ error: 'floodtwin_unreachable', detail: String(err) },
                         { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((v, k) => { if (!STRIP.has(k.toLowerCase())) out.set(k, v); });

  if (upstream.status === 304 || upstream.status === 204) {
    return new Response(null, { status: upstream.status, headers: out });
  }
  // upstream.body is a ReadableStream — returned directly, so a 3 MB binary is
  // never buffered in the route handler.
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
