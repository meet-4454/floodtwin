const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/buildings-ciA3yO1o.js","assets/index-Diq9ICiP.js","assets/react-C4xND61i.js","assets/index-CxAslSmK.css","assets/three-ab00-b5W.js","assets/assetsLayer-Cq4CLCyL.js","assets/drainageViz-pCNgXv-H.js","assets/drainageAssets-BsIxy5dh.js"])))=>i.map(i=>d[i]);
import{G as ae,r as re,u as G,F as q,c as ne,D as ee,_ as V}from"./index-Diq9ICiP.js";import{T as se,M as H,V as j,C as oe,S as ie,A as ce,W as le}from"./three-ab00-b5W.js";const Y=28.4595,J=77.0266,ue=p=>`https://apis.mappls.com/advancedmaps/api/${encodeURIComponent(p)}/map_sdk?v=3.0&layer=vector`;function pe(p,t){return new Promise((o,s)=>{if(window.mappls&&typeof window.mappls.Map=="function")return o();if(!p)return s(new Error("Mappls API key not configured on the server (MAPPLS_API_KEY)."));let m=0;const f=3,h=()=>{m++;const c=document.createElement("script");c.src=ue(p),c.async=!0,c.onload=()=>{let l=0;const v=setInterval(()=>{window.mappls&&typeof window.mappls.Map=="function"?(clearInterval(v),o()):++l>100&&(clearInterval(v),s(new Error("Mappls SDK loaded but never exposed mappls.Map")))},100)},c.onerror=()=>{c.remove(),m<f?(t==null||t(`Map SDK unreachable — retrying (${m}/${f-1})…`),setTimeout(h,1500*m)):s(new Error("Map SDK failed to load. Check network / adblock / API key."))},document.head.appendChild(c)};h()})}const de=["Open Sans Regular"],Te=["Open Sans Bold"];function Ae(p,t,o){if((t==null?void 0:t.type)==="symbol"){const s=t.layout||(t.layout={});s["text-field"]&&!s["text-font"]&&(s["text-font"]=de)}return p.addLayer(t,o)}function fe(){var s;const p=(s=window.maplibregl)==null?void 0:s.MercatorCoordinate;if(p){const m=p.fromLngLat([J,Y],0);return{translateX:m.x,translateY:m.y,translateZ:m.z,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:m.meterInMercatorCoordinateUnits()}}const t=(J+180)/360,o=Math.sin(Y*Math.PI/180);return{translateX:t,translateY:.5-Math.log((1+o)/(1-o))/(4*Math.PI),translateZ:0,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:1/(2*Math.PI*6378137*Math.cos(Y*Math.PI/180))}}function me(p,t){var f;const o=(f=window.maplibregl)==null?void 0:f.MercatorCoordinate;if(o)return o.fromLngLat([p,t]);const s=(p+180)/360,m=Math.sin(t*Math.PI/180);return{x:s,y:.5-Math.log((1+m)/(1-m))/(4*Math.PI)}}async function he({container:p,mapplsKey:t,onStatus:o}){var P,k;o==null||o("Loading map SDK…"),await pe(t,o),o==null||o("Initialising map…");const s=typeof p=="string"?document.getElementById(p):p;if(!s)throw new Error(`Map container "${p}" is not in the document.`);if(window.__ftEngine&&window.__ftEngine!==null){try{(k=(P=window.__ftEngine).destroy)==null||k.call(P)}catch{}window.__ftEngine=null,window.__map=null}s.replaceChildren();const m={center:{lat:Y,lng:J},zoom:12.6,pitch:45,bearing:-12,zoomControl:!1,attributionControl:!1,fullscreenControl:!1,preserveDrawingBuffer:!0};let f;try{f=new window.mappls.Map(p,m)}catch(n){console.warn("[engine] map construction failed, clearing and retrying once:",n),s.replaceChildren();try{f=new window.mappls.Map(p,m)}catch(i){throw new Error(`The map could not be initialised (${i.message||i}). Reload the page.`)}}const h=fe(),l={THREE:se,map:f,toLocal:(n,i)=>{const u=me(n,i);return{x:(u.x-h.translateX)/h.scale,z:(u.y-h.translateY)/h.scale}},modelTransform:h,scene:null,camera:null,renderer:null,clock:0,layers:Object.create(null),tickers:new Set,stepHandlers:new Set,triggerRepaint:()=>{try{f.triggerRepaint()}catch{}},destroy:null},v={id:"ft-scene",type:"custom",renderingMode:"3d",onAdd(n,i){l.camera=new oe,l.scene=new ie,l.scene.add(new ce(16777215,1)),l.renderer=new le({canvas:n.getCanvas(),context:i,antialias:!0,preserveDrawingBuffer:!0}),l.renderer.autoClear=!1},render(n,i){var $,I,U;const u=h,A=new H().makeRotationAxis(new j(1,0,0),u.rotateX),E=new H().makeRotationAxis(new j(0,1,0),u.rotateY),L=new H().makeRotationAxis(new j(0,0,1),u.rotateZ),O=new H().fromArray(i),N=new H().makeTranslation(u.translateX,u.translateY,u.translateZ).scale(new j(u.scale,-u.scale,u.scale)).multiply(A).multiply(E).multiply(L);l.camera.projectionMatrix=O.multiply(N);const W=n.drawingBufferWidth,Z=n.drawingBufferHeight;l.renderer.setViewport(0,0,W,Z),l.renderer.resetState(),l.renderer.render(l.scene,l.camera),n.viewport(0,0,W,Z),(U=(I=($=f.painter)==null?void 0:$.context)==null?void 0:I.setDirty)==null||U.call(I)}},M=new URLSearchParams(location.search).get("nogl")==="1";await new Promise(n=>{let i=!1;const u=()=>{if(!i){if(i=!0,!M)try{f.addLayer(v)}catch(A){console.warn("custom layer add:",A)}n()}};f.on("load",u),f.on("style.load",u),setTimeout(u,6e3)});const z=1e3/30;let F=null,b=0,D=0,S=document.hidden;const T=()=>{S=document.hidden,b=0};document.addEventListener("visibilitychange",T);const w=n=>{if(F=requestAnimationFrame(w),S||!l.tickers.size){b=n;return}b||(b=n);const i=Math.min((n-b)/1e3,.05);if(b=n,D+=i*1e3,D<z)return;const u=D/1e3;D=0,l.clock+=u;for(const A of l.tickers)try{A(l.clock,u)}catch(E){console.warn(E)}l.triggerRepaint()};if(F=requestAnimationFrame(w),window.ResizeObserver){const n=typeof p=="string"?document.getElementById(p):p;if(n){let i=null,u=0,A=0;new ResizeObserver(E=>{var O;const L=(O=E[0])==null?void 0:O.contentRect;L&&Math.abs(L.width-u)<1&&Math.abs(L.height-A)<1||(L&&(u=L.width,A=L.height),!i&&(i=requestAnimationFrame(()=>{i=null;try{f.resize()}catch{}})))}).observe(n)}}let R=!1;return l.destroy=()=>{var n,i;if(!R){R=!0;try{cancelAnimationFrame(F)}catch{}try{document.removeEventListener("visibilitychange",T)}catch{}try{l.tickers.clear(),l.stepHandlers.clear()}catch{}try{(i=(n=l.renderer)==null?void 0:n.dispose)==null||i.call(n)}catch{}try{f.remove()}catch{}window.__ftEngine===l&&(window.__ftEngine=null,window.__map=null)}},window.__ftEngine=l,window.__map=f,l}function ge(p,{xray:t}){var s;const{map:o}=p;try{if(t&&!o.getLayer("xray-dim")&&(o.addSource("xray-dim-src",{type:"geojson",data:{type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[[[-179,-85],[179,-85],[179,85],[-179,85],[-179,-85]]]}}}),o.addLayer({id:"xray-dim",type:"fill",source:"xray-dim-src",paint:{"fill-color":"#0a1420","fill-opacity":0}})),!o.getLayer("xray-dim"))return;if(t){const m=((s=o.style)==null?void 0:s._order)||[];let f=null;for(const h of m){const c=o.getLayer(h);if(c&&c.type==="fill-extrusion"&&!/sea/i.test(h)){f=h;break}}f&&o.moveLayer("xray-dim",f)}o.setPaintProperty("xray-dim","fill-opacity",t?.6:0)}catch(m){console.warn("layer order:",m)}}const ve=192,we=`
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
}`,ye=`
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

${ae}

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
}`;function xe(p,t){const{THREE:o,scene:s,toLocal:m}=p,f=t.state.man,h=f.grid_n,c=f.grid_bbox,l=ve,v=(l+1)*(l+1),M=new Float32Array(v*3),g=new Float32Array(v*2);let z=0,F=0;for(let n=0;n<=l;n++)for(let i=0;i<=l;i++){const u=m(c[0]+i/l*(c[2]-c[0]),c[1]+n/l*(c[3]-c[1]));M[z++]=u.x,M[z++]=0,M[z++]=u.z,g[F++]=i/l,g[F++]=n/l}const b=new Uint32Array(l*l*6);let D=0;for(let n=0;n<l;n++)for(let i=0;i<l;i++){const u=n*(l+1)+i,A=u+1,E=u+(l+1),L=E+1;b[D++]=u,b[D++]=E,b[D++]=A,b[D++]=A,b[D++]=E,b[D++]=L}const S=new o.BufferGeometry;S.setAttribute("position",new o.BufferAttribute(M,3)),S.setAttribute("uv",new o.BufferAttribute(g,2)),S.setIndex(new o.BufferAttribute(b,1)),(!t.state.grid||t.state.grid.length!==h*h)&&(t.state.grid=new Float32Array(h*h));const T=new o.DataTexture(t.state.grid,h,h,o.LuminanceFormat,o.FloatType);T.minFilter=o.LinearFilter,T.magFilter=o.LinearFilter,T.needsUpdate=!0;const w=new o.ShaderMaterial({uniforms:{uTime:{value:0},uOpacity:{value:.78},uMaxDepth:{value:t.maxDepthScale},uDepthTex:{value:T},uTexelSize:{value:new o.Vector2(1/h,1/h)},uBlur:{value:1},uWetMin:{value:.01},uWaveAmp:{value:.18},uDepthHeight:{value:.45},uBandOn:{value:new o.Vector4(1,1,1,1)},uBandEdge:{value:new o.Vector3(.2,.6,1.2)},uRipple0:{value:new o.Vector3(0,0,-1)},uRipple1:{value:new o.Vector3(0,0,-1)},uRipple2:{value:new o.Vector3(0,0,-1)},uRipple3:{value:new o.Vector3(0,0,-1)},...re(o)},vertexShader:we,fragmentShader:ye,transparent:!0,side:o.DoubleSide,depthWrite:!1,extensions:{derivatives:!0}}),R=new o.Mesh(S,w);R.frustumCulled=!1,R.renderOrder=0,s.add(R);let P=0;const k=n=>{w.uniforms.uTime.value=n};return p.tickers.add(k),{mesh:R,mat:w,tex:T,setVisible(n){R.visible=n,p.triggerRepaint()},setOpacity(n){w.uniforms.uOpacity.value=n,p.triggerRepaint()},setZoom(n){const i=n>=16?1:n>=14?1.5:n>=12.5?2.2:n>=11?3:4,u=n>=15?.01:n>=13?.022:n>=11.5?.038:.055;(Math.abs(i-w.uniforms.uBlur.value)>.01||Math.abs(u-w.uniforms.uWetMin.value)>1e-4)&&(w.uniforms.uBlur.value=i,w.uniforms.uWetMin.value=u,p.triggerRepaint())},refresh(){T.needsUpdate=!0,w.uniforms.uMaxDepth.value=t.maxDepthScale,p.triggerRepaint()},setBands(n,i){w.uniforms.uBandOn.value.set(n[0]?1:0,n[1]?1:0,n[2]?1:0,n[3]?1:0),i&&w.uniforms.uBandEdge.value.set(i[0],i[1],i[2]),p.triggerRepaint()},ripple(n,i){const u=m(n,i);w.uniforms[`uRipple${P}`].value.set(u.x,u.z,w.uniforms.uTime.value),P=(P+1)%4,p.triggerRepaint()},dispose(){p.tickers.delete(k),s.remove(R),S.dispose(),w.dispose(),T.dispose()}}}async function be({container:p}){const t=G.getState;t().setStatus("Starting…");const o=fetch("/api/config").then(e=>e.ok?e.json():{}).catch(()=>({})),s=ne(),m=s.loadManifest("event"),f=fetch("/sim/surface_grid_00.bin").catch(()=>null),h=await o;t().setStatus("Loading map…");const[c,l]=await Promise.all([he({container:p,mapplsKey:h.mapplsApiKey,onStatus:e=>t().setStatus(e)}),m]);t().setTimeline(l,"event"),t().setStatus("Building flood surface…"),await f,await s.useFrame(0);const v=xe(c,s);c.layers.flood=v,t().setMaxDepth(s.maxDepthScale),v.setOpacity(t().opacity);const M=new Map,g=c.layers,z="ft_stale_build_reloaded",F=e=>{const a=`${(e==null?void 0:e.message)||e}`;return/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(a)},b=(e,a)=>{if(M.has(e))return M.get(e);t().setFeatureStatus(e,"loading");const r=Promise.resolve().then(a).then(d=>(g[e]=d,sessionStorage.removeItem(z),t().setFeatureStatus(e,"ready"),d)).catch(d=>{if(console.warn(`[feature ${e}]`,d),F(d)&&!sessionStorage.getItem(z)){sessionStorage.setItem(z,"1"),t().setStatus("A newer build is live — reloading…"),window.location.reload();return}throw t().setFeatureStatus(e,"error",d.message||String(d)),M.delete(e),d});return M.set(e,r),r},D={flood:async()=>v,wards:async()=>{const{createWards:e}=await V(async()=>{const{createWards:a}=await import("./buildings-ciA3yO1o.js");return{createWards:a}},__vite__mapDeps([0,1,2,3,4]));return e(c)},buildings:async()=>{const{createBuildings:e}=await V(async()=>{const{createBuildings:a}=await import("./buildings-ciA3yO1o.js");return{createBuildings:a}},__vite__mapDeps([0,1,2,3,4]));return e(c)},assets:async()=>{const{createAssetsLayer:e}=await V(async()=>{const{createAssetsLayer:r}=await import("./assetsLayer-Cq4CLCyL.js");return{createAssetsLayer:r}},__vite__mapDeps([5,1,2,3,4])),a=await e(c,{onDepthAt:(r,d)=>s.depthAt(r,d),onCounts:r=>t().setAssetCounts(r)});for(const r of q.find(d=>d.id==="assets").children)a.setCategory(r.id,!!t().features[`assets.${r.id}`]);return a},sewer:async()=>{const{createSewerLayer:e}=await V(async()=>{const{createSewerLayer:r}=await import("./sewerLayer-CWO48TAB.js");return{createSewerLayer:r}},[]),a=await e(c);return t().setSewerStats(a.stats),a},roads:async()=>{const{createRoadsLayer:e}=await V(async()=>{const{createRoadsLayer:a}=await import("./roadsLayer-R7LV1nff.js");return{createRoadsLayer:a}},[]);return e(c,{depthAt:(a,r)=>s.depthAtSmooth(a,r),onSegments:a=>t().setRoadSegments(a)})},drainage:async()=>{t().setStatus("Loading drainage network…");const e=s.loadGeometry(),a=V(()=>import("./drainageViz-pCNgXv-H.js"),__vite__mapDeps([6,1,2,3])),r=V(()=>import("./drainageAssets-BsIxy5dh.js"),__vite__mapDeps([7,1,2,3,4])),d=s.fetchHour(t().step).catch(()=>null),[x,{createDrainageViz:_}]=await Promise.all([e,a]);t().setStatus("Building 139,798 conduits…"),await new Promise(C=>requestAnimationFrame(C));const y=_(c,x);y.setZoom(c.map.getZoom());const B=await d;B&&y.updateHour(B,x.nodeMax,s.state.man.depth_scale,s.state.man.flow_scale);const{createDrainageAssets:te}=await r,X=te(c,{depthAt:(C,K)=>s.depthAt(C,K),onReady:C=>{t().setDrainStats({links:y.links,chains:y.chains,tiers:y.tierCount,classes:y.classCount,...C.stats});const K=s.state.hourCache.get(t().step);K&&(C.updateFrame(K,x),t().setSurcharged(C.surchargedCount))}});return g.drainAssets=X,t().setDrainStats({links:y.links,chains:y.chains,tiers:y.tierCount,classes:y.classCount}),B&&(X.updateFrame(B,x),t().setSurcharged(X.surchargedCount)),y}};function S(){const e=t().features;ge(c,{xray:!!e.xray})}async function T(e,a){var r,d;switch(e){case"flood":v.setVisible(a);break;case"hotspots":a?i():t().setHotspots([]);break;case"xray":S();break;case"terrain":try{c.map.easeTo({pitch:a?55:0,duration:700})}catch{}break;default:{if(!D[e]||!a&&!M.has(e))return;let x;try{x=await b(e,D[e])}catch{return}(r=x.setVisible)==null||r.call(x,a),e==="drainage"&&((d=g.drainAssets)==null||d.setVisible(a),w()),e==="assets"&&R();break}}S()}function w(){const e=g.drainage,a=g.drainAssets,r=t().features;if(!e)return;const d={storm:0,sewer:1,unclass:2};for(const[_,y]of Object.entries(d))e.setClass(y,!!r[`drainage.${_}`]);const x={trunk:0,main:1,lateral:2};for(const[_,y]of Object.entries(x)){const B=r[`drainage.${_}`];e.setTier(y,B==="auto"?null:!!B)}for(const _ of["water","shafts"])e.setLayer(_,!!r[`drainage.${_}`]);if(e.setMode(r["drainage.capacity"]?"capacity":"water"),a)for(const _ of["surcharge","inlets","outfalls","pumps"])a.setLayer(_,!!r[`drainage.${_}`])}function R(){const e=g.assets;if(e)for(const a of q.find(r=>r.id==="assets").children)e.setCategory(a.id,!!t().features[`assets.${a.id}`])}let P=0;async function k(e){var d,x,_;const a=++P;if(await s.useFrame(e),a!==P)return;v.refresh(),t().setKpi(s.frameStats());const r=s.maxDepthScale;if(Math.abs(r-t().maxDepth)>.001&&(t().setMaxDepth(r),(d=g.drainage)==null||d.setMaxDepth(r),v.setBands(t().bands,t().bandEdges())),g.drainage||g.drainAssets){const y=await s.fetchHour(e);if(a!==P||!y)return;const B=s.state.geom;(x=g.drainage)==null||x.updateHour(y,B.nodeMax,s.state.man.depth_scale,s.state.man.flow_scale),g.drainAssets&&(g.drainAssets.updateFrame(y,B),t().setSurcharged(g.drainAssets.surchargedCount))}(_=g.roads)==null||_.refresh(),i()}let n=null;function i(){clearTimeout(n),n=setTimeout(()=>{var e,a;try{if(t().setKpi(s.frameStats()),!t().features.hotspots)return;const r=(a=(e=c.map).getBounds)==null?void 0:a.call(e),d=r?{s:r.getSouth(),w:r.getWest(),n:r.getNorth(),e:r.getEast()}:null;t().setHotspots(s.hotspots({bounds:d,limit:8,minSepDeg:.006}))}catch(r){console.warn("[derived read-outs]",r)}},200)}let u=null;async function A(e){var a,r;if(!(e===s.state.dataset||u===e)){u=e;try{t().setStatus(`Loading ${((a=ee[e])==null?void 0:a.label)||e}…`);const d=await s.loadManifest(e);t().setTimeline(d,e);const x=Math.min(t().step,Math.max(0,d.n_hours-1));G.setState({step:x}),await k(x),t().setStatus("Ready")}catch(d){console.warn("[dataset]",d),t().setStatus(`Could not load ${((r=ee[e])==null?void 0:r.label)||e}`)}finally{u=null}}}let E=t();const L=G.subscribe(e=>{const a=E;if(E=e,e.features!==a.features){for(const r of Object.keys(e.features))if(e.features[r]!==a.features[r])if(r.includes(".")){const[d]=r.split(".");d==="drainage"?w():d==="assets"&&R()}else T(r,e.features[r])}e.dataset!==a.dataset?A(e.dataset):e.step!==a.step&&k(e.step),e.opacity!==a.opacity&&v.setOpacity(e.opacity),(e.bands!==a.bands||e.maxDepth!==a.maxDepth)&&v.setBands(e.bands,t().bandEdges())});let O=null;const N=()=>{O||(O=requestAnimationFrame(()=>{var a;O=null;const e=c.map.getZoom();(a=g.drainage)==null||a.setZoom(e),v.setZoom(e)}))};c.map.on("zoom",N),c.map.on("moveend",i),c.map.on("click",e=>{const{lng:a,lat:r}=e.lngLat,d=s.depthAt(a,r);d>.02&&v.ripple(a,r),window.dispatchEvent(new CustomEvent("ft:probe",{detail:{lng:a,lat:r,depth:d,point:e.point}}))});const W=new URLSearchParams(location.search).get("bare"),Z=W===null?1/0:Number(W),$=t().features;let I=0;const U=[];for(const e of q)if($[e.id]){if(I>=Z){console.log("[bare] skipping",e.id);continue}I++,U.push(T(e.id,!0))}await Promise.all(U),v.setBands(t().bands,t().bandEdges()),v.setZoom(c.map.getZoom()),await k(0),S(),t().setPhase("ready"),t().setStatus("Ready"),window.__ftTwin={engine:c,sim:s,handles:g,applyStep:k,refreshDerived:i,store:G};let Q=!1;return{engine:c,sim:s,handles:g,jumpToDeepest(){const e=s.deepestPoint();return e?(c.map.flyTo({center:[e.lng,e.lat],zoom:17,pitch:55,duration:1500}),e):null},flyTo(e,a,r=16){c.map.flyTo({center:[e,a],zoom:r,duration:1200})},depthAt:(e,a)=>s.depthAt(e,a),destroy(){var e;if(!Q){Q=!0;try{L()}catch{}try{c.map.off("zoom",N)}catch{}try{c.map.off("moveend",i)}catch{}for(const a of Object.values(g))try{(e=a==null?void 0:a.dispose)==null||e.call(a)}catch(r){console.warn("[twin] dispose failed",r)}try{c.destroy()}catch(a){console.warn("[twin] engine destroy failed",a)}}}}}const Me=Object.freeze(Object.defineProperty({__proto__:null,startTwin:be},Symbol.toStringTag,{value:"Module"}));export{de as F,Ae as a,Te as b,Me as c};
