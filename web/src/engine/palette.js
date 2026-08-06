/* ─────────────────────────────────────────────────────────────────────────────
 * palette.js — the single source of truth for the flood-depth colour ramp.
 *
 * These stops ARE the zoom.earth precipitation palette, read straight out of the
 * 512×2 LUT texture their WebGL layer samples (`texture2D(palette, vec2(i,.5))`).
 * Only the working part of that texture is used — past ≈0.34 it washes out to
 * white, which carries no information for a depth field.
 *
 * The ramp reaches the GPU as a 256×1 LUT sampled with LINEAR filtering, so the
 * gradient is continuous by construction: there are no smoothstep seams to band
 * on, which is what made the old five-colour mix read as hard contour lines.
 * The CSS legend is generated from the same stops, so swatch and pixel cannot
 * drift apart.
 * ─────────────────────────────────────────────────────────────────────────── */

// t → colour, sampled at 17 even positions across zoom.earth's working range:
// pale ice-blue → blue → indigo → violet → magenta → coral → orange → yellow.
export const STOPS = [
  [0.0000, 0xbc, 0xe4, 0xfb],
  [0.0625, 0x76, 0xba, 0xf8],
  [0.1250, 0x5f, 0xa1, 0xf3],
  [0.1875, 0x53, 0x82, 0xe8],
  [0.2500, 0x5a, 0x60, 0xd4],
  [0.3125, 0x96, 0x5b, 0xb4],
  [0.3750, 0xc3, 0x5c, 0x9a],
  [0.4375, 0xe1, 0x5b, 0x84],
  [0.5000, 0xf6, 0x61, 0x72],
  [0.5625, 0xf7, 0x78, 0x67],
  [0.6250, 0xf8, 0x93, 0x5a],
  [0.6875, 0xf8, 0xaf, 0x4e],
  [0.7500, 0xf9, 0xca, 0x42],
  [0.8125, 0xfa, 0xe6, 0x36],
  [0.8750, 0xf9, 0xf5, 0x2f],
  [0.9375, 0xfa, 0xf9, 0x3e],
  [1.0000, 0xfb, 0xfa, 0x52],
];

// A flood field is dominated by shallow sheet flow, so a straight linear map
// spends most of the palette on cells nobody can tell apart. The gamma opens up
// the shallow end without introducing a step anywhere. 0.65 pushed mid depths
// too far up the ramp, so ordinary sheet flow came out magenta; 0.85 keeps the
// bulk of the city in the blues where zoom.earth keeps light rain.
export const GAMMA = 0.85;
export const LUT_N = 256;

// The raw zoom.earth stops are tuned for an opaque radar overlay. Over a street
// map they read heavy, so every stop is lifted toward white before use — the hue
// progression is untouched, the whole ramp just sits lighter.
const LIGHTEN = 0.28;
const lift = (v) => Math.round(v + (255 - v) * LIGHTEN);

export function rgbAt(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let i = 1;
  while (i < STOPS.length - 1 && STOPS[i][0] < t) i++;
  const a = STOPS[i - 1], b = STOPS[i];
  const f = (t - a[0]) / ((b[0] - a[0]) || 1);
  return [
    lift(a[1] + (b[1] - a[1]) * f),
    lift(a[2] + (b[2] - a[2]) * f),
    lift(a[3] + (b[3] - a[3]) * f),
  ];
}

const hex2 = (v) => v.toString(16).padStart(2, '0');
export const hexAt = (t) => '#' + rgbAt(t).map(hex2).join('');

/** CSS gradient over the same stops — used by the legend bar and landing page. */
export function cssGradient(angle = '90deg') {
  const body = STOPS
    .map((s) => `${hexAt(s[0])} ${(s[0] * 100).toFixed(1)}%`)
    .join(', ');
  return `linear-gradient(${angle}, ${body})`;
}

/** Ramp position for a depth in metres, using the shader's own gamma. */
export function tForDepth(depth, maxDepth) {
  const n = Math.max(0.05, maxDepth || 1);
  return Math.pow(Math.min(1, Math.max(0, depth / n)), GAMMA);
}

/** Colour for a depth — keeps panel chrome (dots, beacons) matching the map. */
export const colorForDepth = (depth, maxDepth) => hexAt(tForDepth(depth, maxDepth));

let _lut = null;
export function lut() {
  if (_lut) return _lut;
  _lut = new Uint8Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const c = rgbAt(i / (LUT_N - 1));
    _lut[i * 3] = c[0]; _lut[i * 3 + 1] = c[1]; _lut[i * 3 + 2] = c[2];
  }
  return _lut;
}

/** 256×1 RGB LUT texture. LINEAR filtering is what makes the ramp continuous. */
let _tex = null;
export function rampTexture(THREE) {
  if (_tex) return _tex;
  _tex = new THREE.DataTexture(lut(), LUT_N, 1, THREE.RGBFormat);
  _tex.minFilter = THREE.LinearFilter;
  _tex.magFilter = THREE.LinearFilter;
  _tex.wrapS = _tex.wrapT = THREE.ClampToEdgeWrapping;
  _tex.generateMipmaps = false;
  _tex.needsUpdate = true;
  return _tex;
}

/**
 * GLSL side of the ramp. Bind `uRamp` to rampTexture(THREE) and `uRampGamma` to
 * GAMMA. Shared verbatim by the 2-D flood sheet and the in-pipe storm water, so
 * a given depth is the same colour above ground and below it.
 */
export const GLSL_RAMP = `
uniform sampler2D uRamp;
uniform float uRampGamma;
vec3 floodRamp(float depth, float maxDepth){
  float t = clamp(depth / max(maxDepth, 0.05), 0.0, 1.0);
  t = pow(t, uRampGamma);
  // half-texel inset so both end stops are reachable exactly
  return texture2D(uRamp, vec2(mix(0.001953, 0.998047, t), 0.5)).rgb;
}
vec3 floodRampT(float t){
  return texture2D(uRamp, vec2(mix(0.001953, 0.998047, clamp(t,0.0,1.0)), 0.5)).rgb;
}`;

/** Uniforms every material that uses floodRamp() must merge in. */
export const rampUniforms = (THREE) => ({
  uRamp: { value: rampTexture(THREE) },
  uRampGamma: { value: GAMMA },
});
