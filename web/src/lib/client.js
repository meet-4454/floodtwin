/* ─────────────────────────────────────────────────────────────────────────────
 * client.js — the one place a URL is turned into a request.
 *
 * WHY THIS EXISTS. Every fetch in the console used to be root-relative
 * ('/sim/…', '/api/…'), which silently hard-wired the app to the origin that
 * served it. That is fine for a page and fatal for a component: an embedded
 * console runs on the PARTNER's origin and must reach FloodTwin through
 * whatever path their server proxies it at.
 *
 * WHAT IT DOES NOT DO. It does not attach an API key. Partner keys are
 * server-side credentials — the partner's backend adds the key when it forwards
 * the request. Anything this module put in a header would be sitting in a
 * JS bundle, which is exactly the failure the key model is designed to avoid.
 * `headers` exists for the partner's OWN session/CSRF needs against their own
 * origin, not for ours.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * @param {object}   opts
 * @param {string}   opts.baseUrl      Prefix for every request. '' = same origin
 *                                     (our own console); '/api/floodtwin' = the
 *                                     path the partner proxies us at; an
 *                                     absolute URL also works.
 * @param {object}   opts.headers      Extra headers on every request (the
 *                                     partner's own auth against their origin).
 * @param {function} opts.fetch        fetch implementation, for tests/SSR.
 * @param {string}   opts.credentials  Passed through to fetch. Our console needs
 *                                     'same-origin' for the session cookie.
 */
export function createClient({
  baseUrl = '',
  headers = null,
  fetch: fetchImpl = null,
  credentials = undefined,
} = {}) {
  // Trailing slashes are the classic source of '//sim/manifest.json', which
  // some proxies normalise and others 404 on. Normalise once, here.
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  const url = (path) => base + (path.startsWith('/') ? path : `/${path}`);

  const init = (extra) => {
    const out = { ...extra };
    if (credentials) out.credentials = credentials;
    if (headers || extra?.headers) out.headers = { ...headers, ...extra?.headers };
    return out;
  };

  /** The raw Response. Callers that need status/headers use this. */
  const raw = (path, extra) => doFetch(url(path), init(extra));

  async function ok(path, extra) {
    const res = await raw(path, extra);
    if (!res.ok) {
      // The gate answers 401/403/429 with a JSON body naming the reason. Surface
      // it: "FloodTwin 403 on /api/assets: scope_denied" tells a partner exactly
      // which scope to ask for, where a bare "fetch failed" starts a support
      // thread.
      let detail = '';
      try {
        const body = await res.clone().json();
        detail = body?.error ? `: ${body.error}${body.scope ? ` (scope: ${body.scope})` : ''}` : '';
      } catch { /* not JSON — the status alone is the message */ }
      throw new Error(`FloodTwin ${res.status} on ${path}${detail}`);
    }
    return res;
  }

  return {
    baseUrl: base,
    url,
    raw,

    /** Parsed JSON, throwing a descriptive error on any non-2xx. */
    async json(path, extra) {
      return (await ok(path, extra)).json();
    },

    /** Parsed JSON, or null on ANY failure. For optional layers whose absence
     *  must degrade the map rather than break the boot. */
    async jsonOrNull(path, extra) {
      try {
        const res = await raw(path, extra);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    },

    /** ArrayBuffer for the simulation binaries. */
    async buffer(path, extra) {
      return (await ok(path, extra)).arrayBuffer();
    },

    /** ArrayBuffer, or null when the file is absent. For the optional
     *  drain_*_class.bin inventories. */
    async bufferOrNull(path, extra) {
      try {
        const res = await raw(path, extra);
        return res.ok ? await res.arrayBuffer() : null;
      } catch {
        return null;
      }
    },
  };
}

/** A client pointed at the serving origin — our own console's configuration. */
export const sameOriginClient = () => createClient({ credentials: 'same-origin' });
