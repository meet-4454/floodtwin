/* ─────────────────────────────────────────────────────────────────────────────
 * drainageViz.js — the buried storm-drain network in 3-D.
 *
 * Source: the coupled run's OWN 118,768 nodes / 139,798 links (see simData.js).
 * No synthetic network, no derived hydraulics — the water level in every pipe is
 * that node's solved depth (drain_node_volume / drain_node_storage_area), in
 * METRES above that node's own solved invert.
 *
 * THREE RULES this renderer is built around, each learned by getting it wrong:
 *
 *  1. THE WATER IS THE OPAQUE THING; THE CASING IS A GHOST. Every skin used to be
 *     transparent + depthWrite:false, so overlapping conduits stacked alpha and a
 *     dense city network became an unreadable blue glow with no depth ordering.
 *     The submerged part of the tube shell is now opaque and depth-written; the
 *     casing is alpha ~0.1 with a Fresnel rim. Occlusion is what removes the mush.
 *
 *  2. WATER COLOUR IS THE SURFACE FLOOD'S COLOUR, KEYED ON DEPTH IN METRES.
 *     0.4 m standing in a pipe is the same colour as 0.4 m standing on the street
 *     above it (palette.js drives both). That is what makes the underground read
 *     as the same event as the surface rather than a separate blue diagram.
 *
 *  3. CLUTTER IS SOLVED BY ZOOM, NOT BY DELETING LINKS. An earlier flow-threshold
 *     LOD kept 14 % of links and deleted the connective tissue between reaches —
 *     the network rendered as disconnected floating fragments. Every link is
 *     built; which TIERS are drawn is chosen by zoom, so the city view shows the
 *     trunk skeleton and the laterals resolve as you go in.
 *
 *  4. THE WATERLINE IS A HEIGHT IN METRES, NOT A PERCENTAGE OF EACH PIPE. The
 *     level used to be depth ÷ that node's OWN max depth, which meant a deep
 *     trunk holding 2.0 m read as 40 % while a shallow lateral holding 0.5 m
 *     read as 50 % — the shallow one looked fuller than the drain beneath it,
 *     which is backwards. And because the fraction was applied to each conduit's
 *     own (cosmetic, flow-derived) radius, two pipes meeting at one manhole put
 *     their waterlines at different heights, so the water surface broke at every
 *     junction. Now: the level is the solved depth in metres against ONE global
 *     reference (uWaterRef, the network's own median node depth — a constant,
 *     unlike the surface colour scale, which grows during the event and would
 *     re-level every pipe mid-playback), raised from the node's invert through a radius SHARED by every conduit at
 *     that node (aNRad). One node → one water surface elevation, and more metres
 *     always reads as more water anywhere in the city. A conduit thinner than
 *     that shared radius clips at its own crown and reads FULL, which is what a
 *     small lateral under the same head physically is.
 *
 *     The one thing this still cannot be is metre-true IN HEIGHT: the bore is
 *     cosmetic (there are no diameters in the run), so the waterline is that
 *     many metres compressed into a drawn bore, not that many metres of world.
 *     The manhole columns ARE metre-true — their span really is invert→rim — so
 *     they read slightly higher than the pipe line at the same node. Read the
 *     columns for "how close to the street", the pipe line for "how full".
 * ─────────────────────────────────────────────────────────────────────────── */
import { GLSL_RAMP, rampUniforms } from './palette.js';

export const TIERS = [
  { key: 'trunk',   label: 'Trunk main',  min: 1.0,  color: [0.96, 0.49, 0.20] },
  { key: 'main',    label: 'Branch main', min: 0.25, color: [0.16, 0.55, 0.86] },
  { key: 'lateral', label: 'Lateral',     min: 0.0,  color: [0.28, 0.74, 0.82] },
];
export const tierOf = (q) => (q >= 1.0 ? 0 : q >= 0.25 ? 1 : 2);

// Radial segments per ring. At 5 the cross-section was a visible pentagon and
// the water inside it — clipped against that same section — came out flat-sided.
// 14 is smooth enough that the silhouette reads as a drawn cylinder even at a
// steep pitch. Paid for by the collinear decimation below, which removes ~32%
// of all rings.
const R = 14;
// Fatter than true scale: at true bore these read as wire, not pipework.
const R_MIN = 0.95, R_MAX = 3.7;

// Depth exaggeration. Real burial is 0.3–12 m; at the old 8× a 3 m-deep node sat
// 24 m under the street — deeper than the buildings above it are tall, which
// read as a mistake rather than as depth. 3.5× still separates crown from invert
// clearly at zoom 17+ while staying plausible against the skyline.
export const DEFAULT_VEXAG = 3.5;

// Conduit class (build_link_classes.py): storm / sewer / unclassified.
export const CLASSES = [
  { key: 'storm',        label: 'Storm conduits',  color: [0.20, 0.62, 0.90] },
  { key: 'sewer',        label: 'Sewer conduits',  color: [0.55, 0.38, 0.78] },
  { key: 'unclassified', label: 'Unclassified',    color: [0.45, 0.52, 0.58] },
];

// Zoom → which tiers are legible. Drawing 139k laterals at city zoom is what
// made the network read as a blue smear; below z14 they are sub-pixel anyway.
const ZOOM_TIER_GATE = [0, 13.2, 15.0];   // tier i appears at or above this zoom

/* Shared noise + caustics, lifted verbatim from the surface-flood shader so the
 * water below ground ripples and glints with the same signature as the sheet
 * above it. Cheap on purpose: 2 octaves, gradients from derivatives. */
const GLSL_WATER_COMMON = `
// ── IN-PIPE WATER COLOUR ────────────────────────────────────────────────────
// A water-blue gradient keyed on METRES OF WATER ÷ uWaterRef, not on the surface
// flood's own precipitation ramp. Sharing that ramp made a running conduit magenta/orange,
// which read as an alarm state rather than as water. Blue says "this is water";
// the ramp still says "how much" because it is strictly MONOTONIC — pale for a
// few centimetres, deep blue at the reference depth. Keying it on metres rather
// than on each pipe's own percentage is what makes a deep drain holding 2 m read
// as more water than a shallow one holding 0.5 m (it used to read as less).
vec3 pipeWater(float f){
  vec3 a = vec3(0.847, 0.949, 0.996);   // #D8F2FE  barely wet
  vec3 b = vec3(0.596, 0.839, 0.965);   // #98D6F6
  vec3 c = vec3(0.376, 0.667, 0.902);   // #60AAE6
  vec3 d = vec3(0.216, 0.478, 0.769);   // #377AC4  running full
  vec3 col = mix(a, b, smoothstep(0.02, 0.35, f));
  col = mix(col, c, smoothstep(0.30, 0.72, f));
  col = mix(col, d, smoothstep(0.66, 1.0, f));
  return col;
}
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float v = 0.5*noise(p); p = p*2.1 + vec2(1.7,9.2); return v + 0.25*noise(p); }
// Interference of two advected noise fields — the same construction the surface
// sheet uses for its caustic web.
float caustics(vec2 a, vec2 b){
  float nA = fbm(a), nB = fbm(b);
  return pow(clamp(1.0 - abs(nA - nB), 0.0, 1.0), 8.0);
}`;

/* ── PIPE CASING ─────────────────────────────────────────────────────────────
 * A ghost of the conduit: a thin tier-coloured edge, brightest at grazing
 * angles. Above the waterline it also gets a faint interior shadow, so an EMPTY
 * pipe still reads as a hollow bore you can see into rather than as nothing —
 * without that, "no water" and "no pipe" looked identical.                    */
const CASE_VERT = `
  attribute float aTier; attribute float aClass;
  attribute float aWaterM; attribute float aWaterMPrev; attribute float aU;
  attribute float aRad; attribute float aNRad;
  uniform vec3 uTierCol[3]; uniform float uTierOn[3];
  uniform vec3 uClassCol[3]; uniform float uClassOn[3];
  uniform float uMix; uniform float uClassTint; uniform float uWaterRef;
  varying vec3 vN; varying float vNy; varying vec3 vTC; varying float vFill;
  varying float vOn; varying float vDepthY;
  void main(){
    vN = normalize(normalMatrix*normal); vNy = normal.y;
    int t = int(aTier+0.5); int c = int(aClass+0.5);
    // Tier drives the size read, class drives the WHAT-IS-IT read; blend so both
    // survive. Storm stays blue, sewer violet — matching the 2-D sewer layer.
    vTC = mix(uTierCol[t], uClassCol[c], uClassTint);
    vOn = uTierOn[t] * uClassOn[c];
    // HOW FULL THIS BORE IS — the same quantity the water body clips against, so
    // the dry-bore shadow and the waterline always agree. (The capacity view
    // ramps on this too, which is what a capacity ramp should mean.)
    float wm = mix(aWaterMPrev, aWaterM, uMix);
    float rise = clamp(wm / max(uWaterRef, 0.01), 0.0, 1.0) * 2.0 * aNRad;
    vFill = clamp(rise / max(2.0*aRad, 0.001), 0.0, 1.0);
    vDepthY = position.y;
    gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
  }`;
const CASE_FRAG = `
  precision highp float;
  uniform float uMode, uTime;              // uMode 0 = water view, 1 = capacity view
  varying vec3 vN; varying float vNy; varying vec3 vTC; varying float vFill;
  varying float vOn; varying float vDepthY;
  void main(){
    if(vOn < 0.5) discard;
    // Aerial perspective, underground: the further below the street a conduit
    // sits the more it recedes. This is the strongest cue that the network has
    // real vertical extent rather than being a flat diagram lying under the map.
    float depthFog = clamp(1.0 + vDepthY*0.022, 0.42, 1.0);
    vec3 N = normalize(vN);
    float nl = 0.45 + 0.55*max(dot(N, normalize(vec3(0.4,0.9,0.35))),0.0);
    float f = clamp(vFill,0.0,1.0);
    if(uMode > 0.5){
      vec3 c = f<0.5 ? mix(vec3(0.13,0.55,0.28),vec3(0.55,0.66,0.18),f/0.5)
             : f<0.75? mix(vec3(0.55,0.66,0.18),vec3(0.92,0.72,0.20),(f-0.5)/0.25)
             : f<0.92? mix(vec3(0.92,0.72,0.20),vec3(0.90,0.42,0.12),(f-0.75)/0.17)
                     : vec3(0.86,0.16,0.10)*(0.85+0.15*sin(uTime*5.0));
      gl_FragColor = vec4(c*nl, 0.96); return;
    }
    float fres = pow(1.0 - abs(dot(N, vec3(0.0,1.0,0.0))), 3.0);
    // BARREL SHADING. Facet count alone never reads as round — what the eye uses
    // is the gradient ACROSS the section: a bright band where the surface faces
    // the light, falling to a dark terminator as it curves away.
    vec3 Lp = normalize(vec3(0.35, 0.86, 0.38));
    float lam = max(dot(N, Lp), 0.0);
    vec3 col = vTC*(0.40 + 0.60*nl) + fres*0.45;
    col += vec3(1.0, 0.99, 0.95) * pow(lam, 2.2) * 0.32;   // crown highlight
    col *= (1.0 - pow(1.0 - lam, 2.5) * 0.34);              // shade the far side
    // Dry bore: a touch of shadow on the airspace above the waterline so an
    // empty pipe reads as EMPTY rather than as absent.
    float level = 2.0*f - 1.0;
    float air = step(level, vNy);
    float a = (0.17 + fres*0.30 + air*0.10) * (0.55 + 0.45*depthFog);
    col = mix(col, col*0.55, air*0.5);
    col *= depthFog;
    gl_FragColor = vec4(col, a);
  }`;

/* ── WATER BODY ──────────────────────────────────────────────────────────────
 * The submerged part of the tube shell, opaque. A fragment is underwater when
 * its height in the circular section (the radial normal's y) sits below the
 * level, so the water automatically takes the pipe's circular-segment shape and
 * grows to a full round bore as it fills.
 * Colour is a water-blue ramp on METRES (see pipeWater) — blue reads as water. */
const WVOL_VERT = `
  attribute float aTier; attribute float aClass;
  attribute float aWaterM; attribute float aWaterMPrev; attribute float aU;
  attribute float aFlow; attribute float aRad; attribute float aNRad;
  uniform float uMix; uniform float uTierOn[3]; uniform float uClassOn[3];
  uniform float uWaterRef;
  varying float vNy; varying float vFill; varying float vFull; varying float vU; varying float vOn;
  varying vec3 vN; varying float vFlow; varying vec3 vW;
  varying float vDepthY;
  void main(){
    // vFill = water depth in METRES against the global reference — the colour key.
    // vFull = how full THIS conduit is, from the node-shared water surface height.
    float wm = mix(aWaterMPrev, aWaterM, uMix);
    vFill = clamp(wm / max(uWaterRef, 0.01), 0.0, 1.0);
    float rise = vFill * 2.0 * aNRad;              // height above the invert
    vFull = clamp(rise / max(2.0 * aRad, 0.001), 0.0, 1.0);
    vNy = normal.y; vU = aU; vFlow = aFlow;
    vDepthY = position.y;
    vOn = uTierOn[int(aTier+0.5)] * uClassOn[int(aClass+0.5)];
    vN = normalize(normalMatrix*normal);
    vec3 p = position - normal*0.06;   // sit just inside the casing, no z-fight
    vW = p;
    gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0);
  }`;
const WVOL_FRAG = `
  precision highp float;
  uniform float uTime;
  varying float vNy; varying float vFill; varying float vFull; varying float vU; varying float vOn;
  varying vec3 vN; varying float vFlow; varying vec3 vW;
  varying float vDepthY;
  ${GLSL_WATER_COMMON}
  void main(){
    if(vOn < 0.5) discard;
    float f = clamp(vFill,0.0,1.0);       // metres of water ÷ global reference
    if(f < 0.005) discard;                // dry pipe → only the ghost casing
    // The waterline sits where the node's water SURFACE cuts this bore; a conduit
    // narrower than the shared radius is simply submerged to its crown.
    float level = 2.0*vFull - 1.0;
    // Anti-alias the clip against the radial normal's screen gradient, so the
    // waterline follows the bore smoothly instead of stepping ring to ring.
    float aa = max(fwidth(vNy), 1e-4);
    if(vNy > level + aa) discard;         // above the waterline = air

    vec3 N = normalize(vN);
    float lam = max(dot(N, normalize(vec3(0.35,0.86,0.38))), 0.0);
    float nl = 0.55 + 0.45*lam;

    vec3 col = pipeWater(f);
    // Curve the water body across the section too, so a full bore reads as a
    // filled cylinder rather than a flat-topped slab.
    col *= (1.0 - pow(1.0 - lam, 2.6) * 0.30);
    col += vec3(0.85,0.95,1.0) * pow(lam, 3.0) * 0.16;
    float below = clamp((level - vNy)*0.5, 0.0, 1.0);
    col *= (1.0 - below*0.20);                      // gentle shading for roundness

    // CAUSTICS, advected downstream at the solved velocity — the same web the
    // 2-D sheet draws, so surface and sub-surface water read as one substance.
    float spd = abs(vFlow), sgn = sign(vFlow);
    float scroll = uTime*(0.8 + spd*4.8)*sgn;
    vec2 ca = vec2(vU*0.30 - scroll*1.4, (vW.x+vW.z)*0.26);
    vec2 cb = vec2(vU*0.46 - scroll*2.1, (vW.x-vW.z)*0.20 + 3.0);
    float caus = caustics(ca, cb);
    // Brightest just under the surface, as real caustics are.
    col += vec3(0.55,0.88,1.0) * caus * 0.62 * (1.0 - below);
    // the same packet train as the surface, so bore and surface move together
    float pkv = fract(vU*0.045 - uTime*(0.42 + spd*1.5)*sgn);
    col += vec3(0.5,0.8,1.0) * smoothstep(0.92,1.0,pkv)*smoothstep(1.0,0.97,pkv) * 0.22 * (1.0-below);

    // A meniscus so the WATER LINE itself is visible — the single strongest cue
    // for "how full is this pipe" — but wide and soft, so it reads as a curved
    // surface meeting the barrel rather than a drawn-on line.
    float edge = 1.0 - smoothstep(0.0, 0.20, level - vNy);
    col = mix(col, vec3(0.95,0.99,1.0), edge*0.42);

    float pres = smoothstep(0.96,1.0,vFull);        // running full → warm alarm
    col = mix(col, vec3(0.96,0.44,0.25), pres*(0.45+0.15*sin(uTime*5.0)));
    col *= clamp(1.0 + vDepthY*0.016, 0.55, 1.0);   // recede with burial depth
    gl_FragColor = vec4(col*nl, 1.0);
  }`;

/* ── INNER WATER SURFACE ─────────────────────────────────────────────────────
 * A flat ribbon riding at the node's solved water surface (invert + metres, via
 * the node-shared radius — see rule 4), with the chord width of the
 * circle at that height. It carries the flow: scrolling normal ripples, sun
 * glint, foam and travelling crests, all advected downstream at the solved
 * velocity — the top face of the water body, not a tint over the pipe.        */
const WAT_VERT = `
  attribute vec3 aPerp; attribute float aSide; attribute float aCenterY;
  attribute float aRad; attribute float aNRad;
  attribute float aWaterM; attribute float aWaterMPrev; attribute float aU;
  attribute float aFlow; attribute float aTier; attribute float aClass;
  uniform float uMix; uniform float uTime; uniform float uTierOn[3]; uniform float uClassOn[3];
  uniform float uWaterRef;
  varying float vFill; varying float vFull; varying float vU; varying float vFlow; varying vec3 vW;
  varying float vOn; varying float vChord;
  void main(){
    vOn = uTierOn[int(aTier+0.5)] * uClassOn[int(aClass+0.5)];
    vChord = aSide;
    // Metres of water ÷ the global reference, raised from the invert through the
    // radius SHARED by every conduit at this node, then clipped to this bore. Two
    // pipes meeting at a manhole therefore agree on the water surface exactly.
    float f = clamp(mix(aWaterMPrev, aWaterM, uMix) / max(uWaterRef, 0.01), 0.0, 1.0);
    float rise = clamp(f*2.0*aNRad, 0.0, 2.0*aRad);
    vFull = clamp(rise / max(2.0*aRad, 0.001), 0.0, 1.0);
    float waterY = aCenterY - aRad + rise;
    float dy = waterY - aCenterY;
    float halfW = sqrt(max(0.0, aRad*aRad - dy*dy))*0.92;
    // travelling waves — amplitude grows with flow speed, like the 2-D sheet
    float spd = abs(aFlow);
    float wave = sin(aU*0.5 - uTime*(1.0+spd*4.0)*sign(aFlow)) * (0.06 + spd*0.18)
               + sin(aU*1.3 + uTime*1.7) * 0.04;
    // A bore running full is pressurised — no free surface, so no ripple.
    waterY += wave * f * (1.0 - smoothstep(0.90, 1.0, vFull));
    vec3 wp = vec3(position.x + aPerp.x*aSide*halfW, waterY, position.z + aPerp.z*aSide*halfW);
    vFill=f; vU=aU; vFlow=aFlow; vW=wp;
    gl_Position = projectionMatrix*modelViewMatrix*vec4(wp,1.0);
  }`;
const WAT_FRAG = `
  precision highp float;
  uniform float uTime;
  varying float vFill; varying float vFull; varying float vU; varying float vFlow; varying vec3 vW;
  varying float vOn; varying float vChord;
  ${GLSL_WATER_COMMON}
  void main(){
    if(vOn < 0.5) discard;
    if(vFill < 0.005) discard;
    float spd = abs(vFlow), sgn = sign(vFlow);
    // FLOW-MAP scroll. A minimum rate matters: at low flow the old 0.35 base
    // read as standing water, and a storm drain that never moves looks broken
    // even when the solver says the flow is small.
    float scroll = uTime*(0.9 + spd*5.2)*sgn;
    vec2 uv1 = vec2(vU*0.11 - scroll,       (vW.x+vW.z)*0.16);
    vec2 uv2 = vec2(vU*0.21 - scroll*1.6,   (vW.x-vW.z)*0.12 + 2.0);
    // animated normal from noise gradients → ripples
    float e = 0.10;
    float hx = (noise(uv1+vec2(e,0.))-noise(uv1-vec2(e,0.))) + 0.7*(noise(uv2+vec2(e,0.))-noise(uv2-vec2(e,0.)));
    float hz = (noise(uv1+vec2(0.,e))-noise(uv1-vec2(0.,e))) + 0.7*(noise(uv2+vec2(0.,e))-noise(uv2-vec2(0.,e)));
    vec3 N = normalize(vec3(-hx*3.4, 1.0, -hz*3.4));
    vec3 V = normalize(cameraPosition - vW);
    vec3 L = normalize(vec3(0.4, 0.9, 0.35));
    float fres = 0.03 + 0.97*pow(1.0 - max(dot(N,V),0.0), 5.0);
    float glint = pow(max(dot(reflect(-L,N),V),0.0), 80.0);

    vec3 water = pipeWater(vFill);

    // the surface flood's caustic web, on the pipe's water surface
    float caus = caustics(uv1*2.2, uv2*1.7);
    water += vec3(0.6,0.9,1.0) * caus * 0.30;

    // travelling crests advecting downstream
    float crest = smoothstep(0.68, 1.0, sin(vU*0.7 - uTime*(2.6+spd*6.0)*sgn)*0.5+0.5 + (noise(uv1)-0.5)*0.6);
    water += vec3(0.85,0.95,1.0)*crest*0.26;
    // FLOW PACKETS: discrete bright pulses running downstream. Continuous noise
    // alone reads as shimmer; you need something with an edge to actually see
    // which way the water is going and how fast.
    float pk = fract(vU*0.045 - uTime*(0.42 + spd*1.5)*sgn);
    float packet = smoothstep(0.90, 1.0, pk) * smoothstep(1.0, 0.965, pk);
    water += vec3(0.75,0.93,1.0) * packet * (0.30 + spd*0.5);

    // The chord is WIDEST at exactly half-full, so an undamped sky wash puts the
    // palest pixels on screen at mid-fill and a half-full pipe reads as fuller
    // than a full one. Damp the highlight as the pipe fills.
    float bright = (1.0 - vFull*0.55) * (1.0 - smoothstep(0.5, 1.0, abs(vChord))*0.75);
    water = mix(water, mix(water, vec3(0.88,0.95,1.0), 0.7), fres*0.24*bright);
    water += vec3(1.0,0.98,0.92)*glint*bright;
    float turb = smoothstep(0.22, 0.8, spd) * step(0.015, spd);
    float foam = smoothstep(0.5, 1.0, noise(vec2(vU*0.4 - scroll*2.2, (vW.x+vW.z)*0.5)));
    water = mix(water, vec3(0.96,0.99,1.0), foam*turb*0.7*bright);
    float pres = smoothstep(0.9,1.0,vFull);
    water = mix(water, vec3(0.97,0.42,0.24), pres*(0.35+0.15*sin(uTime*5.0)));
    water = mix(water, vec3(1.0), pres*foam*0.5);
    // ── EDGE SHAPING ──────────────────────────────────────────────────────
    // The surface is a flat chord across a round bore. Left flat-shaded it read
    // as a plate laid on top of the pipe, with a hard straight cut where it met
    // the wall. Rolling the shading off toward the chord ends — darker, less
    // specular, tending to the submerged colour — makes the surface tuck into
    // the barrel, so the water reads as filling a cylinder.
    float edge = abs(vChord);
    float roll = smoothstep(0.55, 1.0, edge);
    water = mix(water, pipeWater(vFill) * 0.62, roll * 0.85);
    water *= 1.0 - roll * 0.18;
    gl_FragColor = vec4(water, 1.0);
  }`;

/** Walk degree-2 nodes into polylines so tubes are welded, not per-link stubs. */
function traceChains(keep, linkFrom, linkTo) {
  const adj = new Map();
  const push = (n, e) => { let a = adj.get(n); if (!a) { a = []; adj.set(n, a); } a.push(e); };
  for (let k = 0; k < keep.length; k++) {
    const i = keep[k];
    push(linkFrom[i], { k, other: linkTo[i] });
    push(linkTo[i], { k, other: linkFrom[i] });
  }
  const deg = (n) => (adj.get(n) || []).length;
  const used = new Uint8Array(keep.length), chains = [];
  const walk = (start, first) => {
    const nodes = [start], slots = [];
    let e = first, guard = 0;
    while (e && !used[e.k] && guard++ < 100000) {
      used[e.k] = 1; slots.push(e.k); nodes.push(e.other);
      const cur = e.other;
      if (deg(cur) !== 2) break;
      const nb = adj.get(cur);
      const nx = nb[0].k === e.k ? nb[1] : nb[0];
      if (!nx || used[nx.k]) break;
      e = nx;
    }
    if (slots.length) chains.push({ nodes, slots });
  };
  for (const [n, es] of adj) if (es.length !== 2) for (const e of es) if (!used[e.k]) walk(n, e);
  for (let k = 0; k < keep.length; k++) if (!used[k]) { const i = keep[k]; walk(linkFrom[i], { k, other: linkTo[i] }); }
  return chains;
}

/* ── MANHOLE WATER ───────────────────────────────────────────────────────────
 * A water column inside each shaft, standing at that node's SOLVED level and
 * coloured by its SOLVED status. Previously the shafts were inert grey tubes:
 * the surcharge bitmask was only ever drawn as flat pins on the ground, so the
 * one thing a manhole is for — showing water backing up a shaft and reaching the
 * street — was missing.
 *   normal      → blue column at the solved fill height
 *   surcharging → column at the rim, warm alarm, pulsing
 * `aRise` is the node's fill 0..1; `aSurch` is its bitmask flag.                */
const SHAFT_VERT = `
  attribute float aRise; attribute float aRisePrev; attribute float aSurch; attribute float aBaseY;
  uniform float uMix;
  varying float vY; varying float vTop; varying float vSurch; varying float vBaseY;
  void main(){
    float r = mix(aRisePrev, aRise, uMix);
    vSurch = aSurch; vBaseY = aBaseY;
    // Surcharging nodes are, by definition, at or above the rim.
    float top = mix(aBaseY, 0.05, clamp(r + aSurch*0.35, 0.0, 1.0));
    vTop = top;
    vec3 p = position;
    // The column's own top vertices ride the water level; the base stays put.
    if(p.y > aBaseY + 0.001) p.y = top;
    vY = p.y;
    gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0);
  }`;
const SHAFT_FRAG = `
  precision highp float;
  uniform float uTime;
  varying float vY; varying float vTop; varying float vSurch; varying float vBaseY;
  void main(){
    if(vTop <= vBaseY + 0.02) discard;               // dry shaft
    float depthFrac = clamp((vTop - vY) / max(vTop - vBaseY, 0.01), 0.0, 1.0);
    vec3 calm = mix(vec3(0.596,0.839,0.965), vec3(0.216,0.478,0.769), depthFrac);
    vec3 alarm = vec3(0.965,0.478,0.259);
    vec3 col = mix(calm, alarm, vSurch*(0.62 + 0.18*sin(uTime*4.0)));
    // brighten the meniscus at the top of the column
    col = mix(col, vec3(0.95,0.99,1.0), (1.0 - smoothstep(0.0, 0.35, vTop - vY))*0.45);
    gl_FragColor = vec4(col, 0.88);
  }`;

/** Merged vertical shafts from each junction node's pipe up to street level. */
function buildShafts(THREE, junc, nx, ny, nz) {
  if (!junc.length) return null;
  // Slimmer than a real manhole would scale to, deliberately: at true width and
  // 8× depth these were a forest of grey columns that hid the pipes they exist
  // to explain. The shaft's job is to say "this is how far down the street is",
  // so it needs to be readable, not massive.
  const S = 6, sr = 0.26, rimR = 0.46;
  const perNode = (S + 1) * 4;
  const V = junc.length * perNode;
  const pos = new Float32Array(V * 3), nrm = new Float32Array(V * 3);
  const idx = new Uint32Array(junc.length * S * 6 * 2);
  const cs = new Float32Array(S + 1), sn = new Float32Array(S + 1);
  for (let s = 0; s <= S; s++) { const t = (s / S) * Math.PI * 2; cs[s] = Math.cos(t); sn[s] = Math.sin(t); }
  let vo = 0, io = 0, base = 0;
  for (const n of junc) {
    const x = nx[n], z = nz[n], yb = ny[n];
    for (let e = 0; e < 2; e++) {
      const y = e ? 0.0 : yb;
      for (let s = 0; s <= S; s++) {
        const ox = cs[s] * sr, oz = sn[s] * sr;
        pos[vo] = x + ox; pos[vo + 1] = y; pos[vo + 2] = z + oz;
        const il = 1 / (Math.hypot(ox, oz) || 1);
        nrm[vo] = ox * il; nrm[vo + 1] = 0; nrm[vo + 2] = oz * il; vo += 3;
      }
    }
    for (let e = 0; e < 2; e++) {
      const rr = e ? rimR : sr;
      for (let s = 0; s <= S; s++) {
        pos[vo] = x + cs[s] * rr; pos[vo + 1] = 0.15; pos[vo + 2] = z + sn[s] * rr;
        nrm[vo] = 0; nrm[vo + 1] = 1; nrm[vo + 2] = 0; vo += 3;
      }
    }
    const w0 = base, w1 = base + (S + 1), r0 = base + (S + 1) * 2, r1 = base + (S + 1) * 3;
    for (let s = 0; s < S; s++) {
      idx[io++] = w0 + s; idx[io++] = w1 + s; idx[io++] = w0 + s + 1;
      idx[io++] = w0 + s + 1; idx[io++] = w1 + s; idx[io++] = w1 + s + 1;
      idx[io++] = r0 + s; idx[io++] = r1 + s; idx[io++] = r0 + s + 1;
      idx[io++] = r0 + s + 1; idx[io++] = r1 + s; idx[io++] = r1 + s + 1;
    }
    base += perNode;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.MeshLambertMaterial({
    color: 0x8b96a3, transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}

export function createDrainageViz(engine, geom, { vexag = DEFAULT_VEXAG, waterRef = 0 } = {}) {
  const { THREE, scene, toLocal } = engine;
  const { nodeLon, nodeLat, nodeMax, linkFrom, linkTo, linkPeak, linkClass, nodeClass } = geom;
  const nn = nodeLon.length, nl = linkFrom.length;

  // ── THE WATER-LEVEL REFERENCE ───────────────────────────────────────────────
  // Metres of water that read as a full bore. Deliberately NOT the surface
  // flood's colour scale: that one grows as the event deepens, so the pipes
  // would visibly re-level every time the surface found a new maximum. Instead
  // it is the network's own MEDIAN node depth (drain_node_max_depth_m, ~1.5 m
  // here) — a constant of this drainage system, so the levels are comparable
  // across every hour and every dataset: water standing deeper than a typical
  // manhole is deep enough to have that conduit running full.
  if (!(waterRef > 0)) {
    const s = Float32Array.from(nodeMax).sort();
    waterRef = Math.max(0.5, s[s.length >> 1] || 1.5);
  }

  const nx = new Float32Array(nn), nz = new Float32Array(nn), ny = new Float32Array(nn);
  for (let i = 0; i < nn; i++) {
    const p = toLocal(nodeLon[i], nodeLat[i]);
    nx[i] = p.x; nz[i] = p.z;
    ny[i] = -Math.min(Math.max(nodeMax[i], 0.3), 12) * vexag;
  }

  // Every link is built — connectivity is the whole point of a network view.
  const keep = new Array(nl);
  for (let i = 0; i < nl; i++) keep[i] = i;
  const slotOf = new Map();
  for (let k = 0; k < keep.length; k++) slotOf.set(keep[k], k);
  const chains = traceChains(keep, linkFrom, linkTo);

  const deg = new Int32Array(nn);
  for (let k = 0; k < keep.length; k++) { deg[linkFrom[keep[k]]]++; deg[linkTo[keep[k]]]++; }

  // ── Path pre-pass ─────────────────────────────────────────────────────────
  // Two shape fixes before any geometry is emitted:
  //
  //  DECIMATION — drainage runs follow streets, so most interior nodes continue
  //  almost straight. A ring at each of them is pure cost. Drop any interior
  //  node whose turn is under COLLINEAR_COS and that does not change conduit
  //  (a slot change carries different flow, so it must keep its ring).
  //
  //  JUNCTION PULL-BACK — where 3+ conduits meet, every tube ran to the same
  //  centre point and they interpenetrated into an opaque knot. Stopping each
  //  pipe just short of the junction leaves the manhole shaft (already drawn at
  //  deg >= 3) to read as the joint, which is what it physically is.
  const COLLINEAR_COS = Math.cos(7 * Math.PI / 180);
  const paths = [];
  let nRings = 0, nRibV = 0, nRibQ = 0;
  for (const c of chains) {
    const pts = c.nodes, slots = c.slots, np = pts.length;
    const xs = [], ys = [], zs = [], nds = [], sls = [];
    for (let i = 0; i < np; i++) {
      const n = pts[i];
      xs.push(nx[n]); ys.push(ny[n]); zs.push(nz[n]); nds.push(n);
      sls.push(slotOf.get(keep[slots[Math.min(i, slots.length - 1)]]));
    }
    // pull the end points back toward their neighbour
    const trim = (i, j) => {
      const dx = xs[j] - xs[i], dy = ys[j] - ys[i], dz = zs[j] - zs[i];
      const L = Math.hypot(dx, dy, dz);
      if (L < 1e-4) return;
      const back = Math.min(1.5, L * 0.34);
      xs[i] += (dx / L) * back; ys[i] += (dy / L) * back; zs[i] += (dz / L) * back;
    };
    if (xs.length > 1) {
      if (deg[nds[0]] >= 3) trim(0, 1);
      if (deg[nds[xs.length - 1]] >= 3) trim(xs.length - 1, xs.length - 2);
    }
    // collinear decimation
    const kx = [xs[0]], ky = [ys[0]], kz = [zs[0]], kn = [nds[0]], ks = [sls[0]];
    for (let i = 1; i < xs.length - 1; i++) {
      const ax = xs[i] - kx[kx.length - 1], ay = ys[i] - ky[ky.length - 1], az = zs[i] - kz[kz.length - 1];
      const bx = xs[i + 1] - xs[i], by = ys[i + 1] - ys[i], bz = zs[i + 1] - zs[i];
      const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
      const straight = la > 1e-5 && lb > 1e-5 &&
        (ax * bx + ay * by + az * bz) / (la * lb) > COLLINEAR_COS;
      // Geometry-only test. Keying it on the slot as well made this a no-op —
      // each node in a chain belongs to a different link, so the slots never
      // matched. A dropped ring hands its span to the surviving ring's conduit,
      // which is exactly what any polyline simplification does.
      if (straight) continue;
      kx.push(xs[i]); ky.push(ys[i]); kz.push(zs[i]); kn.push(nds[i]); ks.push(sls[i]);
    }
    if (xs.length > 1) {
      const l = xs.length - 1;
      kx.push(xs[l]); ky.push(ys[l]); kz.push(zs[l]); kn.push(nds[l]); ks.push(sls[l]);
    }
    paths.push({ xs: kx, ys: ky, zs: kz, nds: kn, sls: ks, slots });
    nRings += kx.length; nRibV += kx.length * 2; nRibQ += kx.length - 1;
  }
  // ── Per-chain radius, and the radius SHARED by every conduit at a node ──────
  // The bore is cosmetic (flow-derived), so if each pipe raised its own water by
  // its own radius, two conduits at one manhole would disagree about where the
  // water surface is. Every conduit at a node raises water through nrad — the
  // widest bore meeting there — so they agree; a thinner one clips at its crown.
  const chainRad = new Float32Array(chains.length);
  const nrad = new Float32Array(nn);
  for (let ci = 0; ci < chains.length; ci++) {
    let qmax = 0;
    for (const s of chains[ci].slots) qmax = Math.max(qmax, linkPeak[keep[s]]);
    const rad = Math.min(R_MAX, R_MIN + Math.log10(1 + qmax * 12) * 1.7);
    chainRad[ci] = rad;
    for (const n of paths[ci].nds) if (rad > nrad[n]) nrad[n] = rad;
  }
  for (let n = 0; n < nn; n++) if (nrad[n] === 0) nrad[n] = R_MIN;

  const Rp = R + 1, V = nRings * Rp;

  const pos = new Float32Array(V * 3), nrm = new Float32Array(V * 3), aTier = new Uint8Array(V);
  const aClass = new Uint8Array(V);
  // cWat / rWat hold WATER DEPTH IN METRES (not a fill fraction — see rule 4).
  const cU = new Float32Array(V), cWat = new Float32Array(V), cWatPrev = new Float32Array(V);
  const cFlow = new Float32Array(V);
  const cRad = new Float32Array(V), cNRad = new Float32Array(V);
  const cNode = new Uint32Array(V), cSlot = new Uint32Array(V);
  let quads = 0;
  for (const pa of paths) quads += (pa.xs.length - 1) * R;
  const idx = new Uint32Array(quads * 6);

  const rpos = new Float32Array(nRibV * 3), rperp = new Float32Array(nRibV * 3), rside = new Float32Array(nRibV);
  const rcy = new Float32Array(nRibV), rrad = new Float32Array(nRibV), rU = new Float32Array(nRibV);
  const rnrad = new Float32Array(nRibV);
  const rWat = new Float32Array(nRibV), rWatPrev = new Float32Array(nRibV), rFlow = new Float32Array(nRibV);
  const rTier = new Uint8Array(nRibV);
  const rClass = new Uint8Array(nRibV);
  const rNode = new Uint32Array(nRibV), rSlot = new Uint32Array(nRibV);
  const ridx = new Uint32Array(nRibQ * 6);

  const cosA = new Float32Array(Rp), sinA = new Float32Array(Rp);
  for (let r = 0; r <= R; r++) { const t = (r / R) * Math.PI * 2; cosA[r] = Math.cos(t); sinA[r] = Math.sin(t); }
  const up = new THREE.Vector3(0, 1, 0);
  const P = new THREE.Vector3(), Pn = new THREE.Vector3(), T = new THREE.Vector3();
  const Nrm = new THREE.Vector3(), Bi = new THREE.Vector3(), prevT = new THREE.Vector3(), tmp = new THREE.Vector3();
  // Scratch vectors for the ring loop. Every allocation in here happens ~193,000
  // times, and the GC pressure from that was a measurable slice of the build.
  const scratch = new THREE.Vector3(), axisX = new THREE.Vector3(1, 0, 0);
  let vo = 0, io = 0, vi = 0, rv = 0, rq = 0;
  const tierCount = [0, 0, 0];
  const classCount = [0, 0, 0];

  for (let ci = 0; ci < chains.length; ci++) {
    const c = chains[ci], pa = paths[ci];
    const slots = c.slots;
    const px = pa.xs, py = pa.ys, pz = pa.zs, pnd = pa.nds, psl = pa.sls;
    const np = px.length;
    let qmax = 0;
    for (const s of slots) qmax = Math.max(qmax, linkPeak[keep[s]]);
    const rad = chainRad[ci];
    const tier = tierOf(qmax);
    // ny[] is the node INVERT. Lift the tube by its own radius so the invert is
    // the pipe's floor, not its centreline — otherwise half of every conduit sat
    // below its own invert and conduits of different bore met at a manhole with
    // their floors at different heights.
    for (let p = 0; p < py.length; p++) py[p] += rad;
    tierCount[tier] += slots.length;
    // A chain's class is the majority of its links. Chains are traced through
    // degree-2 nodes, so they rarely straddle storm and sewer; where they do,
    // the majority is the honest label.
    let cVotes = [0, 0, 0];
    for (const sl of slots) cVotes[linkClass ? linkClass[keep[sl]] : 2]++;
    const cls = cVotes[0] >= cVotes[1] && cVotes[0] >= cVotes[2] ? 0 : (cVotes[1] >= cVotes[2] ? 1 : 2);
    classCount[cls] += slots.length;
    let haveFrame = false, cum = 0;
    const ringStart = [], ribStart = [];
    for (let p = 0; p < np; p++) {
      const n0 = pnd[p];
      P.set(px[p], py[p], pz[p]);
      if (p < np - 1) { Pn.set(px[p + 1], py[p + 1], pz[p + 1]); T.subVectors(Pn, P); }
      else { Pn.set(px[p - 1], py[p - 1], pz[p - 1]); T.subVectors(P, Pn); }
      if (T.lengthSq() < 1e-10) T.set(1, 0, 0);
      T.normalize();
      // Parallel-transport frame: rotate the previous ring normal by the tangent
      // change instead of rebuilding a basis, or the tube twists at every node.
      if (!haveFrame) {
        Nrm.crossVectors(Math.abs(T.y) > 0.9 ? axisX : up, T).normalize();
        Bi.crossVectors(T, Nrm).normalize();
        haveFrame = true;
      } else {
        tmp.crossVectors(prevT, T);
        const sn = tmp.length(), cth = prevT.dot(T);
        if (sn > 1e-6) { tmp.multiplyScalar(1 / sn); Nrm.applyAxisAngle(tmp, Math.atan2(sn, cth)); }
        Nrm.sub(scratch.copy(T).multiplyScalar(Nrm.dot(T))).normalize();
        Bi.crossVectors(T, Nrm).normalize();
      }
      prevT.copy(T);
      if (p > 0) cum += P.distanceTo(tmp.set(px[p - 1], py[p - 1], pz[p - 1]));
      const slot = psl[p];

      ringStart.push(vi);
      for (let r = 0; r <= R; r++) {
        const ox = Nrm.x * cosA[r] * rad + Bi.x * sinA[r] * rad;
        const oy = Nrm.y * cosA[r] * rad + Bi.y * sinA[r] * rad;
        const oz = Nrm.z * cosA[r] * rad + Bi.z * sinA[r] * rad;
        pos[vo] = P.x + ox; pos[vo + 1] = P.y + oy; pos[vo + 2] = P.z + oz;
        const il = 1 / (Math.hypot(ox, oy, oz) || 1);
        nrm[vo] = ox * il; nrm[vo + 1] = oy * il; nrm[vo + 2] = oz * il;
        aTier[vi] = tier; aClass[vi] = cls; cNode[vi] = n0; cSlot[vi] = slot; cU[vi] = cum;
        cRad[vi] = rad; cNRad[vi] = nrad[n0];
        vo += 3; vi++;
      }
      const perpX = -T.z, perpZ = T.x, pl = Math.hypot(perpX, perpZ) || 1;
      ribStart.push(rv);
      for (let side = 0; side < 2; side++) {
        rpos[rv * 3] = P.x; rpos[rv * 3 + 1] = 0; rpos[rv * 3 + 2] = P.z;
        rperp[rv * 3] = perpX / pl; rperp[rv * 3 + 1] = 0; rperp[rv * 3 + 2] = perpZ / pl;
        rside[rv] = side ? 1 : -1;
        rcy[rv] = P.y; rrad[rv] = rad; rnrad[rv] = nrad[n0]; rU[rv] = cum;
        rTier[rv] = tier; rClass[rv] = cls; rNode[rv] = n0; rSlot[rv] = slot;
        rv++;
      }
    }
    for (let p = 0; p < np - 1; p++) {
      const s0 = ringStart[p], s1 = ringStart[p + 1];
      for (let r = 0; r < R; r++) {
        const a0 = s0 + r, a1 = s0 + r + 1, b0 = s1 + r, b1 = s1 + r + 1;
        idx[io++] = a0; idx[io++] = b0; idx[io++] = a1;
        idx[io++] = a1; idx[io++] = b0; idx[io++] = b1;
      }
      const q0 = ribStart[p], q1 = ribStart[p + 1];
      ridx[rq++] = q0; ridx[rq++] = q1; ridx[rq++] = q0 + 1;
      ridx[rq++] = q0 + 1; ridx[rq++] = q1; ridx[rq++] = q1 + 1;
    }
  }

  // ── casing + water-body share ONE geometry (dispose it once, or double-free)
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  cg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  cg.setAttribute('aTier', new THREE.BufferAttribute(aTier, 1));
  cg.setAttribute('aClass', new THREE.BufferAttribute(aClass, 1));
  cg.setAttribute('aU', new THREE.BufferAttribute(cU, 1));
  cg.setAttribute('aRad', new THREE.BufferAttribute(cRad, 1));
  cg.setAttribute('aNRad', new THREE.BufferAttribute(cNRad, 1));
  const cWatAttr = new THREE.BufferAttribute(cWat, 1);
  const cWatPrevAttr = new THREE.BufferAttribute(cWatPrev, 1);
  const cFlowAttr = new THREE.BufferAttribute(cFlow, 1);
  cg.setAttribute('aWaterM', cWatAttr);
  cg.setAttribute('aWaterMPrev', cWatPrevAttr);
  cg.setAttribute('aFlow', cFlowAttr);
  cg.setIndex(new THREE.BufferAttribute(idx, 1));

  const tierOn = { value: [1, 1, 1] };
  const classOn = { value: [1, 1, 1] };
  const caseMat = new THREE.ShaderMaterial({
    uniforms: {
      uMode: { value: 0 }, uTime: { value: 0 }, uMix: { value: 1 }, uTierOn: tierOn,
      uTierCol: { value: TIERS.map((t) => new THREE.Vector3(...t.color)) },
      uClassOn: classOn,
      uClassCol: { value: CLASSES.map((c) => new THREE.Vector3(...c.color)) },
      uClassTint: { value: 0.72 },
      uWaterRef: { value: waterRef },
    },
    vertexShader: CASE_VERT, fragmentShader: CASE_FRAG,
    transparent: true, depthWrite: false, side: THREE.FrontSide,
  });
  const caseMesh = new THREE.Mesh(cg, caseMat);
  caseMesh.frustumCulled = false; caseMesh.renderOrder = 2; scene.add(caseMesh);

  const wvolMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uMix: { value: 1 }, uTierOn: tierOn, uClassOn: classOn,
      uWaterRef: { value: waterRef }, ...rampUniforms(THREE),
    },
    vertexShader: WVOL_VERT, fragmentShader: WVOL_FRAG,
    transparent: false, depthWrite: true, side: THREE.DoubleSide,
    extensions: { derivatives: true },
  });
  const wvolMesh = new THREE.Mesh(cg, wvolMat);
  wvolMesh.frustumCulled = false; wvolMesh.renderOrder = 1; scene.add(wvolMesh);

  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
  wg.setAttribute('aPerp', new THREE.BufferAttribute(rperp, 3));
  wg.setAttribute('aSide', new THREE.BufferAttribute(rside, 1));
  wg.setAttribute('aCenterY', new THREE.BufferAttribute(rcy, 1));
  wg.setAttribute('aRad', new THREE.BufferAttribute(rrad, 1));
  wg.setAttribute('aNRad', new THREE.BufferAttribute(rnrad, 1));
  wg.setAttribute('aU', new THREE.BufferAttribute(rU, 1));
  const rWatAttr = new THREE.BufferAttribute(rWat, 1);
  const rWatPrevAttr = new THREE.BufferAttribute(rWatPrev, 1);
  const rFlowAttr = new THREE.BufferAttribute(rFlow, 1);
  wg.setAttribute('aWaterM', rWatAttr);
  wg.setAttribute('aWaterMPrev', rWatPrevAttr);
  wg.setAttribute('aFlow', rFlowAttr);
  wg.setAttribute('aTier', new THREE.BufferAttribute(rTier, 1));
  wg.setAttribute('aClass', new THREE.BufferAttribute(rClass, 1));
  wg.setIndex(new THREE.BufferAttribute(ridx, 1));

  const watMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uMix: { value: 1 }, uTierOn: tierOn, uClassOn: classOn,
      uWaterRef: { value: waterRef }, ...rampUniforms(THREE),
    },
    vertexShader: WAT_VERT, fragmentShader: WAT_FRAG,
    transparent: false, depthWrite: true, side: THREE.DoubleSide,
    extensions: { derivatives: true },
  });
  const watMesh = new THREE.Mesh(wg, watMat);
  watMesh.frustumCulled = false; watMesh.renderOrder = 3; scene.add(watMesh);

  // Shafts at junctions only (deg ≥ 3) — every node would be a forest of poles.
  const junc = [];
  const SHAFT_MIN_DEPTH = 1.2;   // metres of real burial before a shaft is worth drawing
  for (let n = 0; n < nn; n++) if (deg[n] >= 3 && nodeMax[n] >= SHAFT_MIN_DEPTH) junc.push(n);
  const shaftMesh = buildShafts(THREE, junc, nx, ny, nz);
  if (shaftMesh) { shaftMesh.renderOrder = 1; scene.add(shaftMesh); }

  // ── water column inside every shaft ──
  const SW = 6, swr = 0.20;                    // slightly inside the 0.26 casing
  const swPerNode = (SW + 1) * 2;
  const swV = junc.length * swPerNode;
  const swPos = new Float32Array(swV * 3);
  const swRise = new Float32Array(swV), swRisePrev = new Float32Array(swV);
  const swSurch = new Float32Array(swV), swBaseY = new Float32Array(swV);
  const swNode = new Uint32Array(swV);
  const swIdx = new Uint32Array(junc.length * SW * 6);
  {
    const cs = new Float32Array(SW + 1), sn = new Float32Array(SW + 1);
    for (let i = 0; i <= SW; i++) { const t = (i / SW) * Math.PI * 2; cs[i] = Math.cos(t); sn[i] = Math.sin(t); }
    let vo = 0, io = 0, base = 0;
    for (const n of junc) {
      const x = nx[n], z = nz[n], yb = ny[n] + 0.05;
      for (let e = 0; e < 2; e++) {
        for (let i = 0; i <= SW; i++) {
          swPos[vo * 3] = x + cs[i] * swr;
          swPos[vo * 3 + 1] = e ? 0.0 : yb;      // top ring is moved by the shader
          swPos[vo * 3 + 2] = z + sn[i] * swr;
          swBaseY[vo] = yb; swNode[vo] = n;
          vo++;
        }
      }
      const w0 = base, w1 = base + (SW + 1);
      for (let i = 0; i < SW; i++) {
        swIdx[io++] = w0 + i; swIdx[io++] = w1 + i; swIdx[io++] = w0 + i + 1;
        swIdx[io++] = w0 + i + 1; swIdx[io++] = w1 + i; swIdx[io++] = w1 + i + 1;
      }
      base += swPerNode;
    }
  }
  const swGeo = new THREE.BufferGeometry();
  swGeo.setAttribute('position', new THREE.BufferAttribute(swPos, 3));
  const swRiseAttr = new THREE.BufferAttribute(swRise, 1);
  const swRisePrevAttr = new THREE.BufferAttribute(swRisePrev, 1);
  const swSurchAttr = new THREE.BufferAttribute(swSurch, 1);
  swGeo.setAttribute('aRise', swRiseAttr);
  swGeo.setAttribute('aRisePrev', swRisePrevAttr);
  swGeo.setAttribute('aSurch', swSurchAttr);
  swGeo.setAttribute('aBaseY', new THREE.BufferAttribute(swBaseY, 1));
  swGeo.setIndex(new THREE.BufferAttribute(swIdx, 1));
  const shaftWaterMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uMix: { value: 1 } },
    vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const shaftWaterMesh = new THREE.Mesh(swGeo, shaftWaterMat);
  shaftWaterMesh.frustumCulled = false;
  shaftWaterMesh.renderOrder = 2;
  scene.add(shaftWaterMesh);

  // ── live state
  const nwat = new Float32Array(nn);    // solved water depth, METRES above invert
  const nfill = new Float32Array(nn);   // that depth ÷ the node's own invert→rim span
  const lflow = new Float32Array(keep.length);
  const layerOn = { casing: true, water: true, shafts: true };
  const tierManual = [null, null, null];   // null = follow zoom, true/false = pinned
  let visible = false, mix = 1, mode = 'water', zoom = 12.6;

  function applyVis() {
    caseMesh.visible = visible && layerOn.casing;
    const cap = mode === 'capacity';
    wvolMesh.visible = visible && layerOn.water && !cap;
    watMesh.visible = visible && layerOn.water && !cap;
    if (shaftMesh) shaftMesh.visible = visible && layerOn.shafts;
    if (shaftWaterMesh) shaftWaterMesh.visible = visible && layerOn.shafts && layerOn.water;
  }
  function applyTiers() {
    for (let i = 0; i < 3; i++) {
      const auto = zoom >= ZOOM_TIER_GATE[i];
      tierOn.value[i] = (tierManual[i] === null ? auto : tierManual[i]) ? 1 : 0;
    }
    engine.triggerRepaint();
  }
  applyTiers();
  applyVis();

  const tick = (clock) => {
    caseMat.uniforms.uTime.value = clock;
    watMat.uniforms.uTime.value = clock;
    wvolMat.uniforms.uTime.value = clock;
    shaftWaterMat.uniforms.uTime.value = clock;
    if (mix < 1) {
      mix = Math.min(1, mix + 0.035);
      caseMat.uniforms.uMix.value = mix;
      watMat.uniforms.uMix.value = mix;
      wvolMat.uniforms.uMix.value = mix;
      shaftWaterMat.uniforms.uMix.value = mix;
    }
  };
  engine.tickers.add(tick);

  return {
    meshes: [caseMesh, wvolMesh, watMesh, shaftMesh, shaftWaterMesh].filter(Boolean),
    tierCount,
    classCount,
    shafts: junc.length,
    chains: chains.length,
    links: keep.length,

    /**
     * Paint from an hour's solved record. Double-buffers fill/depth so the
     * render loop can ease uMix 0→1 and interpolate the water level between
     * timesteps entirely on the GPU.
     */
    updateHour(rec, nodeMaxArr, depthScale, flowScale) {
      const ds = depthScale || 1000, fs = flowScale || 100;
      const depth = rec.depth, flow = rec.flow;
      for (let k = 0; k < keep.length; k++) lflow[k] = Math.max(-1, Math.min(1, flow[keep[k]] / fs / 2.0));
      for (let n = 0; n < nn; n++) {
        // The solver's node depth IS metres of water standing above that node's
        // invert (volume ÷ storage area). The pipes are levelled off the metres;
        // only the manhole columns — whose span really is invert→rim — use the
        // fraction of the node's own max depth.
        const m = depth[n] / ds;
        nwat[n] = m;
        nfill[n] = Math.min(1, m / Math.max(nodeMaxArr[n], 0.1));
      }
      rWatPrev.set(rWat); cWatPrev.set(cWat);
      for (let v = 0; v < rNode.length; v++) { rWat[v] = nwat[rNode[v]]; rFlow[v] = lflow[rSlot[v]]; }
      for (let v = 0; v < cNode.length; v++) { cWat[v] = nwat[cNode[v]]; cFlow[v] = lflow[cSlot[v]]; }
      cWatAttr.needsUpdate = cWatPrevAttr.needsUpdate = cFlowAttr.needsUpdate = true;
      rWatAttr.needsUpdate = rWatPrevAttr.needsUpdate = rFlowAttr.needsUpdate = true;
      // manhole columns: rise to the node's own fill, flagged when surcharging
      swRisePrev.set(swRise);
      const sur = rec.sur;
      for (let v = 0; v < swNode.length; v++) {
        const n = swNode[v];
        swRise[v] = nfill[n];
        swSurch[v] = (sur[n >> 3] & (1 << (n & 7))) ? 1 : 0;
      }
      swRiseAttr.needsUpdate = swRisePrevAttr.needsUpdate = swSurchAttr.needsUpdate = true;

      mix = 0;
      shaftWaterMat.uniforms.uMix.value = 0;
      caseMat.uniforms.uMix.value = 0;
      watMat.uniforms.uMix.value = 0;
      wvolMat.uniforms.uMix.value = 0;
    },

    setVisible(on) { visible = on; applyVis(); engine.triggerRepaint(); },
    setMode(m) {
      mode = m;
      caseMat.uniforms.uMode.value = m === 'capacity' ? 1 : 0;
      caseMat.depthWrite = m === 'capacity';
      caseMat.needsUpdate = true;
      applyVis();
      engine.triggerRepaint();
    },
    setLayer(name, on) { if (name in layerOn) { layerOn[name] = !!on; applyVis(); engine.triggerRepaint(); } },
    /** on === null hands the tier back to the automatic zoom gate. */
    setTier(i, on) { if (i >= 0 && i < 3) { tierManual[i] = on; applyTiers(); } },
    /** Show/hide a conduit CLASS (0 storm, 1 sewer, 2 unclassified). */
    setClass(i, on) { if (i >= 0 && i < 3) { classOn.value[i] = on ? 1 : 0; engine.triggerRepaint(); } },
    tierAuto(i) { return tierManual[i] === null; },
    tierVisible(i) { return tierOn.value[i] > 0.5; },
    setZoom(z) { if (Math.abs(z - zoom) > 0.05) { zoom = z; applyTiers(); } },
    /** The surface flood's colour scale. Intentionally NOT wired to the pipes —
     *  it drifts upward during an event and would re-level the whole network
     *  mid-playback. The underground keeps its own fixed reference; see
     *  setWaterRef. Kept so callers can go on calling it uniformly. */
    setMaxDepth() {},
    /** Metres of water that read as a full bore (default: median node depth). */
    setWaterRef(m) {
      if (!(m > 0)) return;
      wvolMat.uniforms.uWaterRef.value = m;
      watMat.uniforms.uWaterRef.value = m;
      caseMat.uniforms.uWaterRef.value = m;
      engine.triggerRepaint();
    },
    waterRef,
    nodeXYZ: { nx, ny, nz },
    dispose() {
      engine.tickers.delete(tick);
      for (const m of [caseMesh, wvolMesh, watMesh, shaftMesh, shaftWaterMesh]) {
        if (!m) continue;
        m.parent?.remove(m);
        m.material.dispose();
      }
      cg.dispose(); wg.dispose();
      shaftMesh?.geometry.dispose();
      swGeo.dispose();
    },
  };
}
