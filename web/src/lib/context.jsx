/* ─────────────────────────────────────────────────────────────────────────────
 * context.jsx — what one mounted console instance carries with it.
 *
 * Three things are per-instance and were previously module-global: the state
 * store, the HTTP client (which knows the base URL), and the runtime options
 * (debug, callbacks, the Mappls key). They travel together through one context
 * so a component deep in the tree — a legend, a panel — can read state without
 * anything being a singleton.
 *
 * `useTwin(selector)` is deliberately call-compatible with the old singleton
 * hook, so every existing `useTwin((s) => s.step)` reads unchanged. Only the
 * imperative uses had to move: `useTwin.getState()` becomes
 * `useTwinStore().getState()`, because a hook cannot carry the store's methods.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { createContext, useContext } from 'react';
import { useStore } from 'zustand';

const TwinContext = createContext(null);

export function FloodTwinProvider({ store, client, options = {}, children }) {
  // The value object is memoised on its three parts rather than rebuilt each
  // render: a fresh object here would re-render every consumer on every parent
  // render, which for the panels means a re-render per animation frame.
  const value = React.useMemo(
    () => ({ store, client, options }),
    [store, client, options],
  );
  return <TwinContext.Provider value={value}>{children}</TwinContext.Provider>;
}

function useInstance(what) {
  const ctx = useContext(TwinContext);
  if (!ctx) {
    throw new Error(
      `${what} was used outside <FloodTwinConsole>. If you are composing the ` +
      'exported panels yourself, wrap them in <FloodTwinProvider>.',
    );
  }
  return ctx;
}

/** Subscribe to this instance's store. Same call shape as the old singleton. */
export function useTwin(selector, equalityFn) {
  const { store } = useInstance('useTwin');
  return useStore(store, selector, equalityFn);
}

/** The raw store — getState / setState / subscribe. */
export function useTwinStore() {
  return useInstance('useTwinStore').store;
}

/** This instance's HTTP client (knows the base URL). */
export function useClient() {
  return useInstance('useClient').client;
}

/** Runtime options passed to <FloodTwinConsole> (debug, callbacks, keys). */
export function useOptions() {
  return useInstance('useOptions').options;
}

/**
 * Public read/write handle on a mounted console, for partners who want to drive
 * it from their own chrome — read the timeline, flip a layer, jump somewhere.
 * Returns plain values and functions; no zustand knowledge required.
 */
export function useFloodTwin() {
  const store = useTwinStore();
  const phase = useTwin((s) => s.phase);
  const status = useTwin((s) => s.status);
  const step = useTwin((s) => s.step);
  const totalSteps = useTwin((s) => s.totalSteps);
  const playing = useTwin((s) => s.playing);
  const dataset = useTwin((s) => s.dataset);
  const features = useTwin((s) => s.features);
  const kpi = useTwin((s) => s.kpi);
  const hotspots = useTwin((s) => s.hotspots);

  return React.useMemo(() => ({
    phase, status, step, totalSteps, playing, dataset, features, kpi, hotspots,
    setStep: (n) => store.getState().setStep(n),
    setPlaying: (v) => store.getState().setPlaying(v),
    setDataset: (id) => store.setState({ dataset: id }),
    setFeature: (id, on) => store.getState().setFeature(id, on),
    toggleFeature: (id) => store.getState().toggleFeature(id),
  }), [store, phase, status, step, totalSteps, playing, dataset, features, kpi, hotspots]);
}
