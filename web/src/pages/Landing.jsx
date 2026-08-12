/* ─────────────────────────────────────────────────────────────────────────────
 * Landing.jsx — the product page.
 *
 * Its feature grid is generated from features/registry.js, the same list the
 * console's Layers panel renders. That is the point: a visitor learns the whole
 * capability set here, then finds those exact names and icons as switches inside
 * the tool. Adding a feature to the registry adds it to both surfaces at once,
 * so the two can't drift.
 *
 * Deliberately zero engine imports — this page must not pull three.js or the
 * Mappls SDK, so it paints long before the console's data would be ready.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GROUPS, FEATURES, featuresInGroup } from '../features/registry.js';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { runDay } from '../lib/runDay.js';
// Warms the console's code chunk on hover/focus, nothing more — this page still
// pulls no three.js and no Mappls SDK of its own (see the header note).
import { onIntent } from '../warmConsole.js';
import '../styles/landing.css';

const STATS = [
  { v: '139,798', k: 'drain conduits solved' },
  { v: '981,880', k: 'surface cells' },
  { v: '1,980 km', k: 'sewer mains mapped' },
  { v: '133 mm', k: 'in 12 h — the modelled storm' },
];

function useRunStatus() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/live-forecast/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setS(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return s;
}

export default function Landing() {
  const run = useRunStatus();
  const built = run?.built;
  const fresh = built && !run?.stale;

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-brand">
          <img src="/static/AIRESQ_LOGO.png" alt="" className="lp-logo" />
          <div>
            <div className="lp-brand-name">FloodTwin</div>
            <div className="lp-brand-sub">AIResQ ClimSols</div>
          </div>
        </div>
        <nav className="lp-nav-links">
          <a href="#features">Features</a>
          <ThemeToggle />
          <Link className="lp-nav-cta" to="/twin" {...onIntent()}>Open console →</Link>
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          {/* Names the day the run covers rather than just printing its date:
              "built · 06 Aug" reads as fine on 07 Aug, which is precisely how a
              stalled refresh stayed invisible. */}
          <div className="lp-eyebrow">
            <span className={`lp-dot ${fresh ? 'is-live' : 'is-idle'}`} />
            {built
              ? (fresh
                  ? `Forecast live for ${runDay(built.base_valid_time)}`
                  : `Forecast showing ${runDay(built.base_valid_time)} · newer run pending`)
              : 'Gurugram · Municipal Corporation'}
          </div>
          <h1>
            From every street<br />
            <span className="lp-hl">to every stream.</span>
          </h1>
          <div className="lp-cta-row">
            <Link className="lp-cta" to="/twin" {...onIntent()}>Open the console</Link>
            <a className="lp-cta lp-cta-ghost" href="#features">See what it does</a>
          </div>
          <div className="lp-stats">
            {STATS.map((s) => (
              <div key={s.k} className="lp-stat">
                <div className="lp-stat-v">{s.v}</div>
                <div className="lp-stat-k">{s.k}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="lp-hero-art">
          <figure className="lp-art-card">
            {/* A screen recording of the real console, not a mock. Shipped as
                MP4 + WebM rather than the source GIF: the same 18 s is 84 MB as a
                GIF and ~1 MB here, which is the difference between a hero that
                paints immediately and one that hangs the page. Muted + inline so
                it autoplays on mobile; a poster frame holds the layout until the
                first video frame decodes. */}
            <video
              className="lp-art-video"
              poster="/media/console-poster.jpg"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              aria-label="The FloodTwin console: Gurugram's storm-drain network in 3D, filling as the storm passes"
            >
              <source src="/media/console.webm" type="video/webm" />
              <source src="/media/console.mp4" type="video/mp4" />
            </video>
            <figcaption className="lp-art-cap">
              The storm-drain network under Gurugram, filling as the storm passes.
            </figcaption>
          </figure>
          <div className="lp-art-glow" />
        </div>
      </section>

      <section className="lp-section" id="features">
        <div className="lp-sec-head">
          <h2>Every layer, on its own switch</h2>
        </div>

        {GROUPS.map((g) => (
          <div className="lp-group" key={g.id}>
            <div className="lp-group-head">
              <span className="lp-group-icon">{g.icon}</span>
              <h3>{g.label}</h3>
              <span className="lp-group-blurb">{g.blurb}</span>
            </div>
            <div className="lp-grid">
              {featuresInGroup(g.id).map((f) => (
                <article className="lp-card" key={f.id}>
                  <div className="lp-card-top">
                    <span className="lp-card-icon">{f.icon}</span>
                    <h4>{f.label}</h4>
                    {f.defaultOn && <span className="lp-badge">on by default</span>}
                  </div>
                  <p className="lp-card-short">{f.short}</p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="lp-section lp-section-alt lp-closing">
        <div className="lp-foot-cta">
          <Link className="lp-cta" to="/twin" {...onIntent()}>Open the console</Link>
        </div>
      </section>

      <footer className="lp-footer">
        <div>
          <strong>FloodTwin</strong> · AIResQ ClimSols · Gurugram flood decision-support
        </div>
        <div className="lp-footer-meta">
          {FEATURES.length} switchable layers · {run?.upstream?.run_id ? 'partner feed connected' : 'event dataset'}
        </div>
      </footer>
    </div>
  );
}
