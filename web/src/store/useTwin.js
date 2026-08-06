/* ─────────────────────────────────────────────────────────────────────────────
 * useTwin.js — the console's single state store.
 *
 * React components read from here; the engine controller subscribes to it and
 * pushes changes into WebGL. Nothing in the tree reaches into the engine
 * directly, and the engine never calls setState during a render — which is what
 * keeps a 60 fps map from re-rendering the sidebar.
 * ─────────────────────────────────────────────────────────────────────────── */
import { create } from 'zustand';
import { defaultState } from '../features/registry.js';

export const DEPTH_BAND_STOPS = [0.0667, 0.2, 0.4];   // fractions of the day's max

export const useTwin = create((set, get) => ({
  // ── lifecycle
  phase: 'boot',            // boot | ready | error
  status: 'Starting…',
  error: null,

  // ── features
  features: defaultState(),
  featureStatus: {},        // id → idle | loading | ready | error
  featureError: {},         // id → message

  // ── timeline
  dataset: 'event',
  manifest: null,
  step: 0,
  totalSteps: 12,
  playing: false,
  speed: 500,

  // ── flood presentation
  opacity: 0.78,
  maxDepth: 3.0,
  bands: [true, true, true, true],

  // ── derived readouts
  kpi: null,
  hotspots: [],
  roadSegments: [],
  assetCounts: {},
  sewerStats: null,
  drainStats: null,
  surcharged: 0,
  runStatus: null,

  setPhase: (phase) => set({ phase }),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error, phase: 'error' }),

  setFeature: (id, on) => set((s) => ({ features: { ...s.features, [id]: on } })),
  toggleFeature: (id) => set((s) => {
    const cur = s.features[id];
    // `auto` children (the zoom-gated pipe tiers) pin to OFF on first click, so
    // one tap always visibly changes something.
    const next = cur === 'auto' ? false : !cur;
    return { features: { ...s.features, [id]: next } };
  }),
  resetChildAuto: (id) => set((s) => ({ features: { ...s.features, [id]: 'auto' } })),
  setGroupAll: (ids, on) => set((s) => {
    const f = { ...s.features };
    for (const id of ids) f[id] = on;
    return { features: f };
  }),

  setFeatureStatus: (id, st, msg) => set((s) => ({
    featureStatus: { ...s.featureStatus, [id]: st },
    featureError: msg ? { ...s.featureError, [id]: msg } : s.featureError,
  })),

  setStep: (step) => set((s) => ({ step: Math.max(0, Math.min(s.totalSteps, step)) })),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setTimeline: (manifest, dataset) => set({
    manifest, dataset, totalSteps: Math.max(0, (manifest?.n_hours || 1) - 1),
  }),

  setOpacity: (opacity) => set({ opacity }),
  setMaxDepth: (maxDepth) => set({ maxDepth }),
  toggleBand: (i) => set((s) => {
    const bands = s.bands.slice();
    bands[i] = !bands[i];
    return { bands };
  }),
  resetBands: () => set({ bands: [true, true, true, true] }),

  setKpi: (kpi) => set({ kpi }),
  setHotspots: (hotspots) => set({ hotspots }),
  setRoadSegments: (roadSegments) => set({ roadSegments }),
  setAssetCounts: (assetCounts) => set({ assetCounts }),
  setSewerStats: (sewerStats) => set({ sewerStats }),
  setDrainStats: (drainStats) => set({ drainStats }),
  setSurcharged: (surcharged) => set({ surcharged }),
  setRunStatus: (runStatus) => set({ runStatus }),

  /** Band edges in metres for the current colour scale. */
  bandEdges: () => DEPTH_BAND_STOPS.map((f) => +(f * get().maxDepth).toFixed(3)),
}));
