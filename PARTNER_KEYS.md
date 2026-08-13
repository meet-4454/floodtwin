# Issuing FloodTwin partner keys

Operator-side guide: how to give a third party access to the FloodTwin backend,
and what that access is bounded by. The partner-facing counterpart is
`web/packages/floodtwin-react/INTEGRATION.md`.

## The model in one paragraph

A partner embeds `@airesq/floodtwin-react` in their own frontend. That component
talks to **their** server, which proxies to us with a secret key in the
`X-FloodTwin-Key` header. The key never enters a browser, so there is no CORS
configuration and no origin allowlist to maintain — our traffic from a partner is
server-to-server. What we control is the key: its scopes, its rate, its daily
quota on the endpoints that cost money, and whether it works at all.

## Issue a key

```bash
python scripts/issue_key.py --name "MCG Gurugram" --scopes '*'
```

The key is printed **once**. Only its SHA-256 goes into `keys.json`, so it cannot
be recovered afterwards — if a partner loses theirs, revoke and reissue. Send it
the way you would send a password, and tell them it belongs on their server.

```bash
python scripts/issue_key.py --list              # who has access
python scripts/issue_key.py --revoke mcg-a1b2c3 # disable, effective immediately
```

Revocation does not need a restart: `keys.json` is re-read whenever its mtime
changes. Revoked keys are disabled in place rather than deleted, so last week's
audit lines still resolve to a name.

### Choosing scopes

Grant the minimum that makes their integration work.

| Scope | Grants | Cost to us |
|---|---|---|
| `sim` | `/sim/*`, `/live/*`, `wards_gurugram.geojson` | Bandwidth only |
| `drainage` | `/drainage/*` | Bandwidth only |
| `config` | `/api/config` — hands out **our** Mappls key | See below |
| `live` | `/api/live-forecast/*` | Cached upstream calls |
| `assets` | `/api/assets` | **Billed** — ~96 Google Places calls per cold build |
| `geocode` | `/api/geocode/*`, `/api/locality` | **Billed** — Google / Nominatim |
| `route` | `/api/route` | **Billed** — Mappls routing |

`--scopes '*'` grants everything, which is the current arrangement: partners are
cleared to use our Mappls and Google Places quota.

**On `config`:** this endpoint hands the browser our Mappls SDK key, which is
visible to any visitor by design (it is in the SDK script URL). Granting it means
their users load the map on our Mappls quota — intended here, but it makes two
things your job:

* **Add their domains to the Mappls key's referrer allowlist**, including
  staging and preview origins. Until you do, their map silently fails to load.
* Keep the key referrer-restricted. It is the only thing standing between a
  browser-visible key and anyone else's traffic on your bill.

A partner who prefers their own Mappls key passes `mapplsApiKey` to the
component and never touches `/api/config`.

**Cost bounds already in place.** Because partner traffic now lands on our
Google bill, the two endpoints that could run it up are bounded server-side:
`/api/assets` snaps its bbox to a ~1.1 km grid and refuses anything outside
Gurugram (each distinct bbox is a ~96-call cold build, so unbounded bboxes meant
unbounded spend), and the geocode endpoints are cached (15 min for suggestions,
7 days for resolved places). Set a Google Cloud budget alert regardless.

### Limits

```bash
--rate 300     # requests/minute, burst-tolerant token bucket (default 600)
--quota 1000   # daily cap on BILLED scopes only; 0 = unmetered (default 5000)
```

A cold console load is legitimately ~40 requests in a few seconds, so the bucket
is sized to absorb bursts and hold the minute rate. The daily quota applies only
to `assets` / `geocode` / `route`; bulk data egress is bounded by the rate limit.

The two limits are enforced differently, on purpose:

* **The daily quota is exact**, shared across all gunicorn workers via SQLite
  (`usage.py`). It has to be — it is the number reported back to the partner by
  `/api/usage`, and four workers each counting their own quarter would have made
  that report wrong by a factor of the worker count.
* **The rate limit is per process**, so with N workers the real ceiling is N×
  `--rate`. That is fine: it bounds bursts, N× a bound is still a bound, and
  putting shared state on the hot path of every binary request would cost more
  than it is worth.

## What is gated

Everything except the app's own public surface. The gate is a single
`before_request` hook (`floodtwin/gate.py`) with an explicit public allowlist, so
a route added tomorrow is protected by default rather than accidentally open.

**Public:** `/`, `/twin`, `/healthz`, `/assets/*`, `/media/*`, `/static/*`,
`/api/auth/*`, and `/api/live-forecast/status` (freshness metadata the public
landing page renders; its heavy siblings stay gated).

**Everything else** needs either a valid key **or** the console session cookie.
Our own console is unaffected — it authenticates with the cookie exactly as
before, and the `/twin` login is unchanged.

Responses are always JSON:

| Status | Body | Meaning |
|---|---|---|
| 401 | `key_required` | No credential presented |
| 401 | `invalid_key` | Unknown, malformed, or revoked — deliberately indistinguishable |
| 403 | `scope_denied` | Valid key, wrong scope; body names it |
| 429 | `rate_limited` | Over the per-minute bucket; `Retry-After` set |
| 429 | `quota_exceeded` | Daily billed quota spent; resets UTC midnight |

## Which variable goes where

Four similarly-named settings, on two different machines. Getting these confused
is the most likely misconfiguration, because `FLOODTWIN_PARTNER_API_KEY` already
exists in our `.env` and means the opposite of what it sounds like.

| Variable | Machine | Meaning |
|---|---|---|
| `FLOODTWIN_UPSTREAM` | **Partner's server** | Our public base URL. We never read this. |
| `FLOODTWIN_API_KEY` *(singular)* | **Partner's server** | The secret we issued them. We never read this either — we only ever see it as a request header. |
| `FLOODTWIN_API_KEYS` *(plural)* | Ours, optional | Inline JSON array of key *records* (hashes), for platforms that offer only env vars. `keys.json` is the default and is usually better. |
| `FLOODTWIN_KEYS_FILE` | Ours, optional | Path override for `keys.json`. |
| `FLOODTWIN_PARTNER_API_KEY` | Ours, **already set** | **Unrelated.** The key *we* hold to call MCG's forecast API — inbound, not outbound. Do not overwrite it; `/api/live-forecast/*` depends on it. |

**Issuing a key requires no change to our `.env`.** The CLI writes `keys.json`
and that is the whole configuration.

> **Issue keys on the machine that runs the server.** `issue_key.py` writes
> `keys.json` into its own directory, so a key issued on a dev checkout is
> invisible to production and the partner will get `invalid_key`. Either run the
> command on the production host, or copy `keys.json` across afterwards.

## Storage and configuration

Keys live in `keys.json` beside `.env` (override with `FLOODTWIN_KEYS_FILE`), or
inline in `FLOODTWIN_API_KEYS` as JSON for platforms that only offer env vars.
**Add `keys.json` to your backup set and keep it out of git** — it holds no
usable credentials, but losing it revokes every partner at once.

Usage accounting lives in `usage.db` (SQLite, WAL mode) beside it. Also
gitignored; back it up if you ever bill against the figures. Deleting it resets
every counter to zero and frees each key's quota for the day.

`FLOODTWIN_CORS_ORIGINS` exists but should stay empty. It is for a hypothetical
future direct-from-browser tier; the partner-proxy model needs no CORS.

## Usage and auditing

### The numbers partners see

`GET /api/usage` reports a key's own consumption: calls, billed calls, bytes,
per-scope breakdown, quota remaining and 30 days of history. It needs no scope,
is never rate-limited and is never billed — a partner must always be able to
find out that they are throttled.

Counts are **exact across gunicorn workers**. They are kept in SQLite
(`usage.db`), not in process memory, precisely because they are reported: four
workers each holding their own counter would have reported roughly a quarter of
actual usage, varying by which worker answered. The rate limiter is still
per-process, which is fine — it bounds bursts rather than being quoted to anyone.

### The operator view

```bash
python scripts/issue_key.py --usage            # per key, last 30 days
python scripts/issue_key.py --usage --days 7
```

```
KEY                        NAME                   CALLS   BILLED       DATA  LAST SEEN
mcg-gurugram-0bb6c2        MCG Gurugram          128,441      412     4.7 GB  2026-08-13
```

It flags any key past 80 % of its daily billed quota, which is the number to
watch — `BILLED` is what lands on the Google/Mappls bill; `CALLS` and `DATA` are
just bandwidth.

### Request log

Every keyed request also logs one line to stderr (journald under systemd):

```
key=mcg-a1b2c3 scope=assets GET /api/assets -> 200 84.2ms 13904B quota=137/1000
```

Session traffic is not logged this way — that is our own console and would drown
the signal. To see whether a partner is leaning on the billed endpoints:

```bash
journalctl -u floodtwin | grep 'scope=assets' | tail -50
```

Failed requests (4xx/5xx) are recorded but **not billed**, so a partner's
scope misconfiguration shows up as `errors` in their report without costing
either side quota.
