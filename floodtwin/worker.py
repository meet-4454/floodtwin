"""Gunicorn worker that does not hand a thread to a connection with nothing to say.

WHY THIS FILE EXISTS
────────────────────
gunicorn's stock `gthread` worker (25.x) accepts a connection and immediately
submits it to the thread pool:

    def accept(self, listener):
        client_sock, client_addr = listener.accept()
        self.nr_conns += 1
        conn = TConn(...)
        self.enqueue_req(conn)          # -> tpool.submit(self.handle, conn)

and `handle()` opens with a BLOCKING, untimed read for the request line:

        conn.sock.setblocking(True)
        conn.init()
        req = next(conn.parser)         # blocks until the client sends something

So a peer that opens a TCP connection and then stays quiet occupies one of the
worker's `--threads` slots indefinitely. `--threads 4` means FOUR silent sockets
wedge a worker completely: it keeps accepting (nr_conns is far below
worker_connections) and every real request queues behind a pool that will never
drain. Measured against this app before the fix: four idle sockets took a worker
from 2.6 ms to "no response in 60 s", and across the four production workers
55 % of fresh connections stalled for more than a minute.

That is not a hypothetical peer. This origin sits behind a Cloudflare tunnel, and
cloudflared keeps a POOL of upstream connections open — opened ahead of demand
and held idle between requests. Browsers do the same thing with speculative
preconnects. The pool is routinely larger than 4, so workers spent most of their
life wedged, and the symptom at the browser was multi-second stalls scattered
across map tiles, /api/config, the engine chunk and the forecast frames — which
reads exactly like a caching or CDN fault and is neither.

THE FIX
───────
Park a newly accepted connection in the poller instead, and only hand it to a
thread once it is actually readable. That is precisely what the worker already
does with a keep-alive connection between requests (`finish_request`), so this
puts the first request on the same footing as the second: threads are spent on
requests, never on silence. An idle peer now costs one fd and one poller entry
(worker_connections, 1000 by default) instead of one of four threads, and
`murder_keepalived` reaps it on the ordinary keep-alive timeout.

Deliberately NOT hardened against a slow-loris here — a peer that sends half a
header block still holds a thread. Bounding that means bounding the header read,
and the only clean place for the timeout to be cleared again is in the middle of
the stock `handle()`, so it would mean carrying a copy of gunicorn's internals.
This origin is reachable only over the tunnel on localhost, so partial-request
abuse is Cloudflare's to absorb; the fix here targets the idle-pool case, which
is the one that was actually taking the site down.

USAGE
─────
    gunicorn --worker-class floodtwin.worker.PollFirstThreadWorker ... server:app

If a future gunicorn reshapes the internals this leans on, `accept` falls back to
the stock behaviour rather than dropping the connection — degraded to the old
latency, never broken. The self-check at import time says so out loud.
"""
from __future__ import annotations

import errno
import selectors
from functools import partial

from gunicorn.workers.gthread import TConn, ThreadWorker

# Everything the override reaches into. Checked once, at import, so a gunicorn
# upgrade that moves any of it is a loud warning at boot rather than a subtle
# regression discovered later from a latency graph. Instance attributes are not
# on the class, so they are looked for where they are assigned instead.
_REQUIRED_METHODS = ("on_client_socket_readable", "murder_keepalived", "accept")
_REQUIRED_ATTRS = {
    "__init__": ("keepalived_conns", "nr_conns"),
    "init_process": ("poller",),
}
_COMPATIBLE = (
    all(callable(getattr(ThreadWorker, m, None)) for m in _REQUIRED_METHODS)
    and all(attr in getattr(ThreadWorker, meth).__code__.co_names
            for meth, attrs in _REQUIRED_ATTRS.items() for attr in attrs)
    and callable(getattr(TConn, "set_timeout", None))
)
_MISSING = "on_client_socket_readable / keepalived_conns / poller / set_timeout"


class PollFirstThreadWorker(ThreadWorker):
    """gthread, but a connection only costs a thread once it has sent something."""

    def accept(self, listener):
        if not _COMPATIBLE:                       # unknown gunicorn — stock behaviour
            return super().accept(listener)
        try:
            client_sock, client_addr = listener.accept()
        except OSError as exc:
            if exc.errno not in (errno.EAGAIN, errno.ECONNABORTED, errno.EWOULDBLOCK):
                raise
            return

        self.nr_conns += 1
        conn = TConn(self.cfg, client_sock, client_addr, listener.getsockname())
        try:
            # Same treatment `finish_request` gives a connection that is between
            # keep-alive requests: non-blocking, on the clock, watched by the
            # poller. `set_timeout` is monotonic + cfg.keepalive, and we append in
            # accept order, so keepalived_conns stays sorted by expiry — which is
            # what lets murder_keepalived stop at the first live entry.
            conn.sock.setblocking(False)
            conn.set_timeout()
            self.keepalived_conns.append(conn)
            self.poller.register(
                conn.sock, selectors.EVENT_READ,
                partial(self.on_client_socket_readable, conn),
            )
        except (OSError, ValueError):
            # Died between accept() and register() — a port scanner's RST, most
            # often. Unwind the count we just took so the worker does not slowly
            # convince itself it is full.
            self.nr_conns -= 1
            try:
                self.keepalived_conns.remove(conn)
            except ValueError:
                pass
            conn.close()

    def init_process(self):
        super().init_process()
        if not _COMPATIBLE:
            self.log.warning(
                "PollFirstThreadWorker: this gunicorn's ThreadWorker no longer "
                "exposes %s — falling back to stock accept(). Idle upstream "
                "connections will occupy threads again; see floodtwin/worker.py.",
                _MISSING)
