/* Emit the package's TypeScript declarations.
 *
 * Hand-written rather than generated: the source is JavaScript, so `tsc
 * --declaration` would infer `any` for most of the public surface and produce a
 * worse contract than this file states explicitly. It is small and changes only
 * when the public API does — which, being the thing partners compile against, is
 * exactly when someone should be made to think about it.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)),
                    '../packages/floodtwin-react/dist/index.d.ts');

const DTS = `// @airesq/floodtwin-react — type declarations.
import * as React from 'react';

/** Dataset ids the console can play. */
export type FloodTwinDataset = 'event' | 'live';

/** A feature toggle. \`'auto'\` lets the engine decide by zoom (pipe tiers). */
export type FeatureValue = boolean | 'auto';

export interface FloodTwinBrand {
  title?: string;
  subtitle?: string;
  /** Image URL, or \`false\` to omit the logo. */
  logo?: string | false;
}

/** Live handle on a booted console, passed to \`onReady\`. */
export interface TwinHandle {
  engine: any;
  sim: any;
  handles: Record<string, any>;
  /** Fly to the deepest cell in the current frame. */
  jumpToDeepest(): { lng: number; lat: number; depth: number } | null;
  flyTo(lng: number, lat: number, zoom?: number): void;
  /** Flood depth in metres at a coordinate, for the current frame. */
  depthAt(lng: number, lat: number): number;
  destroy(): void;
}

export interface FloodTwinConsoleProps {
  /**
   * Where FloodTwin is reachable from the browser. Normally a path on YOUR
   * server that proxies to FloodTwin with the secret key attached — e.g.
   * '/api/floodtwin'. Never point this straight at the FloodTwin host: keys are
   * server-side credentials and a browser request carries none.
   */
  baseUrl?: string;
  /** Extra headers on every request — your own auth against your own origin. */
  headers?: Record<string, string> | null;
  /** fetch credentials mode. Use 'same-origin' if your proxy needs your cookie. */
  credentials?: RequestCredentials;
  /** fetch override, for tests or SSR frameworks. */
  fetch?: typeof globalThis.fetch | null;
  /**
   * Your own Mappls SDK key. Recommended: a map SDK key is necessarily visible
   * to the browser using it, so supplying yours avoids consuming ours.
   */
  mapplsApiKey?: string;
  dataset?: FloodTwinDataset;
  /** Initial toggles, merged over the defaults — \`{ drainage: true }\`. */
  features?: Record<string, FeatureValue>;
  /** Masthead content, or \`false\` to drop it inside your own chrome. */
  brand?: FloodTwinBrand | false;
  className?: string;
  onReady?(twin: TwinHandle): void;
  onError?(err: Error): void;
  /** Renders the Home affordance. Omit for no exit control. */
  onExit?(): void;
  /** Renders the Sign out button. Omit for none. */
  onSignOut?(): void;
  /** A lazily-loaded feature chunk failed (usually a stale deploy). */
  onChunkError?(err: Error, featureId: string): void;
  debug?: boolean;
  /** Boot without the three.js layer, to isolate a rendering problem. */
  skipGL?: boolean;
  /** Mount only the first N default-on features, to bisect a regression. */
  featureLimit?: number;
}

/** The whole console, feature toggles included. */
export declare const FloodTwinConsole: React.FC<FloodTwinConsoleProps>;
export default FloodTwinConsole;

/** Read and drive a mounted console from your own UI. */
export declare function useFloodTwin(): {
  phase: 'boot' | 'ready' | 'error';
  status: string;
  step: number;
  totalSteps: number;
  playing: boolean;
  dataset: FloodTwinDataset;
  features: Record<string, FeatureValue>;
  kpi: {
    wetKm2: number; impassableKm2: number; meanDepth: number; maxDepth: number;
  } | null;
  hotspots: Array<{ lat: number; lng: number; avg: number; max: number; count: number }>;
  setStep(n: number): void;
  setPlaying(v: boolean): void;
  setDataset(id: FloodTwinDataset): void;
  setFeature(id: string, on: FeatureValue): void;
  toggleFeature(id: string): void;
};

export declare const FloodTwinProvider: React.FC<{
  store: any; client: any; options?: any; children?: React.ReactNode;
}>;
export declare function useTwin<T>(selector: (state: any) => T): T;
export declare function useTwinStore(): any;
export declare function useClient(): any;

// Composable pieces. Mount inside <FloodTwinProvider>; MapCanvas boots the engine.
export declare const MapCanvas: React.FC<{ onReady?(twin: TwinHandle): void }>;
export declare const LayersPanel: React.FC;
export declare const DrainageLegend: React.FC;
export declare const DataSourcePanel: React.FC;
export declare const TimeControl: React.FC;
export declare const DepthLegend: React.FC;
export declare const KpiStrip: React.FC;
export declare const HotspotsPanel: React.FC<{ twin?: TwinHandle | null }>;
export declare const RoadPanel: React.FC<{ twin?: TwinHandle | null }>;
export declare const SearchBar: React.FC<{ twin?: TwinHandle | null }>;

export declare function createClient(opts: {
  baseUrl?: string;
  headers?: Record<string, string> | null;
  fetch?: typeof globalThis.fetch | null;
  credentials?: RequestCredentials;
}): any;
export declare function createTwinStore(overrides?: Record<string, unknown>): any;
export declare const DEPTH_BAND_STOPS: number[];

export interface FeatureDef {
  id: string;
  group: string;
  icon: string;
  label: string;
  short: string;
  blurb: string;
  defaultOn: boolean;
  heavy?: boolean;
  essential?: boolean;
  mapControl?: boolean;
  zoomHint?: string;
  children?: Array<{ id: string; label: string; defaultOn?: boolean; auto?: boolean; hint?: string }>;
}
export declare const FEATURES: FeatureDef[];
export declare const GROUPS: Array<{ id: string; label: string; icon: string; blurb: string }>;
export declare const FEATURE_BY_ID: Record<string, FeatureDef>;
export declare const PANEL_FEATURES: FeatureDef[];
export declare const PANEL_GROUPS: Array<{ id: string; label: string; icon: string; blurb: string }>;
export declare function featuresInGroup(groupId: string): FeatureDef[];
export declare function panelFeaturesInGroup(groupId: string): FeatureDef[];
export declare function defaultState(): Record<string, FeatureValue>;

export declare const DATASETS: Record<FloodTwinDataset, {
  id: string; base: string; label: string; blurb: string;
}>;

export declare function colorForDepth(depth: number, maxDepth: number): string;
export declare function cssGradient(direction?: string): string;

/** Every path the console requests, relative to \`baseUrl\` — the allowlist your
 *  proxy must forward. */
export declare const FLOODTWIN_PATHS: readonly string[];
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, DTS);
console.log(`emit-types: wrote ${OUT}`);
