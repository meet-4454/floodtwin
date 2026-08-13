#!/usr/bin/env python3
"""Issue, list and revoke FloodTwin partner API keys.

    python scripts/issue_key.py --name "MCG" --scopes sim,drainage,assets
    python scripts/issue_key.py --list
    python scripts/issue_key.py --revoke mcg-a1b2c3

The generated key is printed ONCE. Only its SHA-256 is written to keys.json, so
there is no way to recover it afterwards — if a partner loses theirs, revoke and
issue a new one. That is deliberate: it means a leaked keys.json is a file of
hashes rather than a file of working credentials.

Hand the key to the partner over a channel you would send a password over, and
tell them it belongs on their SERVER. It is not a browser token.
"""
from __future__ import annotations

import argparse
import secrets
import sys
import types
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Import floodtwin.keys / floodtwin.usage WITHOUT executing floodtwin/__init__.py.
#
# That module builds the Flask application, so a plain `from floodtwin import
# keys` makes this CLI depend on Flask, gunicorn and everything else the server
# needs — and then dies with ModuleNotFoundError when it is run with the system
# python instead of the service's virtualenv. Issuing a key is a stdlib-only
# operation (hashlib + json + sqlite3) and should stay runnable with any python
# on the box.
#
# Registering a stub package with a __path__ lets the submachinery find the
# submodules and resolve their `from .config import …` relative imports, while
# the real __init__ never runs.
_pkg = types.ModuleType("floodtwin")
_pkg.__path__ = [str(ROOT / "floodtwin")]
sys.modules.setdefault("floodtwin", _pkg)

from floodtwin import keys as keystore   # noqa: E402
from floodtwin import usage               # noqa: E402


def _slug(name: str) -> str:
    base = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
    return (base or "partner")[:24]


def issue(args) -> int:
    scopes = [s.strip() for s in args.scopes.split(",") if s.strip()]
    unknown = [s for s in scopes if s != "*" and s not in keystore.ALL_SCOPES]
    if unknown:
        print(f"error: unknown scope(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"       valid: {', '.join(keystore.ALL_SCOPES)}, or *", file=sys.stderr)
        return 2

    existing = keystore.all_keys()
    key_id = f"{_slug(args.name)}-{secrets.token_hex(3)}"
    secret = keystore.KEY_PREFIX + secrets.token_urlsafe(32)

    record = keystore.ApiKey(
        id=key_id,
        name=args.name,
        secret_sha256=keystore.hash_secret(secret),
        scopes=scopes,
        rate_per_min=args.rate,
        daily_quota=args.quota,
        enabled=True,
        created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    )
    keystore.write_records(existing + [record])

    print(f"\n  Key issued for: {args.name}")
    print(f"  id:      {key_id}")
    print(f"  scopes:  {', '.join(scopes)}")
    print(f"  limits:  {args.rate} req/min, {args.quota} billed calls/day")
    print(f"  stored:  {keystore.KEYS_PATH}")
    print("\n  ── give this to the partner, it will not be shown again ──\n")
    print(f"  {secret}\n")
    print("  Their server sends it as:  X-FloodTwin-Key: <key>")
    print("  It must NOT be shipped to a browser.\n")
    return 0


def listing(_args) -> int:
    rows = keystore.all_keys()
    if not rows:
        print(f"No keys in {keystore.KEYS_PATH}")
        return 0
    print(f"{'ID':<26} {'NAME':<20} {'STATE':<9} {'RATE':>6} {'QUOTA':>7}  SCOPES")
    for k in rows:
        state = "active" if k.enabled else "REVOKED"
        print(f"{k.id:<26} {k.name[:20]:<20} {state:<9} {k.rate_per_min:>6} "
              f"{k.daily_quota:>7}  {','.join(k.scopes)}")
    return 0


def revoke(args) -> int:
    rows = keystore.all_keys()
    hit = [k for k in rows if k.id == args.revoke]
    if not hit:
        print(f"error: no key with id {args.revoke!r}", file=sys.stderr)
        return 2
    # Disabled in place rather than deleted: the id stays resolvable, so an audit
    # line from last week still says who made the call.
    hit[0].enabled = False
    keystore.write_records(rows)
    print(f"Revoked {args.revoke}. Takes effect on the next request — no restart "
          f"needed (keys.json is re-read when its mtime changes).")
    return 0


def usage_report(args) -> int:
    """What every key has consumed. The operator-side view of /api/usage."""
    days = args.days
    rows = usage.all_totals(days=days)
    if not rows:
        print(f"No recorded usage in the last {days} days.")
        return 0

    names = {k.id: (k.name or k.id) for k in keystore.all_keys()}
    quotas = {k.id: k.daily_quota for k in keystore.all_keys()}

    print(f"Usage over the last {days} days (UTC days; billed = Google/Mappls calls)\n")
    print(f"{'KEY':<26} {'NAME':<18} {'CALLS':>9} {'BILLED':>8} {'DATA':>10}  LAST SEEN")
    for r in rows:
        gb = r["bytes"] / 1e9
        size = f"{gb:.2f} GB" if gb >= 1 else f"{r['bytes']/1e6:.0f} MB"
        print(f"{r['key_id']:<26} {names.get(r['key_id'], '?')[:18]:<18} "
              f"{r['calls']:>9,} {r['billed_calls']:>8,} {size:>10}  {r['last_seen']}")

    print()
    for r in rows:
        today = usage.billed_today(r["key_id"])
        q = quotas.get(r["key_id"], 0)
        if q > 0 and today >= q * 0.8:
            state = "EXHAUSTED" if today >= q else "over 80%"
            print(f"  ! {r['key_id']}: {today}/{q} billed calls today ({state})")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", help="Partner name, e.g. 'MCG Gurugram'")
    p.add_argument("--scopes", default="*",
                   help=f"Comma list from {', '.join(keystore.ALL_SCOPES)}, or * (default)")
    p.add_argument("--rate", type=int, default=keystore.DEFAULT_RATE_PER_MIN,
                   help="Requests per minute (burst-tolerant token bucket)")
    p.add_argument("--quota", type=int, default=keystore.DEFAULT_DAILY_QUOTA,
                   help="Daily cap on BILLED calls (assets/geocode/route); 0 = unmetered")
    p.add_argument("--list", action="store_true", help="List existing keys")
    p.add_argument("--revoke", metavar="KEY_ID", help="Disable a key by id")
    p.add_argument("--usage", action="store_true",
                   help="Show consumption per key (what /api/usage reports to them)")
    p.add_argument("--days", type=int, default=30, help="Window for --usage (default 30)")
    args = p.parse_args()

    if args.usage:
        return usage_report(args)
    if args.list:
        return listing(args)
    if args.revoke:
        return revoke(args)
    if not args.name:
        p.error("--name is required to issue a key (or use --list / --revoke)")
    return issue(args)


if __name__ == "__main__":
    raise SystemExit(main())
