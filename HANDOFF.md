# Partner handoff checklist

What to send a third party so they can test the embedded console on their own
infrastructure. Operator-side; the partner's own guide is `INTEGRATION.md`
inside the package.

---

## Before you send anything: fill in the one blank

The partner's proxy needs a **publicly reachable base URL** for this backend.
Nothing in this repo records one — the service binds `0.0.0.0:9120` and whatever
sits in front of it (nginx/Caddy) is configured outside this tree.

Confirm all three, because a key is useless without them:

1. The public URL, e.g. `https://twin.floodresq.com`.
2. That it is reachable **from the partner's network**, not just yours —
   `curl -s -o /dev/null -w '%{http_code}' https://<host>/healthz` should print
   `200` from a machine outside your VPN.
3. That TLS terminates in front of it, and that `FLOODTWIN_BEHIND_PROXY=1` is
   set in the deployed `.env` (otherwise real client IPs and Secure cookies are
   both wrong).

If there is no public URL yet, that is the blocker — not the key.

---

## 1. Issue the key

```bash
cd /path/to/floodtwin3
python scripts/issue_key.py \
  --name "Partner Name" \
  --scopes '*' \
  --rate 600 --quota 2000
```

`'*'` grants every scope, which is the intended arrangement here: **the partner
is cleared to use our Mappls and Google Places quota.** That means they get the
console complete — critical assets, place search, hotspot locality names,
routing — with nothing to configure on their side and no keys of their own.

What each scope spends, so the `--quota` number is a decision rather than a
default:

| Scope | Spends | Per-request cost |
|---|---|---|
| `sim`, `drainage` | Bandwidth only | none |
| `live` | Cached partner-API calls | negligible |
| `config` | Serves **our** Mappls key to their browser | none directly |
| `assets` | Google Places | ~96 calls per *cold bucket*, then cached 6 h |
| `geocode` | Google Places / Nominatim | 1 call per *new* query, then cached |
| `route` | Mappls routing | 1 call each |

The billed endpoints are now bounded on our side (see §4), so the realistic
exposure is far lower than request volume suggests. `--quota 2000` is a
comfortable ceiling for one partner; drop it to a few hundred if you want a
tighter leash during evaluation.

The key prints **once**. It cannot be recovered — `keys.json` stores only its
SHA-256.

## 2. Build the package

```bash
cd web
npm run build:lib
cd packages/floodtwin-react && npm pack
# → airesq-floodtwin-react-1.0.0.tgz
```

The tarball is self-contained:

* `README.md` — what it is, in a page
* `INTEGRATION.md` — embedding the console (the key model, the proxy, the props)
* `API.md` — **the HTTP API**: every endpoint, request/response formats, the
  simulation binary layouts, usage/quota reporting. This is the one their
  backend team needs.
* `examples/preflight.mjs` — checks a key in five seconds
* `examples/starter/` — a runnable embed, one command
* `examples/express-proxy.mjs`, `examples/nextjs-route.ts` — reference proxies
* `examples/sample-data/` — real captured payloads + `decode.py`, a runnable
  decoder for every binary format
* `dist/` — built ESM, scoped stylesheet, TypeScript declarations

For an ongoing relationship, publish to a private registry instead
(`npm publish` — `publishConfig.access` is already `restricted`) so they get
updates with `npm update`. For a first evaluation, the tarball is simpler.

## 3. Send it

**Two separate channels.** The key is a credential; the rest is not.

| Channel | What |
|---|---|
| Password manager / secure share, one-time link | The `ft_live_…` key |
| Normal (email, Slack, drive) | The `.tgz`, the base URL, the note below |

Suggested note:

> FloodTwin console, as a React component.
>
> * Base URL: `https://<host>`
> * Your key is in the secure link sent separately. **It is a server-side
>   secret** — it belongs in your backend's environment, never in a browser
>   bundle. Anything named `NEXT_PUBLIC_*` or `VITE_*` is the wrong place.
> * All scopes are enabled, and the map and places quota is ours — you do not
>   need a Mappls or Google key of your own. Leave `mapplsApiKey` unset and the
>   console will use ours.
>
> Start here:
>
> ```bash
> tar xzf airesq-floodtwin-react-1.0.0.tgz && cd package
> node examples/preflight.mjs --key <KEY> --upstream https://<host>
> ```
>
> That checks connectivity, the key, your scopes and caching in about five
> seconds, and tells you what to fix if anything is wrong.
>
> Then, for a working embed on your machine:
>
> ```bash
> cd examples/starter
> export FLOODTWIN_API_KEY=<KEY>
> export FLOODTWIN_UPSTREAM=https://<host>
> npm install && npm run dev
> ```
>
> Docs in the tarball: `INTEGRATION.md` to embed the console, `API.md` for the
> HTTP API your backend will call (including the binary formats and
> `GET /api/usage` for quota reporting), `examples/sample-data/` for real
> payloads and a runnable decoder.

## 4. What sharing our quota actually costs

Since the partner is using our Mappls and Google Places quota, the spend is now
bounded on our side rather than by their good behaviour. Two limits were added
for exactly this:

**Bbox normalisation (`/api/assets`).** Each distinct bbox is its own cache
bucket, and a cold bucket is ~96 billed Google calls. The endpoint used to
accept any four floats, so a caller deriving a bbox from the map viewport — one
new box per pan — could have run up an unbounded bill without doing anything
that looked like abuse. Requests are now snapped to a ~1.1 km grid, clipped to
the Gurugram service area, and refused outright if they fall outside it or ask
for a region larger than the city. Distinct buckets are hard-capped at 24.

**Geocode caching.** `/api/geocode/autocomplete` and `/api/geocode/place` were
billed on *every* call, and a typeahead fires one per debounced keystroke.
Both are now cached (15 min for suggestions, 7 days for resolved coordinates,
2,000 entries), so a repeat search costs nothing.

With those in place, the practical ceiling on Google spend is roughly *number of
distinct map regions × 4 rebuilds/day*, not request volume. The per-key
`--quota` remains the hard stop.

Still worth knowing: **our Mappls key is visible in their users' browsers.** A
map SDK key is embedded in the script URL by design — that is true of any Mappls
integration, including our own console. Make sure it is referrer-restricted in
the Mappls console, and be aware the restriction list now has to include the
partner's domains or their map will not load.

---

## What they will report back, and what it means

| They say | It is |
|---|---|
| "401 key_required" | Their proxy is not attaching the header, or they pointed `baseUrl` straight at us instead of their proxy. |
| "401 invalid_key" | Truncated copy-paste, or you revoked it. |
| "403 scope_denied" | Working as intended — the body names the scope. Decide whether to grant it. |
| "429" | Over rate or daily quota. `--rate` / `--quota` on a reissue, or wait for UTC midnight. |
| "The page is blank" | Their container has no height. Covered in the starter README. |
| "The map never loads" | **Usually ours to fix now**: their domain is not on our Mappls key's referrer allowlist. Add it. (Only their problem if they supplied their own key.) |
| "It re-downloads everything on reload" | Their proxy is dropping `ETag`/`If-None-Match`. |
| "How much quota have we used?" | Point them at `GET /api/usage` — it answers for their own key, unmetered. Cross-check with `issue_key.py --usage`. |

To see what they are actually doing:

```bash
journalctl -u floodtwin | grep 'key=<their-key-id>' | tail -50
```

Each line carries the key id, scope, path, status, duration and quota
consumption.

## Revoking

```bash
python scripts/issue_key.py --list
python scripts/issue_key.py --revoke <key-id>
```

Effective on the next request — `keys.json` is re-read when its mtime changes,
so no restart and no interruption to anyone else.

---

## Before the first partner goes live

- [ ] Public URL confirmed reachable from outside your network
- [ ] `FLOODTWIN_BEHIND_PROXY=1` set in the deployed `.env`
- [ ] **Partner's domains added to the Mappls key's referrer allowlist.** If the
      key is restricted to our domain — as it should be — their map will simply
      never load until this is done, and the failure looks like a broken SDK
      rather than a permissions problem. Ask them for the exact hostnames,
      including their staging/preview domains.
- [ ] Google Places key's API restrictions still allow "Places API (New)", and
      billing has a budget alert set — a partner's traffic now lands on it
- [ ] `keys.json` added to your backup set — it is gitignored, and losing it
      revokes every partner at once
- [ ] `/twin` loaded once in a browser after deploying, to confirm the console
      still boots (the WebGL path is not covered by the automated checks)
