/* ─────────────────────────────────────────────────────────────────────────────
 * RequireAuth.jsx — the gate in front of the console.
 *
 * The credentials are NOT here, and deliberately so: anything this file compared
 * against would be sitting in the shipped JS bundle for anyone to read. The form
 * posts to /api/auth/login, the server does the comparison, and what comes back
 * is an HttpOnly session cookie this code can never see — it only ever asks
 * "am I in?" via /api/auth/session.
 *
 * THE GATE IS OPTIMISTIC, ON PURPOSE. The console mounts immediately and the
 * session check runs beside it; if the server says no, the login form replaces
 * what was mounted. Blocking on the check first meant every entry to the tool
 * paid a full round trip before the engine chunk, the map SDK and the first
 * depth grid could even be requested — with nothing on screen but a spinner —
 * and that round trip was pure serial cost for the signed-in case, which is
 * essentially every case.
 *
 * WHAT THAT TRADES AWAY: a signed-out visitor now briefly sees the console
 * shell, and their browser starts fetching simulation binaries, before being
 * bounced to the login form. That is acceptable here because those binaries are
 * NOT access-controlled anyway — /sim, /live and /drainage are served to anyone
 * who asks (see routes/data.py). This gate has always protected the interface,
 * not the data, so mounting early exposes nothing new. If the data routes ever
 * do get locked down, this must go back to blocking.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import '../styles/auth.css';

export default function RequireAuth({ children }) {
  // 'open' renders the console while the answer is still outstanding. Only an
  // explicit rejection swaps in the login form, so the common path — a valid
  // session — never waits on the network to show anything.
  const [phase, setPhase] = useState('open');       // open | out | in

  useEffect(() => {
    let alive = true;
    // no-store + same-origin: the gate must ask the SERVER every time. A cached
    // "authenticated: true" from a previous session would hand the console to
    // someone whose cookie has since expired or been signed out.
    const check = () =>
      fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive || !d) return;      // unreadable answer is not a rejection
          setPhase(d.authenticated ? 'in' : 'out');
        })
        // A network blip is NOT a sign-out. While the gate blocked, failing
        // closed only cost a login form on a blank screen; now that the console
        // is already mounted, it would tear down a working session over one
        // dropped request. Only an explicit `authenticated: false` closes it —
        // and the server still refuses anything privileged regardless.
        .catch(() => {});
    check();

    // BACK/FORWARD CACHE. Sign out, then press Back: the browser can restore the
    // whole console page from bfcache without re-running a single effect, so a
    // signed-out user would be looking at the tool again. `pageshow` with
    // `persisted` is the one event that fires on a bfcache restore — re-ask the
    // server there, and the gate closes as it should.
    const onShow = (e) => { if (e.persisted) check(); };
    window.addEventListener('pageshow', onShow);
    return () => { alive = false; window.removeEventListener('pageshow', onShow); };
  }, []);

  // 'open' and 'in' both render the tool; only a rejection interrupts it.
  if (phase === 'out') return <LoginGate onSuccess={() => setPhase('in')} />;
  return children;
}

function LoginGate({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const userRef = useRef(null);

  useEffect(() => { userRef.current?.focus(); }, []);

  const submit = useCallback(async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) { onSuccess(); return; }
      const body = await res.json().catch(() => ({}));
      // The server never says WHICH half was wrong, and neither does this.
      setError(res.status === 429
        ? `Too many attempts — try again in ${body.retry_after_s || 60}s.`
        : 'Those credentials were not accepted.');
      setPassword('');
    } catch {
      setError('Could not reach the server. Check your connection and retry.');
    } finally {
      setBusy(false);
    }
  }, [busy, username, password, onSuccess]);

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <img src="/static/AIRESQ_LOGO.png" alt="" />
          <div>
            <div className="auth-brand-name">FloodTwin</div>
            <div className="auth-brand-sub">AIResQ ClimSols · Gurugram</div>
          </div>
        </div>

        <h1>Console access</h1>

        <label className="auth-field">
          <span>Username</span>
          <input
            ref={userRef}
            type="text"
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck="false"
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
            required
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
        </label>

        {error && <div className="auth-error" role="alert">{error}</div>}

        <button className="auth-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Open the console'}
        </button>

        <Link className="auth-back" to="/">← Back to overview</Link>
      </form>
    </div>
  );
}
