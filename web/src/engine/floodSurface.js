/* ─────────────────────────────────────────────────────────────────────────────
 * floodSurface.js — the 2-D flood sheet.
 *
 * A plane over the run's grid bbox, displaced and coloured from that frame's
 * 768² depth grid. Colour comes from the shared zoom.earth ramp LUT (palette.js)
 * so the propagation is a continuous gradient rather than five hand-mixed
 * smoothsteps with visible seams at the band edges.
 *
 * The fragment shader is the app's single biggest per-pixel cost (it covers most
 * of the viewport), so the fbm octave count and the number of fbm evaluations
 * are deliberately minimal — screen-space derivatives give the gradients that
 * would otherwise need two extra taps each.
 * ─────────────────────────────────────────────────────────────────────────── */
import { GLSL_RAMP, rampUniforms } from './palette.js';

const PLANE_SEG = 192;

const VERT = `
uniform float uTime;
uniform sampler2D uDepthTex;
uniform float uWaveAmp;
uniform float uDepthHeight;
uniform vec3 uRipple0, uRipple1, uRipple2, uRipple3;
varying float vDepth;
varying vec2 vUv;
varying vec3 vWP;

float rippleDisplace(vec3 rip, vec3 p, float t){
  if(rip.z < 0.0) return 0.0;
  float age = t - rip.z;
  if(age < 0.0 || age > 2.2) return 0.0;
  float dist = length(vec2(p.x - rip.x, p.z - rip.y));
  float wavefront = age * 18.0;
  float falloff = exp(-dist * 0.012) * exp(-age * 1.8);
  float wave = sin((dist - wavefront) * 0.55) * falloff * 0.6;
  return wave * smoothstep(0.0, 0.4, age) * (1.0 - smoothstep(1.8, 2.2, age));
}

void main(){
  vUv = uv;
  float depth = texture2D(uDepthTex, uv).r;
  vDepth = depth;
  float df = smoothstep(0.0, 0.25, depth);
  vec3 p = position;
  float w = sin(p.x*0.55 + uTime*0.85) * cos(p.z*0.60 + uTime*0.60)
          + 0.55*sin((p.x*0.90 - p.z*0.70)*0.85 + uTime*0.72);
  float rip = rippleDisplace(uRipple0, p, uTime) + rippleDisplace(uRipple1, p, uTime)
            + rippleDisplace(uRipple2, p, uTime) + rippleDisplace(uRipple3, p, uTime);
  // Volumetric lift: deeper water sits higher. Bob is faded out in the shallows
  // via df so the wet edge doesn't shimmer.
  p.y = depth * uDepthHeight + (w * uWaveAmp + rip) * df;
  vWP = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = `
precision highp float;
uniform float uTime;
uniform float uOpacity;
uniform float uMaxDepth;
uniform sampler2D uDepthTex;
uniform vec2 uTexelSize;
uniform float uBlur;        // blur radius in texels — widens as you zoom out
uniform float uWetMin;      // depth below which a cell is not drawn at all
uniform vec3 uRipple0, uRipple1, uRipple2, uRipple3;
uniform vec4 uBandOn;      // legend filter: 1 = that depth band is drawn
uniform vec3 uBandEdge;    // the three band boundaries, in metres
varying float vDepth;
varying vec2 vUv;
varying vec3 vWP;

${GLSL_RAMP}

float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),
             mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.5*noise(p);
  p = p*2.1 + vec2(1.7,9.2);
  return v + 0.25*noise(p);
}
// value + screen-space gradient from ONE evaluation instead of three
vec3 fbmG(vec2 p){ float v = fbm(p); return vec3(v, dFdx(v), dFdy(v)); }

// A 3x3 tent, with the tap spacing driven by uBlur.
//
// The wet/dry boundary is cell-level in the DATA - a 33 m grid - so at city zoom
// one texel is smaller than a pixel and the edge came out visibly blocky and
// patchy. Fixed-width taps cannot help there: they blur at texel scale, which is
// sub-pixel. Widening the kernel as you zoom OUT averages over the several cells
// collapsing into each pixel, which is what actually smooths the edge, and costs
// nothing extra at street zoom where uBlur is 1.
// Two rings, not one. A single 3x3 at a wide spacing under-samples: it reads 9
// scattered cells out of the ~25 collapsing into a pixel, so isolated wet cells
// survive as speckle instead of averaging away. The outer ring at 2x costs four
// taps and is what turns the coarse view into a continuous sheet.
float sampleSoft(vec2 c){
  vec2 o = uTexelSize * uBlur;
  vec2 o2 = o * 2.0;
  float s = texture2D(uDepthTex, c).r * 4.0;
  s += (texture2D(uDepthTex, c + vec2( o.x, 0.0)).r
      + texture2D(uDepthTex, c + vec2(-o.x, 0.0)).r
      + texture2D(uDepthTex, c + vec2( 0.0, o.y)).r
      + texture2D(uDepthTex, c + vec2( 0.0,-o.y)).r) * 2.0;
  s += texture2D(uDepthTex, c + o).r
     + texture2D(uDepthTex, c - o).r
     + texture2D(uDepthTex, c + vec2( o.x,-o.y)).r
     + texture2D(uDepthTex, c + vec2(-o.x, o.y)).r;
  float outer = texture2D(uDepthTex, c + vec2( o2.x, 0.0)).r
              + texture2D(uDepthTex, c + vec2(-o2.x, 0.0)).r
              + texture2D(uDepthTex, c + vec2( 0.0, o2.y)).r
              + texture2D(uDepthTex, c + vec2( 0.0,-o2.y)).r;
  return (s + outer) * 0.05;
}

void main(){
  float depth = sampleSoft(vUv);
  // Wider than the old 0.02->0.22: a narrow ramp turns the blur back into a hard
  // contour, which is the patchiness it was meant to remove.
  float alphaMask = smoothstep(uWetMin, uWetMin + 0.30, depth);
  if(alphaMask <= 0.004) discard;

  // Legend-as-filter: hide whole depth bands without touching any other feature.
  float band = depth < uBandEdge.x ? uBandOn.x
             : depth < uBandEdge.y ? uBandOn.y
             : depth < uBandEdge.z ? uBandOn.z : uBandOn.w;
  if(band < 0.5) discard;

  vec3 base = floodRamp(depth, uMaxDepth);
  float d = clamp(depth / max(uMaxDepth, 0.05), 0.0, 1.0);

  float dL = sampleSoft(vUv - vec2(uTexelSize.x, 0.0));
  float dR = sampleSoft(vUv + vec2(uTexelSize.x, 0.0));
  float dDn = sampleSoft(vUv - vec2(0.0, uTexelSize.y));
  float dUp = sampleSoft(vUv + vec2(0.0, uTexelSize.y));
  vec3 N = normalize(vec3(-(dR - dL)*2.2, 1.0, -(dUp - dDn)*2.2));

  float t = uTime * 0.09;
  vec2 wv1 = vUv*220.0 + vec2( t*1.6,  t*1.2);
  vec2 wv2 = vUv*340.0 + vec2(-t*1.1,  t*0.9);
  vec3 gA = fbmG(wv1), gB = fbmG(wv2);
  float nA = gA.x, nB = gB.x;
  vec3 bumpN = normalize(vec3(-(gA.y + gB.y)*90.0, 1.0, -(gA.z + gB.z)*90.0));
  N = normalize(mix(N, bumpN, 0.55));

  vec3 V = vec3(0.0, 1.0, 0.0);
  vec3 L = normalize(vec3(0.45, 0.90, 0.30));
  vec3 H = normalize(L + V);
  float F = pow(1.0 - max(dot(N, V), 0.0), 5.0);
  float spec = pow(max(dot(N, H), 0.0), 96.0);
  float diff = max(dot(N, L), 0.0) * 0.6 + 0.4;

  vec3 col = base * diff;
  // Keep the tint of the ramp in the Fresnel wash instead of washing to white —
  // a neutral highlight desaturates the palette exactly where it is most
  // saturated, and the sheet stops reading as one continuous scale.
  col = mix(col, mix(base, vec3(0.95,0.98,1.0), 0.65), F * 0.16);
  col += vec3(1.0, 0.98, 0.92) * spec * 0.20;

  float caustic = pow(clamp(1.0 - abs(nA - nB), 0.0, 1.0), 8.0);
  col += vec3(0.6, 0.9, 1.0) * caustic * 0.07 * (1.0 - d);

  float ripHighlight = 0.0;
  for(int ri=0; ri<4; ri++){
    vec3 rip = (ri==0)?uRipple0:(ri==1)?uRipple1:(ri==2)?uRipple2:uRipple3;
    if(rip.z < 0.0) continue;
    float age = uTime - rip.z;
    if(age < 0.0 || age > 2.2) continue;
    float dist = length(vec2(vWP.x - rip.x, vWP.z - rip.y));
    float ring = exp(-pow(dist - age*18.0, 2.0) * 0.08) * exp(-age * 1.4) * 0.55;
    ripHighlight += ring;
  }
  col += vec3(0.75, 0.95, 1.0) * ripHighlight;

  gl_FragColor = vec4(col, uOpacity * alphaMask);
}`;

export function createFloodSurface(engine, sim) {
  const { THREE, scene, toLocal } = engine;
  const man = sim.state.man;
  const N = man.grid_n, bb = man.grid_bbox;

  const seg = PLANE_SEG, n = (seg + 1) * (seg + 1);
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let vi = 0, ui = 0;
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const p = toLocal(bb[0] + (i / seg) * (bb[2] - bb[0]), bb[1] + (j / seg) * (bb[3] - bb[1]));
      pos[vi++] = p.x; pos[vi++] = 0; pos[vi++] = p.z;
      uv[ui++] = i / seg; uv[ui++] = j / seg;
    }
  }
  const idx = new Uint32Array(seg * seg * 6);
  let k = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + (seg + 1), d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  if (!sim.state.grid || sim.state.grid.length !== N * N) sim.state.grid = new Float32Array(N * N);
  const tex = new THREE.DataTexture(sim.state.grid, N, N, THREE.LuminanceFormat, THREE.FloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0.78 },
      uMaxDepth: { value: sim.maxDepthScale },
      uDepthTex: { value: tex },
      uTexelSize: { value: new THREE.Vector2(1 / N, 1 / N) },
      uBlur: { value: 1.0 },
      uWetMin: { value: 0.010 },
      uWaveAmp: { value: 0.18 },
      uDepthHeight: { value: 0.45 },
      uBandOn: { value: new THREE.Vector4(1, 1, 1, 1) },
      uBandEdge: { value: new THREE.Vector3(0.2, 0.6, 1.2) },
      uRipple0: { value: new THREE.Vector3(0, 0, -1) },
      uRipple1: { value: new THREE.Vector3(0, 0, -1) },
      uRipple2: { value: new THREE.Vector3(0, 0, -1) },
      uRipple3: { value: new THREE.Vector3(0, 0, -1) },
      ...rampUniforms(THREE),
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    extensions: { derivatives: true },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  scene.add(mesh);

  let ripIdx = 0;
  const tick = (clock) => { mat.uniforms.uTime.value = clock; };
  engine.tickers.add(tick);

  return {
    mesh, mat, tex,
    setVisible(on) { mesh.visible = on; engine.triggerRepaint(); },
    setOpacity(v) { mat.uniforms.uOpacity.value = v; engine.triggerRepaint(); },
    /** Widen the depth blur as the camera pulls back (see sampleSoft). */
    setZoom(z) {
      const b = z >= 16 ? 1.0 : z >= 14 ? 1.5 : z >= 12.5 ? 2.2 : z >= 11 ? 3.0 : 4.0;
      const w = z >= 15 ? 0.010 : z >= 13 ? 0.022 : z >= 11.5 ? 0.038 : 0.055;
      if (Math.abs(b - mat.uniforms.uBlur.value) > 0.01
       || Math.abs(w - mat.uniforms.uWetMin.value) > 1e-4) {
        mat.uniforms.uBlur.value = b;
        mat.uniforms.uWetMin.value = w;
        engine.triggerRepaint();
      }
    },
    /** Refresh the texture after sim.useFrame() has rewritten the grid. */
    refresh() {
      tex.needsUpdate = true;
      mat.uniforms.uMaxDepth.value = sim.maxDepthScale;
      engine.triggerRepaint();
    },
    /** Legend filter — bands are [on,on,on,on] with edges in metres. */
    setBands(on, edges) {
      mat.uniforms.uBandOn.value.set(on[0] ? 1 : 0, on[1] ? 1 : 0, on[2] ? 1 : 0, on[3] ? 1 : 0);
      if (edges) mat.uniforms.uBandEdge.value.set(edges[0], edges[1], edges[2]);
      engine.triggerRepaint();
    },
    /** Splash ring where the user tapped the water. */
    ripple(lng, lat) {
      const p = toLocal(lng, lat);
      mat.uniforms[`uRipple${ripIdx}`].value.set(p.x, p.z, mat.uniforms.uTime.value);
      ripIdx = (ripIdx + 1) % 4;
      engine.triggerRepaint();
    },
    dispose() {
      engine.tickers.delete(tick);
      scene.remove(mesh);
      geo.dispose(); mat.dispose(); tex.dispose();
    },
  };
}
