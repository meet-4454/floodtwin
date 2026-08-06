/* ─────────────────────────────────────────────────────────────────────────────
 * drainage_viz.js — modular 3D storm-drain visualisation.
 *
 * Renders the drainage network as SOLID pipes (coloured by component tier) with a
 * real WATER SURFACE flowing INSIDE each pipe at the solved fill level — not a
 * tint smeared on the pipe wall. Two skins over one geometry:
 *   water     — glassy tier-coloured pipe + bright flowing inner water surface
 *   capacity  — solid pipe painted green→red by demand/capacity
 *
 *   window.DrainageViz.build(ctx, data) → handle{ meshes, updateHour, setMode,
 *                                                 setVisible, tick, stats, dispose }
 * ctx  = { THREE, scene, toLocal(lng,lat)->{x,z}, VEXAG, repaint() }
 * data = { nodeLon,nodeLat,nodeMax, linkFrom,linkTo,linkPeak, keep }
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const TIERS = [
    { key: 'trunk',   label: 'Trunk main',  min: 1.0,  color: [0.96, 0.49, 0.20] },
    { key: 'main',    label: 'Branch main', min: 0.25, color: [0.16, 0.55, 0.86] },
    { key: 'lateral', label: 'Lateral',     min: 0.0,  color: [0.28, 0.74, 0.82] },
  ];
  const tierOf = (q) => (q >= 1.0 ? 0 : q >= 0.25 ? 1 : 2);
  // Radial segments: the FULL 139,798-link network is drawn (connectivity), so
  // the per-ring cost is what gets traded down — 5 sides still reads as a round
  // pipe at these radii. ~192k rings × 6 verts ≈ 1.5M verts.
  const R = 5;
  const R_MIN = 0.7, R_MAX = 3.0;    // slim tubes — the network was too cluttered

  // ── PIPE CASING: a solid-reading tube in its tier colour, lit, with a faint
  // Fresnel rim so it reads as real 3-D pipework. In capacity mode it becomes a
  // green→red choropleth. It does NOT show the water (that's the inner surface).
  const CASE_VERT = `
    attribute float aTier; attribute float aFill; attribute float aFillPrev; attribute float aU;
    uniform vec3 uTierCol[3]; uniform float uTierOn[3]; uniform float uMix;
    varying vec3 vN; varying float vNy; varying vec3 vTC; varying float vFill; varying float vOn;
    void main(){ vN = normalize(normalMatrix*normal); vNy = normal.y;
      int t = int(aTier+0.5);
      vTC = uTierCol[t]; vOn = uTierOn[t];
      vFill = mix(aFillPrev, aFill, uMix);
      gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
  // The casing is now only a GHOST of the conduit — the water body (below) is the
  // opaque thing you read. Previously both were translucent and stacked, which is
  // what turned a dense network into an unreadable glow.
  const CASE_FRAG = `
    precision highp float;
    uniform float uMode, uTime;              // uMode 0 water / 1 capacity
    varying vec3 vN; varying float vNy; varying vec3 vTC; varying float vFill; varying float vOn;
    void main(){
      if(vOn < 0.5) discard;
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
      // Dry casing: a thin tier-coloured outline. Brightest at grazing angles so
      // the pipe reads as a hollow conduit edge rather than a filled slab.
      float fres = pow(1.0 - abs(dot(N, vec3(0.0,1.0,0.0))), 3.0);
      vec3 col = vTC*(0.55 + 0.45*nl) + fres*0.35;
      gl_FragColor = vec4(col, 0.10 + fres*0.16);
    }`;

  // ── WATER BODY: the submerged part of the pipe shell, rendered OPAQUE. A
  // fragment is underwater when its height in the circular section (radial
  // normal.y) sits below the level, so the water automatically takes the pipe's
  // circular-segment cross-section and grows to a full round bore as it fills.
  // Opaque + depthWrite means overlapping pipes occlude instead of stacking alpha.
  const WVOL_VERT = `
    attribute float aTier; attribute float aFill; attribute float aFillPrev; attribute float aU;
    uniform float uMix; uniform float uTierOn[3];
    varying float vNy; varying float vFill; varying float vU; varying float vOn; varying vec3 vN;
    void main(){
      vFill = mix(aFillPrev, aFill, uMix);
      vNy = normal.y; vU = aU;
      vOn = uTierOn[int(aTier+0.5)];
      vN = normalize(normalMatrix*normal);
      // sit just inside the casing so the two skins never z-fight
      vec3 p = position - normal*0.06;
      gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0);
    }`;
  const WVOL_FRAG = `
    precision highp float;
    uniform float uTime;
    varying float vNy; varying float vFill; varying float vU; varying float vOn; varying vec3 vN;
    void main(){
      if(vOn < 0.5) discard;
      float f = clamp(vFill,0.0,1.0);
      if(f < 0.02) discard;                 // empty pipe → only the ghost casing
      float level = 2.0*f - 1.0;
      if(vNy > level) discard;              // above the waterline = air
      vec3 N = normalize(vN);
      float nl = 0.55 + 0.45*max(dot(N, normalize(vec3(0.4,0.9,0.35))),0.0);
      // Colour must ramp MONOTONICALLY with fill — a fuller pipe has to look
      // unmistakably "more water". Driving the ramp off depth-below-surface
      // instead made a half-full pipe the brightest thing on screen and a full
      // one nearly black, which read backwards.
      vec3 col = mix(vec3(0.58,0.84,0.98), vec3(0.11,0.50,0.92), f);
      float depth = clamp((level - vNy)*0.5, 0.0, 1.0);
      col *= (1.0 - depth*0.22);                           // gentle shading for roundness only
      float sh = sin(vU*0.55 - uTime*1.7)*0.5 + 0.5;       // lengthwise flow shimmer
      col += vec3(0.10,0.14,0.18)*sh*0.22;
      float pres = smoothstep(0.96,1.0,f);                 // surcharging → warm alarm tint
      col = mix(col, vec3(0.96,0.44,0.25), pres*(0.45+0.15*sin(uTime*5.0)));
      gl_FragColor = vec4(col*nl, 1.0);
    }`;

  // ── INNER WATER SURFACE: a flat ribbon that rides at the water level inside the
  // pipe (level = invert + fill·diameter), with the chord width of the circle at
  // that height. It flows: caustics + a texture that scrolls DOWNSTREAM at the
  // solved velocity, so you see water moving through the pipe, filling it up.
  const WAT_VERT = `
    attribute vec3 aPerp; attribute float aSide; attribute float aCenterY;
    attribute float aRad; attribute float aFill; attribute float aFillPrev; attribute float aU;
    attribute float aFlow; attribute float aTier;
    uniform float uMix; uniform float uTime; uniform float uTierOn[3];
    varying float vFill; varying float vU; varying float vFlow; varying vec3 vW; varying float vOn;
    void main(){
      vOn = uTierOn[int(aTier+0.5)];
      float f = clamp(mix(aFillPrev, aFill, uMix), 0.0, 1.0);
      float waterY = aCenterY - aRad + f*2.0*aRad;
      float dy = waterY - aCenterY;
      float halfW = sqrt(max(0.0, aRad*aRad - dy*dy))*0.92;
      // travelling WAVES on the surface — the level undulates as water flows
      // (amplitude grows with flow speed), like the 2D flood sheet
      float spd = abs(aFlow);
      float wave = sin(aU*0.5 - uTime*(1.0+spd*4.0)*sign(aFlow)) * (0.06 + spd*0.18)
                 + sin(aU*1.3 + uTime*1.7) * 0.04;
      waterY += wave * f;
      vec3 wp = vec3(position.x + aPerp.x*aSide*halfW, waterY, position.z + aPerp.z*aSide*halfW);
      vFill=f; vU=aU; vFlow=aFlow; vW=wp;
      gl_Position = projectionMatrix*modelViewMatrix*vec4(wp,1.0);
    }`;
  // Animated-normal water surface: two scrolling noise fields perturb the normal
  // (a cheap animated normal map) → Fresnel reflectance + a sharp sun glint, plus
  // velocity-driven foam. cameraPosition is a THREE built-in uniform.
  const WAT_FRAG = `
    precision highp float;
    uniform float uTime;
    varying float vFill; varying float vU; varying float vFlow; varying vec3 vW; varying float vOn;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
    void main(){
      if(vOn < 0.5) discard;
      if(vFill < 0.02) discard;
      float spd = abs(vFlow), sgn = sign(vFlow);
      // FLOW-MAP scroll: the ripple UVs advect downstream at the flow speed
      float scroll = uTime*(0.35 + spd*2.8)*sgn;
      vec2 uv1 = vec2(vU*0.11 - scroll,       (vW.x+vW.z)*0.16);
      vec2 uv2 = vec2(vU*0.21 - scroll*1.6,   (vW.x-vW.z)*0.12 + 2.0);
      // animated normal from noise gradients (finite differences) → RIPPLES.
      // Stronger perturbation so the surface visibly wrinkles like the 2D sheet.
      float e = 0.10;
      float hx = (noise(uv1+vec2(e,0.))-noise(uv1-vec2(e,0.))) + 0.7*(noise(uv2+vec2(e,0.))-noise(uv2-vec2(e,0.)));
      float hz = (noise(uv1+vec2(0.,e))-noise(uv1-vec2(0.,e))) + 0.7*(noise(uv2+vec2(0.,e))-noise(uv2-vec2(0.,e)));
      vec3 N = normalize(vec3(-hx*3.4, 1.0, -hz*3.4));
      vec3 V = normalize(cameraPosition - vW);
      vec3 L = normalize(vec3(0.4, 0.9, 0.35));
      float fres = 0.03 + 0.97*pow(1.0 - max(dot(N,V),0.0), 5.0);      // Schlick Fresnel
      float glint = pow(max(dot(reflect(-L,N),V),0.0), 80.0);          // sun specular
      vec3 shallow = vec3(0.48,0.80,0.98), deep = vec3(0.16,0.50,0.80); // lighter (less dark)
      vec3 water = mix(shallow, deep, vFill);
      // travelling ripple crests: bright lines advecting downstream
      float crest = smoothstep(0.75, 1.0, sin(vU*0.7 - uTime*(1.5+spd*4.0)*sgn)*0.5+0.5+ (noise(uv1)-0.5)*0.6);
      water += vec3(0.85,0.95,1.0)*crest*0.18;
      // Sky reflection, but damped as the pipe fills. The surface chord is widest
      // at exactly half-full (real circle geometry), so a strong pale wash put the
      // most washed-out pixels on screen at mid-fill — reading as "more water"
      // than a full pipe. Keep the highlight, stop it peaking mid-fill.
      water = mix(water, vec3(0.82,0.92,1.0), fres*0.26*(1.0 - vFill*0.5));
      // Specular highlights also fade with fill, for the same reason as the sky
      // wash: the surface is widest at half-full, so undamped glint/foam made a
      // half-full pipe the palest, brightest thing on screen.
      float bright = 1.0 - vFill*0.55;
      water += vec3(1.0,0.98,0.92)*glint*bright;                       // glint
      float turb = smoothstep(0.35, 0.9, spd) * step(0.02, spd);
      float foam = smoothstep(0.55, 1.0, noise(vec2(vU*0.4 - scroll*2.2, (vW.x+vW.z)*0.5)));
      water = mix(water, vec3(0.96,0.99,1.0), foam*turb*0.6*bright);
      float pres = smoothstep(0.9,1.0,vFill);
      water = mix(water, vec3(0.97,0.42,0.24), pres*(0.35+0.15*sin(uTime*5.0)));
      water = mix(water, vec3(1.0), pres*foam*0.5);
      // OPAQUE: this is the top face of the water body, not a tint over the pipe.
      // Solid + depth-written is what lets a filled pipe read at a glance.
      gl_FragColor = vec4(water, 1.0);
    }`;

  let H = null;

  function traceChains(keep, linkFrom, linkTo) {
    const adj = new Map();
    const push = (n, e) => { let a = adj.get(n); if (!a) { a = []; adj.set(n, a); } a.push(e); };
    for (let k = 0; k < keep.length; k++) {
      const i = keep[k]; push(linkFrom[i], { k, other: linkTo[i] }); push(linkTo[i], { k, other: linkFrom[i] });
    }
    const deg = (n) => (adj.get(n) || []).length;
    const used = new Uint8Array(keep.length), chains = [];
    const walk = (start, first) => {
      const nodes = [start], slots = []; let e = first, guard = 0;
      while (e && !used[e.k] && guard++ < 100000) {
        used[e.k] = 1; slots.push(e.k); nodes.push(e.other);
        const cur = e.other; if (deg(cur) !== 2) break;
        const nb = adj.get(cur); const nx = (nb[0].k === e.k) ? nb[1] : nb[0];
        if (!nx || used[nx.k]) break; e = nx;
      }
      if (slots.length) chains.push({ nodes, slots });
    };
    for (const [n, es] of adj) if (es.length !== 2) for (const e of es) if (!used[e.k]) walk(n, e);
    for (let k = 0; k < keep.length; k++) if (!used[k]) { const i = keep[k]; walk(linkFrom[i], { k, other: linkTo[i] }); }
    return chains;
  }

  function build(ctx, data) {
    dispose();
    const { THREE, scene, toLocal, VEXAG } = ctx;
    const { nodeLon, nodeLat, nodeMax, linkFrom, linkTo, linkPeak, keep } = data;
    const nn = nodeLon.length;
    const nx = new Float32Array(nn), nz = new Float32Array(nn), ny = new Float32Array(nn);
    for (let i = 0; i < nn; i++) {
      const p = toLocal(nodeLon[i], nodeLat[i]);
      nx[i] = p.x; nz[i] = p.z; ny[i] = -Math.min(Math.max(nodeMax[i], 0.3), 12) * VEXAG;
    }
    const slotOf = new Map(); for (let k = 0; k < keep.length; k++) slotOf.set(keep[k], k);
    const chains = traceChains(keep, linkFrom, linkTo);

    // count
    let nRings = 0, nRibV = 0, nRibQ = 0;
    for (const c of chains) { nRings += c.nodes.length; nRibV += c.nodes.length * 2; nRibQ += (c.nodes.length - 1); }
    const Rp = R + 1, V = nRings * Rp;
    // casing tube buffers
    const pos = new Float32Array(V * 3), nrm = new Float32Array(V * 3), aTier = new Float32Array(V);
    const cU = new Float32Array(V), cFill = new Float32Array(V), cFillPrev = new Float32Array(V), cNode = new Uint32Array(V);
    let quads = 0; for (const c of chains) quads += (c.nodes.length - 1) * R;
    const idx = new Uint32Array(quads * 6);
    // inner-water ribbon buffers
    const rpos = new Float32Array(nRibV * 3), rperp = new Float32Array(nRibV * 3), rside = new Float32Array(nRibV);
    const rcy = new Float32Array(nRibV), rrad = new Float32Array(nRibV), rU = new Float32Array(nRibV);
    const rFill = new Float32Array(nRibV), rFillPrev = new Float32Array(nRibV), rFlow = new Float32Array(nRibV);
    const rTier = new Float32Array(nRibV);
    const rNode = new Uint32Array(nRibV), rSlot = new Uint32Array(nRibV);
    const ridx = new Uint32Array(nRibQ * 6);

    const cosA = new Float32Array(Rp), sinA = new Float32Array(Rp);
    for (let r = 0; r <= R; r++) { const t = r / R * Math.PI * 2; cosA[r] = Math.cos(t); sinA[r] = Math.sin(t); }
    const up = new THREE.Vector3(0, 1, 0);
    const P = new THREE.Vector3(), Pn = new THREE.Vector3(), T = new THREE.Vector3();
    const Nrm = new THREE.Vector3(), Bi = new THREE.Vector3(), prevT = new THREE.Vector3(), tmp = new THREE.Vector3();
    let vo = 0, io = 0, vi = 0, rv = 0, rq = 0;

    for (const c of chains) {
      const pts = c.nodes, slots = c.slots, np = pts.length;
      let qmax = 0; for (const s of slots) qmax = Math.max(qmax, linkPeak[keep[s]]);
      const rad = Math.min(R_MAX, R_MIN + Math.log10(1 + qmax * 12) * 1.7);
      const tier = tierOf(qmax);
      let haveFrame = false, cum = 0; const ringStart = []; const ribStart = [];
      for (let p = 0; p < np; p++) {
        const n0 = pts[p]; P.set(nx[n0], ny[n0], nz[n0]);
        if (p < np - 1) { const n1 = pts[p + 1]; Pn.set(nx[n1], ny[n1], nz[n1]); T.subVectors(Pn, P); }
        else { const npv = pts[p - 1]; Pn.set(nx[npv], ny[npv], nz[npv]); T.subVectors(P, Pn); }
        if (T.lengthSq() < 1e-10) T.set(1, 0, 0); T.normalize();
        if (!haveFrame) {
          Nrm.crossVectors(Math.abs(T.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up, T).normalize();
          Bi.crossVectors(T, Nrm).normalize(); haveFrame = true;
        } else {
          tmp.crossVectors(prevT, T); const s = tmp.length(), cth = prevT.dot(T);
          if (s > 1e-6) { tmp.multiplyScalar(1 / s); Nrm.applyAxisAngle(tmp, Math.atan2(s, cth)); }
          Nrm.sub(T.clone().multiplyScalar(Nrm.dot(T))).normalize(); Bi.crossVectors(T, Nrm).normalize();
        }
        prevT.copy(T);
        if (p > 0) cum += P.distanceTo(tmp.set(nx[pts[p - 1]], ny[pts[p - 1]], nz[pts[p - 1]]));
        const slot = slotOf.get(keep[slots[Math.min(p, slots.length - 1)]]);
        // casing ring
        ringStart.push(vi);
        for (let r = 0; r <= R; r++) {
          const ox = Nrm.x * cosA[r] * rad + Bi.x * sinA[r] * rad;
          const oy = Nrm.y * cosA[r] * rad + Bi.y * sinA[r] * rad;
          const oz = Nrm.z * cosA[r] * rad + Bi.z * sinA[r] * rad;
          pos[vo] = P.x + ox; pos[vo + 1] = P.y + oy; pos[vo + 2] = P.z + oz;
          const il = 1 / (Math.hypot(ox, oy, oz) || 1);
          nrm[vo] = ox * il; nrm[vo + 1] = oy * il; nrm[vo + 2] = oz * il;
          aTier[vi] = tier; cNode[vi] = n0; cU[vi] = cum; vo += 3; vi++;
        }
        // ribbon pair (horizontal perpendicular to the pipe axis)
        const perpX = -T.z, perpZ = T.x, pl = Math.hypot(perpX, perpZ) || 1;
        ribStart.push(rv);
        for (let side = 0; side < 2; side++) {
          rpos[rv * 3] = P.x; rpos[rv * 3 + 1] = 0; rpos[rv * 3 + 2] = P.z;
          rperp[rv * 3] = perpX / pl; rperp[rv * 3 + 1] = 0; rperp[rv * 3 + 2] = perpZ / pl;
          rside[rv] = side ? 1 : -1; rcy[rv] = P.y; rrad[rv] = rad; rU[rv] = cum;
          rTier[rv] = tier; rNode[rv] = n0; rSlot[rv] = slot; rv++;
        }
      }
      for (let p = 0; p < np - 1; p++) {
        const s0 = ringStart[p], s1 = ringStart[p + 1];
        for (let r = 0; r < R; r++) {
          const a0 = s0 + r, a1 = s0 + r + 1, b0 = s1 + r, b1 = s1 + r + 1;
          idx[io++] = a0; idx[io++] = b0; idx[io++] = a1; idx[io++] = a1; idx[io++] = b0; idx[io++] = b1;
        }
        const q0 = ribStart[p], q1 = ribStart[p + 1];   // ribbon quad (q0,q0+1)-(q1,q1+1)
        ridx[rq++] = q0; ridx[rq++] = q1; ridx[rq++] = q0 + 1;
        ridx[rq++] = q0 + 1; ridx[rq++] = q1; ridx[rq++] = q1 + 1;
      }
    }

    // casing mesh
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    cg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    cg.setAttribute('aTier', new THREE.BufferAttribute(aTier, 1));
    cg.setAttribute('aU', new THREE.BufferAttribute(cU, 1));
    const cFillAttr = new THREE.BufferAttribute(cFill, 1), cFillPrevAttr = new THREE.BufferAttribute(cFillPrev, 1);
    cg.setAttribute('aFill', cFillAttr); cg.setAttribute('aFillPrev', cFillPrevAttr);
    cg.setIndex(new THREE.BufferAttribute(idx, 1));
    // Shared per-tier visibility, driven by the legend toggles.
    const tierOn = { value: [1, 1, 1] };
    const caseMat = new THREE.ShaderMaterial({
      uniforms: { uMode: { value: 0 }, uTime: { value: 0 }, uMix: { value: 1 }, uTierOn: tierOn,
        uTierCol: { value: TIERS.map(t => new THREE.Vector3(...t.color)) } },
      // FrontSide (was DoubleSide): halves the alpha stacking through every tube.
      vertexShader: CASE_VERT, fragmentShader: CASE_FRAG, transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
    const caseMesh = new THREE.Mesh(cg, caseMat);
    caseMesh.frustumCulled = false; caseMesh.renderOrder = 2; scene.add(caseMesh);

    // Water body — same tube geometry, opaque, clipped at the waterline.
    const wvolMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uMix: { value: 1 }, uTierOn: tierOn },
      vertexShader: WVOL_VERT, fragmentShader: WVOL_FRAG,
      transparent: false, depthWrite: true, side: THREE.DoubleSide,
    });
    const wvolMesh = new THREE.Mesh(cg, wvolMat);
    wvolMesh.frustumCulled = false; wvolMesh.renderOrder = 1; scene.add(wvolMesh);

    // inner-water mesh
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
    wg.setAttribute('aPerp', new THREE.BufferAttribute(rperp, 3));
    wg.setAttribute('aSide', new THREE.BufferAttribute(rside, 1));
    wg.setAttribute('aCenterY', new THREE.BufferAttribute(rcy, 1));
    wg.setAttribute('aRad', new THREE.BufferAttribute(rrad, 1));
    wg.setAttribute('aU', new THREE.BufferAttribute(rU, 1));
    const rFillAttr = new THREE.BufferAttribute(rFill, 1), rFillPrevAttr = new THREE.BufferAttribute(rFillPrev, 1);
    const rFlowAttr = new THREE.BufferAttribute(rFlow, 1);
    wg.setAttribute('aFill', rFillAttr); wg.setAttribute('aFillPrev', rFillPrevAttr); wg.setAttribute('aFlow', rFlowAttr);
    wg.setAttribute('aTier', new THREE.BufferAttribute(rTier, 1));
    wg.setIndex(new THREE.BufferAttribute(ridx, 1));
    const watMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uMix: { value: 1 }, uTierOn: tierOn },
      vertexShader: WAT_VERT, fragmentShader: WAT_FRAG,
      transparent: false, depthWrite: true, side: THREE.DoubleSide,
    });
    const watMesh = new THREE.Mesh(wg, watMat);
    watMesh.frustumCulled = false; watMesh.renderOrder = 3; scene.add(watMesh);

    // ── MANHOLE SHAFTS: vertical risers from the buried pipe up to street level
    // (y=0), capped with a rim disc, built only at JUNCTIONS (deg≥3) so they stay
    // sparse. They make the depth legible: GROUND (y=0, the rim) → cover → CROWN
    // (top of pipe) → INVERT (bottom). Grey concrete, lit, one merged mesh.
    const deg = new Int32Array(nn);
    for (let k = 0; k < keep.length; k++) { deg[linkFrom[keep[k]]]++; deg[linkTo[keep[k]]]++; }
    const junc = []; for (let n = 0; n < nn; n++) if (deg[n] >= 3) junc.push(n);
    const shaftMesh = buildShafts(THREE, junc, nx, ny, nz, deg, keep, linkFrom, linkTo, linkPeak, slotOf);
    if (shaftMesh) { shaftMesh.renderOrder = 1; scene.add(shaftMesh); }

    // ── CUTAWAY SOIL: a translucent earth volume from just below the street down
    // past the deepest pipe over the network footprint. The pipes render on top,
    // so they read as EMBEDDED IN GROUND (x-ray earth / cutaway) rather than
    // floating in void. Low opacity so it never dominates.
    let mnx = 1e18, mxx = -1e18, mnz = 1e18, mxz = -1e18, mny = 0;
    for (let k = 0; k < keep.length; k++) { const i = keep[k];
      for (const nd of [linkFrom[i], linkTo[i]]) {
        if (nx[nd] < mnx) mnx = nx[nd]; if (nx[nd] > mxx) mxx = nx[nd];
        if (nz[nd] < mnz) mnz = nz[nd]; if (nz[nd] > mxz) mxz = nz[nd];
        if (ny[nd] < mny) mny = ny[nd];
      } }
    const soilMesh = buildSoil(THREE, mnx, mxx, mnz, mxz, mny);
    if (soilMesh) { soilMesh.renderOrder = 0; scene.add(soilMesh); }

    H = { ctx, caseMesh, watMesh, wvolMesh, shaftMesh, soilMesh, caseMat, watMat, wvolMat, tierOn,
          rFillAttr, rFillPrevAttr, rFlowAttr, cFillAttr, cFillPrevAttr, mix: 1,
          layerOn: { casing: true, water: true, shafts: true, soil: true },
          keep, rNode, rSlot, cNode, nfill: new Float32Array(nn), lflow: new Float32Array(keep.length),
          drawn: keep.length, chains: chains.length, tiers: TIERS };
    return {
      meshes: [caseMesh, wvolMesh, watMesh].concat(shaftMesh ? [shaftMesh] : []).concat(soilMesh ? [soilMesh] : []),
      drawn: keep.length, chains: chains.length, tiers: TIERS,
      updateHour: (rec, nodeMax, ds, fs) => updateHour(rec, nodeMax, ds, fs),
      setMode, setVisible, setTier, setLayer, tick, stats, dispose,
    };
  }

  // Translucent earth volume (open-topped box) enclosing the buried network.
  function buildSoil(THREE, mnx, mxx, mnz, mxz, mny) {
    if (!(mxx > mnx)) return null;
    const pad = 6, top = -0.5, bot = mny - 4;   // just under street → below deepest pipe
    const x0 = mnx - pad, x1 = mxx + pad, z0 = mnz - pad, z1 = mxz + pad;
    const g = new THREE.BoxGeometry(x1 - x0, top - bot, z1 - z0);
    g.translate((x0 + x1) / 2, (top + bot) / 2, (z0 + z1) / 2);
    // earthy brown, very low opacity, no depth write so the pipes show through
    const m = new THREE.MeshBasicMaterial({ color: 0x8a6b4a, transparent: true, opacity: 0.05,
      side: THREE.BackSide, depthWrite: false });   // BackSide → only the FAR walls tint (no near-face wash)
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
    return mesh;
  }

  // Merged vertical shafts (6-sided) from each junction node's pipe up to y=0,
  // plus a rim ring at the top so the street opening reads.
  function buildShafts(THREE, junc, nx, ny, nz, deg, keep, linkFrom, linkTo, linkPeak, slotOf) {
    if (!junc.length) return null;
    // Slim risers: at 0.9 m these read as a forest of grey poles over a dense
    // network. Narrow + low-opacity keeps the depth cue without the clutter.
    const S = 8, sr = 0.45, rimR = 0.8;
    // per node: 2 shaft rings (S+1) + 2 rim rings (S+1) for the top opening
    const perNode = (S + 1) * 4;
    const V = junc.length * perNode, pos = new Float32Array(V * 3), nrm = new Float32Array(V * 3);
    const idx = new Uint32Array(junc.length * S * 6 * 2);
    const cs = new Float32Array(S + 1), sn = new Float32Array(S + 1);
    for (let s = 0; s <= S; s++) { const t = s / S * Math.PI * 2; cs[s] = Math.cos(t); sn[s] = Math.sin(t); }
    let vo = 0, io = 0, base = 0;
    for (const n of junc) {
      const x = nx[n], z = nz[n], yb = ny[n];
      // shaft wall: bottom ring (pipe) → top ring (street)
      for (let e = 0; e < 2; e++) { const y = e ? 0.0 : yb;
        for (let s = 0; s <= S; s++) { const ox = cs[s] * sr, oz = sn[s] * sr;
          pos[vo] = x + ox; pos[vo+1] = y; pos[vo+2] = z + oz;
          const il = 1 / (Math.hypot(ox, oz) || 1); nrm[vo] = ox*il; nrm[vo+1] = 0; nrm[vo+2] = oz*il; vo += 3; } }
      // rim: flat annulus at y=0 (inner shaft radius → wider rimR)
      for (let e = 0; e < 2; e++) { const rr = e ? rimR : sr;
        for (let s = 0; s <= S; s++) { const ox = cs[s]*rr, oz = sn[s]*rr;
          pos[vo] = x + ox; pos[vo+1] = 0.15; pos[vo+2] = z + oz;
          nrm[vo] = 0; nrm[vo+1] = 1; nrm[vo+2] = 0; vo += 3; } }
      const w0 = base, w1 = base + (S+1), r0 = base + (S+1)*2, r1 = base + (S+1)*3;
      for (let s = 0; s < S; s++) {
        idx[io++] = w0+s; idx[io++] = w1+s; idx[io++] = w0+s+1;             // shaft wall
        idx[io++] = w0+s+1; idx[io++] = w1+s; idx[io++] = w1+s+1;
        idx[io++] = r0+s; idx[io++] = r1+s; idx[io++] = r0+s+1;             // rim annulus
        idx[io++] = r0+s+1; idx[io++] = r1+s; idx[io++] = r1+s+1;
      }
      base += perNode;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.MeshLambertMaterial({ color: 0x7c8794, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
    return mesh;
  }

  // Double-buffer the fill (prev ← current, current ← new hour) and reset uMix to
  // 0; the render loop eases uMix→1 so the water level INTERPOLATES smoothly
  // between hourly timesteps — done entirely on the GPU (no per-frame CPU work).
  function updateHour(rec, nodeMax, depthScale, flowScale) {
    if (!H) return;
    const { keep, rNode, rSlot, cNode, nfill, lflow,
            rFillAttr, rFillPrevAttr, rFlowAttr, cFillAttr, cFillPrevAttr } = H;
    const fa = rFillAttr.array, fap = rFillPrevAttr.array, wa = rFlowAttr.array;
    const ca = cFillAttr.array, cap = cFillPrevAttr.array;
    const depth = rec.depth, flow = rec.flow, ds = depthScale || 1000, fs = flowScale || 100;
    for (let k = 0; k < keep.length; k++) lflow[k] = Math.max(-1, Math.min(1, flow[keep[k]] / fs / 2.0));
    for (let n = 0; n < nfill.length; n++) nfill[n] = Math.min(1, (depth[n] / ds) / Math.max(nodeMax[n], 0.1));
    fap.set(fa); cap.set(ca);                          // snapshot the level we're leaving
    for (let v = 0; v < rNode.length; v++) { fa[v] = nfill[rNode[v]]; wa[v] = lflow[rSlot[v]]; }
    for (let v = 0; v < cNode.length; v++) ca[v] = nfill[cNode[v]];
    rFillAttr.needsUpdate = rFillPrevAttr.needsUpdate = rFlowAttr.needsUpdate = true;
    cFillAttr.needsUpdate = cFillPrevAttr.needsUpdate = true;
    H.mix = 0; H.caseMat.uniforms.uMix.value = 0; H.watMat.uniforms.uMix.value = 0;
    H.wvolMat.uniforms.uMix.value = 0;
  }

  function setMode(mode) {
    if (!H) return;
    const cap = (mode === 'capacity');
    H.caseMat.uniforms.uMode.value = cap ? 1 : 0;
    // Capacity view = solid choropleth pipes, so the casing owns the depth buffer
    // and the water skins step aside.
    H.caseMat.depthWrite = cap;
    H.caseMat.needsUpdate = true;
    applyVis();
    if (H.ctx.repaint) H.ctx.repaint();
  }
  // Single place that reconciles master visibility × per-layer toggles × mode.
  function applyVis() {
    if (!H) return;
    const on = H.visible !== false, cap = H.caseMat.uniforms.uMode.value > 0.5, L = H.layerOn;
    H.caseMesh.visible = on && L.casing;
    H.wvolMesh.visible = on && L.water && !cap;
    H.watMesh.visible = on && L.water && !cap;
    if (H.shaftMesh) H.shaftMesh.visible = on && L.shafts;
    if (H.soilMesh) H.soilMesh.visible = on && L.soil;
  }
  function setVisible(on) { if (!H) return; H.visible = on; applyVis(); if (H.ctx.repaint) H.ctx.repaint(); }
  function setTier(i, on) {
    if (!H || i < 0 || i > 2) return;
    H.tierOn.value[i] = on ? 1 : 0;
    if (H.ctx.repaint) H.ctx.repaint();
  }
  function setLayer(name, on) {
    if (!H || !(name in H.layerOn)) return;
    H.layerOn[name] = !!on; applyVis();
    if (H.ctx.repaint) H.ctx.repaint();
  }
  function tick(clock) {
    if (!H) return;
    H.caseMat.uniforms.uTime.value = clock; H.watMat.uniforms.uTime.value = clock;
    H.wvolMat.uniforms.uTime.value = clock;
    if (H.mix < 1) {                       // ease the timestep interpolation to smooth
      H.mix = Math.min(1, H.mix + 0.035);
      H.caseMat.uniforms.uMix.value = H.mix; H.watMat.uniforms.uMix.value = H.mix;
      H.wvolMat.uniforms.uMix.value = H.mix;
      if (H.ctx.repaint) H.ctx.repaint();
    }
  }
  function stats() { return H ? { drawn: H.drawn, chains: H.chains, tiers: TIERS } : null; }
  function dispose() {
    if (!H) return;
    // caseMesh and wvolMesh SHARE one geometry — dispose it once.
    for (const m of [H.caseMesh, H.wvolMesh, H.watMesh, H.shaftMesh, H.soilMesh]) {
      if (!m) continue;
      if (m.parent) m.parent.remove(m);
      m.material.dispose();
    }
    if (H.caseMesh) H.caseMesh.geometry.dispose();
    if (H.watMesh) H.watMesh.geometry.dispose();
    if (H.shaftMesh) H.shaftMesh.geometry.dispose();
    if (H.soilMesh) H.soilMesh.geometry.dispose();
    H = null;
  }

  window.DrainageViz = { build, updateHour, setMode, setVisible, setTier, setLayer, tick, stats, dispose, TIERS, tierOf };
})();
