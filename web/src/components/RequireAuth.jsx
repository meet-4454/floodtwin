/* ─────────────────────────────────────────────────────────────────────────────
 * RequireAuth.jsx — the gate in front of the console.
 *
 * The credentials are NOT here, and deliberately so: anything this file compared
 * against would be sitting in the shipped JS bundle for anyone to read. The form
 * posts to /api/auth/login, the server does the comparison, and what comes back
 * is an HttpOnly session cookie this code can never see — it only ever asks
 * "am I in?" via /api/auth/session.
 *
 * Children are not mounted until that answer is yes, so the console's engine,
 * three.js and simulation binaries are never even fetched by a visitor who
 * hasn't signed in.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import '../styles/auth.css';

export default function RequireAuth({ children }) {
  const [phase, setPhase] = useState('checking');   // checking | out | in

  useEffect(() => {
    let alive = true;
    // no-store + same-origin: the gate must ask the SERVER every time. A cached
    // "authenticated: true" from a previous session would hand the console to
    // someone whose cookie has since expired or been signed out.
    const check = () =>
      fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive) setPhase(d?.authenticated ? 'in' : 'out'); })
        .catch(() => { if (alive) setPhase('out'); });
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

  if (phase === 'checking') {
    return (
      <div className="auth-shell">
        <div className="auth-card is-checking">
          <div className="auth-spin"><span /><span /></div>
          <p>Checking your session…</p>
        </div>
      </div>
    );
  }
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
