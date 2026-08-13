"""Per-key usage accounting, shared across worker processes.

WHY SQLITE AND NOT A DICT. The rate limiter in gate.py counts in memory, which
is right for what it does: it bounds bursts, and being approximately correct
per worker is fine because four workers each allowing N/minute still bounds the
total. Usage is different in kind — it is REPORTED to the partner and gates
their daily quota, so an in-memory counter under `gunicorn --workers 4` would
report roughly a quarter of actual consumption, and which quarter would depend
on whichever worker happened to answer /api/usage. A number that is wrong by a
factor of the worker count is worse than no number at all.

SQLite gives us one shared counter with real transactions, from the standard
library, with no service to run. WAL mode so a reader never blocks the writer,
and an UPSERT so concurrent workers incrementing the same row serialise
correctly instead of clobbering each other.

Cost is one small write per gated request. At this traffic (a console cold load
is ~40 requests) that is far below the cost of the responses themselves.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from .config import BASE_DIR

DB_PATH = Path(__file__).parent.parent / "usage.db"

# One connection per thread. sqlite3 objects are not shareable across threads by
# default, and gunicorn's gthread worker means several threads per process.
_local = threading.local()
_init_lock = threading.Lock()
_initialised = False


def _connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    conn = sqlite3.connect(str(DB_PATH), timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    # WAL: concurrent readers during a write, which matters because /api/usage
    # reads while request traffic is still writing.
    conn.execute("PRAGMA journal_mode=WAL")
    # NORMAL is the right durability for a usage counter: it survives a process
    # crash, and losing the last few milliseconds to a power cut costs us a
    # handful of counted requests, not correctness anybody can perceive.
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    _local.conn = conn
    return conn


def init() -> None:
    """Create the schema. Idempotent, safe to call from every worker."""
    global _initialised
    with _init_lock:
        if _initialised:
            return
        conn = _connect()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS usage (
                key_id  TEXT NOT NULL,
                day     TEXT NOT NULL,          -- UTC date, YYYY-MM-DD
                scope   TEXT NOT NULL,
                billed  INTEGER NOT NULL,       -- 1 if this scope costs money
                calls   INTEGER NOT NULL DEFAULT 0,
                bytes   INTEGER NOT NULL DEFAULT 0,
                errors  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (key_id, day, scope)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS usage_key_day ON usage(key_id, day)")
        _initialised = True


def today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def record(key_id: str, scope: str, billed: bool, nbytes: int = 0,
           error: bool = False) -> None:
    """Count one request. Never raises — accounting must not fail a response."""
    try:
        init()
        _connect().execute(
            """
            INSERT INTO usage (key_id, day, scope, billed, calls, bytes, errors)
            VALUES (?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(key_id, day, scope) DO UPDATE SET
                calls  = calls  + 1,
                bytes  = bytes  + excluded.bytes,
                errors = errors + excluded.errors
            """,
            (key_id, today(), scope, 1 if billed else 0, max(0, nbytes), 1 if error else 0),
        )
    except sqlite3.Error:
        # A locked or unwritable database must not turn into a 500 on a data
        # request. The quota check below fails open for the same reason: losing
        # accounting is a billing problem, losing the service is an outage.
        pass


def billed_today(key_id: str) -> int:
    """Billed calls this key has made today, across ALL workers."""
    try:
        init()
        row = _connect().execute(
            "SELECT COALESCE(SUM(calls), 0) AS n FROM usage "
            "WHERE key_id = ? AND day = ? AND billed = 1",
            (key_id, today()),
        ).fetchone()
        return int(row["n"]) if row else 0
    except sqlite3.Error:
        return 0


def summary(key_id: str, days: int = 30) -> dict:
    """Everything /api/usage reports for one key."""
    init()
    conn = _connect()
    day = today()

    by_scope: dict[str, dict] = {}
    for r in conn.execute(
        "SELECT scope, billed, calls, bytes, errors FROM usage "
        "WHERE key_id = ? AND day = ? ORDER BY scope", (key_id, day),
    ):
        by_scope[r["scope"]] = {
            "calls": r["calls"], "bytes": r["bytes"],
            "errors": r["errors"], "billed": bool(r["billed"]),
        }

    history = [
        {"date": r["day"], "calls": r["calls"], "billed_calls": r["billed_calls"],
         "bytes": r["bytes"]}
        for r in conn.execute(
            """
            SELECT day,
                   SUM(calls) AS calls,
                   SUM(CASE WHEN billed = 1 THEN calls ELSE 0 END) AS billed_calls,
                   SUM(bytes) AS bytes
            FROM usage
            WHERE key_id = ? AND day >= date('now', ?)
            GROUP BY day ORDER BY day DESC
            """,
            (key_id, f"-{max(1, days)} days"),
        )
    ]

    return {
        "date": day,
        "by_scope": by_scope,
        "calls_today": sum(v["calls"] for v in by_scope.values()),
        "billed_calls_today": sum(v["calls"] for v in by_scope.values() if v["billed"]),
        "bytes_today": sum(v["bytes"] for v in by_scope.values()),
        "history": history,
    }


def all_totals(days: int = 30) -> list[dict]:
    """Per-key totals, for the operator-side CLI."""
    init()
    return [dict(r) for r in _connect().execute(
        """
        SELECT key_id,
               SUM(calls) AS calls,
               SUM(CASE WHEN billed = 1 THEN calls ELSE 0 END) AS billed_calls,
               SUM(bytes) AS bytes,
               MAX(day)   AS last_seen
        FROM usage
        WHERE day >= date('now', ?)
        GROUP BY key_id ORDER BY billed_calls DESC
        """,
        (f"-{max(1, days)} days",),
    )]
