/* Console — the tool. Shell only: header, sidebar, map, overlays. All rendering
 * happens in the engine; all state lives in the store. */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import MapCanvas from '../components/MapCanvas.jsx';
import LayersPanel from '../components/LayersPanel.jsx';
import DrainageLegend from '../components/DrainageLegend.jsx';
import {
  DataSourcePanel, TimeControl, DepthLegend, KpiStrip,
  HotspotsPanel, RoadPanel, SearchBar,
} from '../components/panels.jsx';
import { useTwin } from '../store/useTwin.js';
import '../styles/console.css';

function BootOverlay() {
  const phase = useTwin((s) => s.phase);
  const status = useTwin((s) => s.status);
  const error = useTwin((s) => s.error);
  if (phase === 'ready') return null;
  return (
    <div className="boot">
      <div className="boot-card">
        {phase === 'error' ? (
          <>
            <h2>Could not start</h2>
            <p className="boot-err">{error}</p>
            {/* Reloading fixes the whole class of "the previous mount left
                something behind" failures, so offer it first — going Back only
                strands the user on the overview with no way in. */}
            <div className="boot-actions">
              <button className="boot-retry" onClick={() => window.location.reload()}>
                Reload
              </button>
              <Link className="boot-back" to="/">← Back</Link>
            </div>
          </>
        ) : (
          <>
            <div className="boot-spin"><span /><span /></div>
            <h2>Starting FloodTwin</h2>
            <p>{status}</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function Console() {
  const [twin, setTwin] = useState(null);
  const [sidebar, setSidebar] = useState(true);
  const toggleFeature = useTwin((s) => s.toggleFeature);
  const terrain = useTwin((s) => s.features.terrain);
  const xray = useTwin((s) => s.features.xray);

  return (
    <div className={`console${sidebar ? '' : ' is-collapsed'}`}>
      <header className="app-header">
        {/* The brand now goes home, which is what a masthead is expected to do.
            The panel toggle it used to carry moves to its own button — hiding a
            navigation and a layout control behind the same target meant one of
            them was always the wrong guess. */}
        <button
          className="panel-toggle"
          onClick={() => setSidebar((v) => !v)}
          title={sidebar ? 'Hide the panel' : 'Show the panel'}
          aria-label={sidebar ? 'Hide the panel' : 'Show the panel'}
          aria-expanded={sidebar}
        >
          {sidebar ? '⟨' : '⟩'}
        </button>
        <Link className="brand" to="/" title="Back to the FloodTwin home page">
          <img src="/static/AIRESQ_LOGO.png" alt="" />
          <span className="brand-copy">
            <span className="brand-title">FloodTwin</span>
            <span className="brand-sub">AIResQ ClimSols · Gurugram</span>
          </span>
        </Link>
        <KpiStrip />
        <Link className="header-home" to="/">Home</Link>
        <button
          className="header-home header-signout"
          title="End this console session"
          onClick={async () => {
            await fetch('/api/auth/logout', {
              method: 'POST', cache: 'no-store', credentials: 'same-origin',
            }).catch(() => {});
            // A HARD navigation, not a router push. Signing out has to tear down
            // the whole tab: the three.js scene, the engine's layer handles and
            // simData's module-scoped hour/grid caches all live outside React and
            // would otherwise survive into the next person's session on the same
            // machine — they would open the console and find the previous run
            // already loaded.
            window.location.assign('/');
          }}
        >
          Sign out
        </button>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <SearchBar twin={twin} />
          <DataSourcePanel />
          <TimeControl />
          <LayersPanel />
        </aside>

        <main className="viewport">
          <MapCanvas onReady={setTwin} />
          <DepthLegend />
          <HotspotsPanel twin={twin} />
          <RoadPanel twin={twin} />
          <DrainageLegend />

          <div className="map-controls">
            <button title="Jump to the deepest flooding" onClick={() => twin?.jumpToDeepest()}>🎯</button>
            <button className={terrain ? 'is-active' : ''} title="Tilt / 3D camera"
              onClick={() => toggleFeature('terrain')}>🏔️</button>
            <button className={xray ? 'is-active' : ''} title="X-ray the basemap"
              onClick={() => toggleFeature('xray')}>🩻</button>
            <button title="Zoom in" onClick={() => twin?.engine.map.zoomIn()}>+</button>
            <button title="Zoom out" onClick={() => twin?.engine.map.zoomOut()}>−</button>
          </div>
        </main>
      </div>

      <BootOverlay />
    </div>
  );
}
