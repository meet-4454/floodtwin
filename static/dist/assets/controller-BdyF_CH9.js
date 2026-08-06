const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/buildings-CXm0FY8W.js","assets/index-5T7_pYe7.js","assets/react-C4xND61i.js","assets/index-Kykfnp0o.css","assets/three-ab00-b5W.js","assets/assetsLayer-CrD5C0xa.js","assets/drainageViz-Blgq8ufD.js","assets/drainageAssets-JE-v1nNQ.js"])))=>i.map(i=>d[i]);
import{G as q,r as J,u as W,F as N,c as Q,D as j,_ as O}from"./index-5T7_pYe7.js";import{T as ee,M as V,V as U,C as te,S as ae,A as re,W as se}from"./three-ab00-b5W.js";const H=28.4595,Z=77.0266,ne=d=>`https://apis.mappls.com/advancedmaps/api/${encodeURIComponent(d)}/map_sdk?v=3.0&layer=vector`;function oe(d,t){return new Promise((n,r)=>{if(window.mappls&&typeof window.mappls.Map=="function")return n();if(!d)return r(new Error("Mappls API key not configured on the server (MAPPLS_API_KEY)."));let m=0;const T=3,l=()=>{m++;const o=document.createElement("script");o.src=ne(d),o.async=!0,o.onload=()=>{let g=0;const w=setInterval(()=>{window.mappls&&typeof window.mappls.Map=="function"?(clearInterval(w),n()):++g>100&&(clearInterval(w),r(new Error("Mappls SDK loaded but never exposed mappls.Map")))},100)},o.onerror=()=>{o.remove(),m<T?(t==null||t(`Map SDK unreachable — retrying (${m}/${T-1})…`),setTimeout(l,1500*m)):r(new Error("Map SDK failed to load. Check network / adblock / API key."))},document.head.appendChild(o)};l()})}const ie=["Open Sans Regular"],ye=["Open Sans Bold"];function xe(d,t,n){if((t==null?void 0:t.type)==="symbol"){const r=t.layout||(t.layout={});r["text-field"]&&!r["text-font"]&&(r["text-font"]=ie)}return d.addLayer(t,n)}function ce(){var r;const d=(r=window.maplibregl)==null?void 0:r.MercatorCoordinate;if(d){const m=d.fromLngLat([Z,H],0);return{translateX:m.x,translateY:m.y,translateZ:m.z,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:m.meterInMercatorCoordinateUnits()}}const t=(Z+180)/360,n=Math.sin(H*Math.PI/180);return{translateX:t,translateY:.5-Math.log((1+n)/(1-n))/(4*Math.PI),translateZ:0,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:1/(2*Math.PI*6378137*Math.cos(H*Math.PI/180))}}function le(d,t){var T;const n=(T=window.maplibregl)==null?void 0:T.MercatorCoordinate;if(n)return n.fromLngLat([d,t]);const r=(d+180)/360,m=Math.sin(t*Math.PI/180);return{x:r,y:.5-Math.log((1+m)/(1-m))/(4*Math.PI)}}async function ue({container:d,mapplsKey:t,onStatus:n}){n==null||n("Loading map SDK…"),await oe(t,n),n==null||n("Initialising map…");const r=new window.mappls.Map(d,{center:{lat:H,lng:Z},zoom:12.6,pitch:45,bearing:-12,zoomControl:!1,attributionControl:!1,fullscreenControl:!1,preserveDrawingBuffer:!0}),m=ce(),l={THREE:ee,map:r,toLocal:(h,u)=>{const p=le(h,u);return{x:(p.x-m.translateX)/m.scale,z:(p.y-m.translateY)/m.scale}},modelTransform:m,scene:null,camera:null,renderer:null,clock:0,layers:Object.create(null),tickers:new Set,stepHandlers:new Set,triggerRepaint:()=>{try{r.triggerRepaint()}catch{}},destroy:null},o={id:"ft-scene",type:"custom",renderingMode:"3d",onAdd(h,u){l.camera=new te,l.scene=new ae,l.scene.add(new re(16777215,1)),l.renderer=new se({canvas:h.getCanvas(),context:u,antialias:!0,preserveDrawingBuffer:!0}),l.renderer.autoClear=!1},render(h,u){var I,B,C;const p=m,b=new V().makeRotationAxis(new U(1,0,0),p.rotateX),_=new V().makeRotationAxis(new U(0,1,0),p.rotateY),i=new V().makeRotationAxis(new U(0,0,1),p.rotateZ),f=new V().fromArray(u),y=new V().makeTranslation(p.translateX,p.translateY,p.translateZ).scale(new U(p.scale,-p.scale,p.scale)).multiply(b).multiply(_).multiply(i);l.camera.projectionMatrix=f.multiply(y);const z=h.drawingBufferWidth,k=h.drawingBufferHeight;l.renderer.setViewport(0,0,z,k),l.renderer.resetState(),l.renderer.render(l.scene,l.camera),h.viewport(0,0,z,k),(C=(B=(I=r.painter)==null?void 0:I.context)==null?void 0:B.setDirty)==null||C.call(B)}},g=new URLSearchParams(location.search).get("nogl")==="1";await new Promise(h=>{let u=!1;const p=()=>{if(!u){if(u=!0,!g)try{r.addLayer(o)}catch(b){console.warn("custom layer add:",b)}h()}};r.on("load",p),r.on("style.load",p),setTimeout(p,6e3)});const M=1e3/30;let v=null,A=0,E=0,S=document.hidden;const R=()=>{S=document.hidden,A=0};document.addEventListener("visibilitychange",R);const L=h=>{if(v=requestAnimationFrame(L),S||!l.tickers.size){A=h;return}A||(A=h);const u=Math.min((h-A)/1e3,.05);if(A=h,E+=u*1e3,E<M)return;const p=E/1e3;E=0,l.clock+=p;for(const b of l.tickers)try{b(l.clock,p)}catch(_){console.warn(_)}l.triggerRepaint()};if(v=requestAnimationFrame(L),window.ResizeObserver){const h=typeof d=="string"?document.getElementById(d):d;if(h){let u=null,p=0,b=0;new ResizeObserver(_=>{var f;const i=(f=_[0])==null?void 0:f.contentRect;i&&Math.abs(i.width-p)<1&&Math.abs(i.height-b)<1||(i&&(p=i.width,b=i.height),!u&&(u=requestAnimationFrame(()=>{u=null;try{r.resize()}catch{}})))}).observe(h)}}return l.destroy=()=>{cancelAnimationFrame(v),document.removeEventListener("visibilitychange",R),l.tickers.clear();try{r.remove()}catch{}},window.__ftEngine=l,window.__map=r,l}function pe(d,{xray:t}){var r;const{map:n}=d;try{if(t&&!n.getLayer("xray-dim")&&(n.addSource("xray-dim-src",{type:"geojson",data:{type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[[[-179,-85],[179,-85],[179,85],[-179,85],[-179,-85]]]}}}),n.addLayer({id:"xray-dim",type:"fill",source:"xray-dim-src",paint:{"fill-color":"#0a1420","fill-opacity":0}})),!n.getLayer("xray-dim"))return;if(t){const m=((r=n.style)==null?void 0:r._order)||[];let T=null;for(const l of m){const o=n.getLayer(l);if(o&&o.type==="fill-extrusion"&&!/sea/i.test(l)){T=l;break}}T&&n.moveLayer("xray-dim",T)}n.setPaintProperty("xray-dim","fill-opacity",t?.6:0)}catch(m){console.warn("layer order:",m)}}const de=192,fe=`
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
}`,me=`
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

${q}

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
}`;function he(d,t){const{THREE:n,scene:r,toLocal:m}=d,T=t.state.man,l=T.grid_n,o=T.grid_bbox,g=de,w=(g+1)*(g+1),M=new Float32Array(w*3),v=new Float32Array(w*2);let A=0,E=0;for(let i=0;i<=g;i++)for(let f=0;f<=g;f++){const y=m(o[0]+f/g*(o[2]-o[0]),o[1]+i/g*(o[3]-o[1]));M[A++]=y.x,M[A++]=0,M[A++]=y.z,v[E++]=f/g,v[E++]=i/g}const S=new Uint32Array(g*g*6);let R=0;for(let i=0;i<g;i++)for(let f=0;f<g;f++){const y=i*(g+1)+f,z=y+1,k=y+(g+1),I=k+1;S[R++]=y,S[R++]=k,S[R++]=z,S[R++]=z,S[R++]=k,S[R++]=I}const L=new n.BufferGeometry;L.setAttribute("position",new n.BufferAttribute(M,3)),L.setAttribute("uv",new n.BufferAttribute(v,2)),L.setIndex(new n.BufferAttribute(S,1)),(!t.state.grid||t.state.grid.length!==l*l)&&(t.state.grid=new Float32Array(l*l));const h=new n.DataTexture(t.state.grid,l,l,n.LuminanceFormat,n.FloatType);h.minFilter=n.LinearFilter,h.magFilter=n.LinearFilter,h.needsUpdate=!0;const u=new n.ShaderMaterial({uniforms:{uTime:{value:0},uOpacity:{value:.78},uMaxDepth:{value:t.maxDepthScale},uDepthTex:{value:h},uTexelSize:{value:new n.Vector2(1/l,1/l)},uBlur:{value:1},uWetMin:{value:.01},uWaveAmp:{value:.18},uDepthHeight:{value:.45},uBandOn:{value:new n.Vector4(1,1,1,1)},uBandEdge:{value:new n.Vector3(.2,.6,1.2)},uRipple0:{value:new n.Vector3(0,0,-1)},uRipple1:{value:new n.Vector3(0,0,-1)},uRipple2:{value:new n.Vector3(0,0,-1)},uRipple3:{value:new n.Vector3(0,0,-1)},...J(n)},vertexShader:fe,fragmentShader:me,transparent:!0,side:n.DoubleSide,depthWrite:!1,extensions:{derivatives:!0}}),p=new n.Mesh(L,u);p.frustumCulled=!1,p.renderOrder=0,r.add(p);let b=0;const _=i=>{u.uniforms.uTime.value=i};return d.tickers.add(_),{mesh:p,mat:u,tex:h,setVisible(i){p.visible=i,d.triggerRepaint()},setOpacity(i){u.uniforms.uOpacity.value=i,d.triggerRepaint()},setZoom(i){const f=i>=16?1:i>=14?1.5:i>=12.5?2.2:i>=11?3:4,y=i>=15?.01:i>=13?.022:i>=11.5?.038:.055;(Math.abs(f-u.uniforms.uBlur.value)>.01||Math.abs(y-u.uniforms.uWetMin.value)>1e-4)&&(u.uniforms.uBlur.value=f,u.uniforms.uWetMin.value=y,d.triggerRepaint())},refresh(){h.needsUpdate=!0,u.uniforms.uMaxDepth.value=t.maxDepthScale,d.triggerRepaint()},setBands(i,f){u.uniforms.uBandOn.value.set(i[0]?1:0,i[1]?1:0,i[2]?1:0,i[3]?1:0),f&&u.uniforms.uBandEdge.value.set(f[0],f[1],f[2]),d.triggerRepaint()},ripple(i,f){const y=m(i,f);u.uniforms[`uRipple${b}`].value.set(y.x,y.z,u.uniforms.uTime.value),b=(b+1)%4,d.triggerRepaint()},dispose(){d.tickers.delete(_),r.remove(p),L.dispose(),u.dispose(),h.dispose()}}}async function ve({container:d}){const t=W.getState;t().setStatus("Starting…");const n=fetch("/api/config").then(e=>e.ok?e.json():{}).catch(()=>({})),r=Q(),m=r.loadManifest("event"),T=fetch("/sim/surface_grid_00.bin").catch(()=>null),l=await n;t().setStatus("Loading map…");const[o,g]=await Promise.all([ue({container:d,mapplsKey:l.mapplsApiKey,onStatus:e=>t().setStatus(e)}),m]);t().setTimeline(g,"event"),t().setStatus("Building flood surface…"),await T,await r.useFrame(0);const w=he(o,r);o.layers.flood=w,t().setMaxDepth(r.maxDepthScale),w.setOpacity(t().opacity);const M=new Map,v=o.layers,A="ft_stale_build_reloaded",E=e=>{const a=`${(e==null?void 0:e.message)||e}`;return/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(a)},S=(e,a)=>{if(M.has(e))return M.get(e);t().setFeatureStatus(e,"loading");const s=Promise.resolve().then(a).then(c=>(v[e]=c,sessionStorage.removeItem(A),t().setFeatureStatus(e,"ready"),c)).catch(c=>{if(console.warn(`[feature ${e}]`,c),E(c)&&!sessionStorage.getItem(A)){sessionStorage.setItem(A,"1"),t().setStatus("A newer build is live — reloading…"),window.location.reload();return}throw t().setFeatureStatus(e,"error",c.message||String(c)),M.delete(e),c});return M.set(e,s),s},R={flood:async()=>w,wards:async()=>{const{createWards:e}=await O(async()=>{const{createWards:a}=await import("./buildings-CXm0FY8W.js");return{createWards:a}},__vite__mapDeps([0,1,2,3,4]));return e(o)},buildings:async()=>{const{createBuildings:e}=await O(async()=>{const{createBuildings:a}=await import("./buildings-CXm0FY8W.js");return{createBuildings:a}},__vite__mapDeps([0,1,2,3,4]));return e(o)},assets:async()=>{const{createAssetsLayer:e}=await O(async()=>{const{createAssetsLayer:s}=await import("./assetsLayer-CrD5C0xa.js");return{createAssetsLayer:s}},__vite__mapDeps([5,1,2,3,4])),a=await e(o,{onDepthAt:(s,c)=>r.depthAt(s,c),onCounts:s=>t().setAssetCounts(s)});for(const s of N.find(c=>c.id==="assets").children)a.setCategory(s.id,!!t().features[`assets.${s.id}`]);return a},sewer:async()=>{const{createSewerLayer:e}=await O(async()=>{const{createSewerLayer:s}=await import("./sewerLayer-CWO48TAB.js");return{createSewerLayer:s}},[]),a=await e(o);return t().setSewerStats(a.stats),a},roads:async()=>{const{createRoadsLayer:e}=await O(async()=>{const{createRoadsLayer:a}=await import("./roadsLayer-R7LV1nff.js");return{createRoadsLayer:a}},[]);return e(o,{depthAt:(a,s)=>r.depthAtSmooth(a,s),onSegments:a=>t().setRoadSegments(a)})},drainage:async()=>{t().setStatus("Loading drainage network…");const e=await r.loadGeometry(),[{createDrainageViz:a},{createDrainageAssets:s}]=await Promise.all([O(()=>import("./drainageViz-Blgq8ufD.js"),__vite__mapDeps([6,1,2,3])),O(()=>import("./drainageAssets-JE-v1nNQ.js"),__vite__mapDeps([7,1,2,3,4]))]),c=a(o,e),x=await s(o,{depthAt:(P,F)=>r.depthAt(P,F)});v.drainAssets=x,t().setDrainStats({links:c.links,chains:c.chains,tiers:c.tierCount,classes:c.classCount,...x.stats}),c.setZoom(o.map.getZoom());const D=await r.fetchHour(t().step);return D&&(c.updateHour(D,e.nodeMax,r.state.man.depth_scale,r.state.man.flow_scale),x.updateFrame(D,e),t().setSurcharged(x.surchargedCount)),c}};function L(){const e=t().features;pe(o,{xray:!!e.xray})}async function h(e,a){var s,c;switch(e){case"flood":w.setVisible(a);break;case"hotspots":a?f():t().setHotspots([]);break;case"xray":L();break;case"terrain":try{o.map.easeTo({pitch:a?55:0,duration:700})}catch{}break;default:{if(!R[e]||!a&&!M.has(e))return;let x;try{x=await S(e,R[e])}catch{return}(s=x.setVisible)==null||s.call(x,a),e==="drainage"&&((c=v.drainAssets)==null||c.setVisible(a),u()),e==="assets"&&p();break}}L()}function u(){const e=v.drainage,a=v.drainAssets,s=t().features;if(!e)return;const c={storm:0,sewer:1,unclass:2};for(const[D,P]of Object.entries(c))e.setClass(P,!!s[`drainage.${D}`]);const x={trunk:0,main:1,lateral:2};for(const[D,P]of Object.entries(x)){const F=s[`drainage.${D}`];e.setTier(P,F==="auto"?null:!!F)}for(const D of["water","shafts"])e.setLayer(D,!!s[`drainage.${D}`]);if(e.setMode(s["drainage.capacity"]?"capacity":"water"),a)for(const D of["surcharge","inlets","outfalls","pumps"])a.setLayer(D,!!s[`drainage.${D}`])}function p(){const e=v.assets;if(e)for(const a of N.find(s=>s.id==="assets").children)e.setCategory(a.id,!!t().features[`assets.${a.id}`])}let b=0;async function _(e){var c,x,D;const a=++b;if(await r.useFrame(e),a!==b)return;w.refresh(),t().setKpi(r.frameStats());const s=r.maxDepthScale;if(Math.abs(s-t().maxDepth)>.001&&(t().setMaxDepth(s),(c=v.drainage)==null||c.setMaxDepth(s),w.setBands(t().bands,t().bandEdges())),v.drainage||v.drainAssets){const P=await r.fetchHour(e);if(a!==b||!P)return;const F=r.state.geom;(x=v.drainage)==null||x.updateHour(P,F.nodeMax,r.state.man.depth_scale,r.state.man.flow_scale),v.drainAssets&&(v.drainAssets.updateFrame(P,F),t().setSurcharged(v.drainAssets.surchargedCount))}(D=v.roads)==null||D.refresh(),f()}let i=null;function f(){clearTimeout(i),i=setTimeout(()=>{var e,a;try{if(t().setKpi(r.frameStats()),!t().features.hotspots)return;const s=(a=(e=o.map).getBounds)==null?void 0:a.call(e),c=s?{s:s.getSouth(),w:s.getWest(),n:s.getNorth(),e:s.getEast()}:null;t().setHotspots(r.hotspots({bounds:c,limit:8,minSepDeg:.006}))}catch(s){console.warn("[derived read-outs]",s)}},200)}let y=null;async function z(e){var a,s;if(!(e===r.state.dataset||y===e)){y=e;try{t().setStatus(`Loading ${((a=j[e])==null?void 0:a.label)||e}…`);const c=await r.loadManifest(e);t().setTimeline(c,e);const x=Math.min(t().step,Math.max(0,c.n_hours-1));W.setState({step:x}),await _(x),t().setStatus("Ready")}catch(c){console.warn("[dataset]",c),t().setStatus(`Could not load ${((s=j[e])==null?void 0:s.label)||e}`)}finally{y=null}}}let k=t();const I=W.subscribe(e=>{const a=k;if(k=e,e.features!==a.features){for(const s of Object.keys(e.features))if(e.features[s]!==a.features[s])if(s.includes(".")){const[c]=s.split(".");c==="drainage"?u():c==="assets"&&p()}else h(s,e.features[s])}e.dataset!==a.dataset?z(e.dataset):e.step!==a.step&&_(e.step),e.opacity!==a.opacity&&w.setOpacity(e.opacity),(e.bands!==a.bands||e.maxDepth!==a.maxDepth)&&w.setBands(e.bands,t().bandEdges())});let B=null;const C=()=>{B||(B=requestAnimationFrame(()=>{var a;B=null;const e=o.map.getZoom();(a=v.drainage)==null||a.setZoom(e),w.setZoom(e)}))};o.map.on("zoom",C),o.map.on("moveend",f),o.map.on("click",e=>{const{lng:a,lat:s}=e.lngLat,c=r.depthAt(a,s);c>.02&&w.ripple(a,s),window.dispatchEvent(new CustomEvent("ft:probe",{detail:{lng:a,lat:s,depth:c,point:e.point}}))});const $=new URLSearchParams(location.search).get("bare"),Y=$===null?1/0:Number($),X=t().features;let K=0;const G=[];for(const e of N)if(X[e.id]){if(K>=Y){console.log("[bare] skipping",e.id);continue}K++,G.push(h(e.id,!0))}return await Promise.all(G),w.setBands(t().bands,t().bandEdges()),w.setZoom(o.map.getZoom()),await _(0),L(),t().setPhase("ready"),t().setStatus("Ready"),window.__ftTwin={engine:o,sim:r,handles:v,applyStep:_,refreshDerived:f,store:W},{engine:o,sim:r,handles:v,jumpToDeepest(){const e=r.deepestPoint();return e?(o.map.flyTo({center:[e.lng,e.lat],zoom:17,pitch:55,duration:1500}),e):null},flyTo(e,a,s=16){o.map.flyTo({center:[e,a],zoom:s,duration:1200})},depthAt:(e,a)=>r.depthAt(e,a),destroy(){var e;I(),o.map.off("zoom",C),o.map.off("moveend",f);for(const a of Object.values(v))(e=a==null?void 0:a.dispose)==null||e.call(a);o.destroy()}}}const be=Object.freeze(Object.defineProperty({__proto__:null,startTwin:ve},Symbol.toStringTag,{value:"Module"}));export{ie as F,xe as a,ye as b,be as c};
