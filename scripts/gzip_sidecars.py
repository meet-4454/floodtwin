#!/usr/bin/env python
"""Write `<file>.gz` sidecars next to the dataset binaries.

floodtwin/http.py serves a sidecar when it finds one and compresses on demand
when it does not, so this is purely an optimisation — but a large one on the
paths that matter. Compressing a frame binary costs 9–49 ms, and that was paid
on the first request for every file in EVERY gunicorn worker: playing a
145-frame forecast through once burned ~9 s of CPU per worker and stuttered on
the first pass only.

build_live_forecast.py writes sidecars as it builds, so `/live` maintains itself
from the next daily run onward. This script is for the datasets nothing rebuilds:
`/sim` (the fixed 09-Jul-2025 event reconstruction) and any dataset restored
from a backup or transcoded by hand.

Safe to re-run: a sidecar at least as new as its source is left alone, so a
second pass over an unchanged directory does nothing. Sidecars are never served
directly — the route regexes only match `.bin`/`.json` — so an extra one is
inert rather than wrong.

    python scripts/gzip_sidecars.py                    # /sim and /live
    python scripts/gzip_sidecars.py drainage/sim       # one directory
    python scripts/gzip_sidecars.py --force            # rewrite every sidecar
"""
from __future__ import annotations

import argparse
import gzip
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent.resolve()
DEFAULT_DIRS = [BASE_DIR / "drainage" / "sim", BASE_DIR / "drainage" / "live"]
# What the browser actually fetches and what http.py will gzip on demand.
PATTERNS = ("*.bin", "*.json", "*.geojson")


def sidecar_dir(d: Path, force: bool, level: int) -> tuple[int, int, int]:
    written = skipped = saved = 0
    for pat in PATTERNS:
        for src in sorted(d.glob(pat)):
            if src.name.endswith(".gz"):
                continue
            dst = src.with_name(src.name + ".gz")
            try:
                if not force and dst.stat().st_mtime >= src.stat().st_mtime:
                    skipped += 1
                    continue
            except OSError:
                pass                       # no sidecar yet
            raw = src.read_bytes()
            blob = gzip.compress(raw, compresslevel=level)
            # Write-then-rename: a worker must never read a half-written sidecar
            # and serve it as a complete response body.
            tmp = dst.with_name(dst.name + ".tmp")
            tmp.write_bytes(blob)
            tmp.replace(dst)
            written += 1
            saved += len(raw) - len(blob)
    return written, skipped, saved


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="*", type=Path, help="directories (default: /sim and /live)")
    ap.add_argument("--force", action="store_true", help="rewrite sidecars that already look current")
    ap.add_argument("--level", type=int, default=9,
                    help="gzip level (default 9 — this runs rarely, the bytes ship often)")
    args = ap.parse_args()

    targets = args.dirs or DEFAULT_DIRS
    t0 = time.time()
    total_w = total_s = total_b = 0
    for d in targets:
        if not d.is_dir():
            print(f"skip {d} — not a directory")
            continue
        w, s, b = sidecar_dir(d, args.force, args.level)
        total_w += w
        total_s += s
        total_b += b
        print(f"{d}: {w} written, {s} already current, {b / 1e6:.0f} MB saved on the wire")
    print(f"total: {total_w} written, {total_s} current, "
          f"{total_b / 1e6:.0f} MB saved, {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
