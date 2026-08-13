/* ─────────────────────────────────────────────────────────────────────────────
 * FloodTwinConsole — the whole console, as one component.
 *
 * This is the package's front door. It owns exactly three things and delegates
 * everything else: the per-instance store, the HTTP client that knows which
 * origin to reach FloodTwin at, and the options bag. All three go into context
 * (lib/context.jsx); the shell below is just layout.
 *
 * ON THE BASE URL. `baseUrl` points at the PARTNER's own server, not at ours.
 * FloodTwin keys are secret and server-side: the partner's backend proxies
 * these paths and attaches the key. Pointing this at api.floodresq.com directly
 * would mean either an unauthenticated request (401) or a key in the bundle.
 * See INTEGRATION.md and examples/ for a proxy that does the right thing.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { useMemo, useRef, useState } from 'react';
import MapCanvas from '../components/MapCanvas.jsx';
import LayersPanel from '../components/LayersPanel.jsx';
import DrainageLegend from '../components/DrainageLegend.jsx';
import {
  DataSourcePanel, TimeControl, DepthLegend, KpiStrip,
  HotspotsPanel, RoadPanel, SearchBar,
} from '../components/panels.jsx';
import { FloodTwinProvider, useTwin } from './context.jsx';
import { createTwinStore } from '../store/useTwin.js';
import { createClient } from './client.js';
import '../styles/tokens.css';
import '../styles/console.css';

function BootOverlay({ onExit }) {
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
                something behind" failures, so offer it first. */}
            <div className="boot-actions">
              <button className="boot-retry" onClick={() => window.location.reload()}>
                Reload
              </button>
              {onExit && <button className="boot-back" onClick={onExit}>← Back</button>}
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

function ConsoleShell({ brand, onExit, onSignOut, onReady }) {
  const [twin, setTwin] = useState(null);
  const [sidebar, setSidebar] = useState(true);
  const handleReady = (t) => { setTwin(t); onReady?.(t); };
  const toggleFeature = useTwin((s) => s.toggleFeature);
  const terrain = useTwin((s) => s.features.terrain);
  const xray = useTwin((s) => s.features.xray);

  return (
    <div className={`console${sidebar ? '' : ' is-collapsed'}`}>
      <header className="app-header">
        <button
          className="panel-toggle"
          onClick={() => setSidebar((v) => !v)}
          title={sidebar ? 'Hide the panel' : 'Show the panel'}
          aria-label={sidebar ? 'Hide the panel' : 'Show the panel'}
          aria-expanded={sidebar}
        >
          {sidebar ? '⟨' : '⟩'}
        </button>

        {/* The masthead is a BUTTON when the host gave us somewhere to go, and
            inert text otherwise — an embedded console has no "home" of its own,
            and a dead link that looks live is worse than no link. */}
        {brand !== false && (
          <div className="brand" role={onExit ? 'button' : undefined}
               onClick={onExit || undefined}
               style={onExit ? undefined : { cursor: 'default' }}>
            {brand?.logo !== false && (
              <img src={brand?.logo || BRAND_LOGO} alt="" />
            )}
            <span className="brand-copy">
              <span className="brand-title">{brand?.title || 'FloodTwin'}</span>
              <span className="brand-sub">{brand?.subtitle || 'AIResQ ClimSols · Gurugram'}</span>
            </span>
          </div>
        )}

        <KpiStrip />
        {onExit && <button className="header-home" onClick={onExit}>Home</button>}
        {onSignOut && (
          <button className="header-home header-signout" title="End this console session"
                  onClick={onSignOut}>
            Sign out
          </button>
        )}
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <SearchBar twin={twin} />
          <DataSourcePanel />
          <TimeControl />
          <LayersPanel />
        </aside>

        <main className="viewport">
          <MapCanvas onReady={handleReady} />
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

      <BootOverlay onExit={onExit} />
    </div>
  );
}

// Inlined so the package has no runtime asset dependency on our origin: a
// partner's deploy must not have to also host our PNG for the header to render.
const BRAND_LOGO =
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<circle cx="16" cy="16" r="15" fill="#0e7490"/>' +
    '<path d="M16 6c4 6 7 9.2 7 13a7 7 0 1 1-14 0c0-3.8 3-7 7-13z" fill="#67e8f9"/></svg>');

/**
 * @param {string}   baseUrl    Where FloodTwin is reachable from the browser —
 *   normally a path on the partner's own server that proxies to us with the
 *   secret key attached. '' means "same origin" (our own deployment).
 * @param {object}   headers    Extra headers on every request (the partner's own
 *   auth against their own origin). NOT the FloodTwin key — that is server-side.
 * @param {string}   credentials  fetch credentials mode; our console uses
 *   'same-origin' so the session cookie rides along.
 * @param {function} fetch      fetch implementation override, for tests.
 * @param {string}   mapplsApiKey  The partner's own Mappls key. Strongly
 *   recommended: without it the console asks /api/config for ours, and a map SDK
 *   key is necessarily visible in the browser that uses it.
 * @param {string}   dataset    'event' (09 Jul 2025) or 'live' (daily forecast).
 * @param {object}   features   Initial toggle overrides, merged over the
 *   registry defaults — `{ drainage: true }` switches one layer on without
 *   having to restate the other twenty.
 * @param {object|false} brand  `{ title, subtitle, logo }`, or false to drop the
 *   masthead entirely when the console sits inside the partner's own chrome.
 * @param {string}   className  Extra classes on the root element.
 * @param {function} onReady    Called with the twin handle once the map is live.
 * @param {function} onError    Called if boot fails.
 * @param {function} onExit     Renders the Home affordance; omit for no exit.
 * @param {function} onSignOut  Renders the Sign out button; omit for none.
 * @param {boolean}  debug      Expose window.__ftTwin / __ftEngine.
 */
export default function FloodTwinConsole({
  baseUrl = '',
  headers = null,
  credentials = undefined,
  fetch: fetchImpl = null,
  mapplsApiKey = '',
  dataset = 'event',
  features = null,
  brand = null,
  className = '',
  onReady = null,
  onError = null,
  onExit = null,
  onSignOut = null,
  onChunkError = null,
  debug = false,
  skipGL = false,
  featureLimit = undefined,
}) {
  // Created ONCE per mount. A store or client rebuilt on re-render would reset
  // the timeline — and worse, hand the engine a store nothing else is reading.
  // Later prop changes to these are deliberately ignored; remount to change them
  // (key={baseUrl} is the React-idiomatic way to ask for that).
  const storeRef = useRef(null);
  if (storeRef.current === null) {
    storeRef.current = createTwinStore({
      dataset,
      ...(features ? { features } : {}),
    });
  }

  const client = useMemo(
    () => createClient({ baseUrl, headers, fetch: fetchImpl, credentials }),
    [baseUrl, headers, fetchImpl, credentials],
  );

  const options = useMemo(() => ({
    mapplsApiKey, debug, skipGL, featureLimit, onChunkError, onError,
  }), [mapplsApiKey, debug, skipGL, featureLimit, onChunkError, onError]);

  return (
    <FloodTwinProvider store={storeRef.current} client={client} options={options}>
      {/* .ft-root is the scoping hook every packaged style is nested under, so
          the console cannot restyle the partner's page or be restyled by it. */}
      <div className={`ft-root${className ? ` ${className}` : ''}`}>
        {/* onReady hands the partner the SAME handle the shell holds:
            flyTo, jumpToDeepest, depthAt, and the engine itself. */}
        <ConsoleShell
          brand={brand}
          onExit={onExit}
          onSignOut={onSignOut}
          onReady={onReady}
        />
      </div>
    </FloodTwinProvider>
  );
}
