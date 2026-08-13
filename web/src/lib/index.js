/* ─────────────────────────────────────────────────────────────────────────────
 * @airesq/floodtwin-react — public API.
 *
 * The drop-in is FloodTwinConsole: it carries the whole console, its feature
 * toggles included, and each layer fetches its own data lazily through the
 * base URL you give it. Everything else exported here is for partners who want
 * the same functionality inside their own chrome rather than ours.
 *
 * Anything NOT exported from this file is internal and may change in a patch
 * release. In particular: the engine modules, the zustand store shape, and the
 * CSS class names.
 * ─────────────────────────────────────────────────────────────────────────── */

// ── The drop-in ─────────────────────────────────────────────────────────────
export { default as FloodTwinConsole } from './FloodTwinConsole.jsx';
export { default } from './FloodTwinConsole.jsx';

// ── Composing your own layout ───────────────────────────────────────────────
// Mount these inside <FloodTwinProvider> (or inside <FloodTwinConsole>) to
// place the controls where you want them. MapCanvas is the only one that must
// be present — it is what boots the engine.
export { FloodTwinProvider, useFloodTwin, useTwin, useTwinStore, useClient } from './context.jsx';
export { default as MapCanvas } from '../components/MapCanvas.jsx';
export { default as LayersPanel } from '../components/LayersPanel.jsx';
export { default as DrainageLegend } from '../components/DrainageLegend.jsx';
export {
  DataSourcePanel, TimeControl, DepthLegend, KpiStrip,
  HotspotsPanel, RoadPanel, SearchBar,
} from '../components/panels.jsx';

// ── Building blocks ─────────────────────────────────────────────────────────
export { createClient } from './client.js';
export { createTwinStore, DEPTH_BAND_STOPS } from '../store/useTwin.js';

/** The feature catalogue — ids, labels, groupings, and the copy describing each
 *  one. Pure data (no engine imports), so it is safe to render a capability
 *  list from it without pulling in the 600 KB renderer. */
export {
  FEATURES, GROUPS, FEATURE_BY_ID, PANEL_FEATURES, PANEL_GROUPS,
  featuresInGroup, panelFeaturesInGroup, defaultState,
} from '../features/registry.js';

/** Dataset descriptors: ids, labels and the blurb shown in the source panel. */
export { DATASETS } from '../engine/simData.js';

/** Depth→colour helpers, so a partner's own legend matches the map exactly. */
export { colorForDepth, cssGradient } from '../engine/palette.js';

/**
 * Every path the console requests, relative to `baseUrl`, plus `/api/usage`
 * for your own quota reporting. This is the allowlist your proxy needs to
 * forward — see examples/express-proxy.mjs. Exported as data so an integration
 * test can assert the proxy covers it.
 */
export const FLOODTWIN_PATHS = Object.freeze([
  '/api/config',
  '/api/assets',
  '/api/locality',
  '/api/geocode/autocomplete',
  '/api/geocode/place',
  '/api/route',
  '/api/live-forecast/status',
  '/api/live-forecast/latest',
  '/api/usage',       // your key's own consumption; unscoped and never billed
  '/sim/',            // manifest.json + the frame/geometry binaries
  '/live/',           // daily forecast dynamics
  '/drainage/',       // network + point inventories, as GeoJSON
  '/Gurugram_wards.geojson',
  '/Gurugram_district.geojson',
]);
