const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/buildings-CtxGT0Xa.js","assets/index-CcWu-Qb3.js","assets/react-C4xND61i.js","assets/index-KL9gymwl.css","assets/three-ab00-b5W.js","assets/assetsLayer-DMa-Dwd2.js","assets/drainageViz-Doh0kHjy.js","assets/drainageAssets-9Hmr7evM.js"])))=>i.map(i=>d[i]);
import{G as pe,r as fe,u as U,F as J,c as me,D as oe,_ as O}from"./index-CcWu-Qb3.js";import{T as he,M as Z,V as j,C as ve,S as ge,A as we,W as ye}from"./three-ab00-b5W.js";const Y=28.4595,Q=77.0266,xe=c=>`https://apis.mappls.com/advancedmaps/api/${encodeURIComponent(c)}/map_sdk?v=3.0&layer=vector`,ee=()=>!!(window.mappls&&typeof window.mappls.Map=="function");function ie(c=1e4){return new Promise((t,o)=>{if(ee())return t();const n=Date.now(),v=setInterval(()=>{ee()?(clearInterval(v),t()):Date.now()-n>c&&(clearInterval(v),o(new Error("Mappls SDK loaded but never exposed mappls.Map")))},25)})}let $=null;function be(c,t){return ee()?Promise.resolve():$||($=new Promise((o,n)=>{const v=document.getElementById("ft-mappls-sdk");if(v){ie(15e3).then(o,()=>{v.remove(),h()});return}h();function h(){if(!c){n(new Error("Mappls API key not configured on the server (MAPPLS_API_KEY)."));return}let f=0;const x=3,i=()=>{f++;const T=document.createElement("script");T.src=xe(c),T.async=!0,T.onload=()=>ie().then(o,n),T.onerror=()=>{T.remove(),f<x?(t==null||t(`Map SDK unreachable — retrying (${f}/${x-1})…`),setTimeout(i,1500*f)):n(new Error("Map SDK failed to load. Check network / adblock / API key."))},document.head.appendChild(T)};i()}}).catch(o=>{throw $=null,o}),$)}const _e=["Open Sans Regular"],Fe=["Open Sans Bold"];function ze(c,t,o){if((t==null?void 0:t.type)==="symbol"){const n=t.layout||(t.layout={});n["text-field"]&&!n["text-font"]&&(n["text-font"]=_e)}return c.addLayer(t,o)}function De(){var n;const c=(n=window.maplibregl)==null?void 0:n.MercatorCoordinate;if(c){const v=c.fromLngLat([Q,Y],0);return{translateX:v.x,translateY:v.y,translateZ:v.z,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:v.meterInMercatorCoordinateUnits()}}const t=(Q+180)/360,o=Math.sin(Y*Math.PI/180);return{translateX:t,translateY:.5-Math.log((1+o)/(1-o))/(4*Math.PI),translateZ:0,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:1/(2*Math.PI*6378137*Math.cos(Y*Math.PI/180))}}function Te(c,t){var h;const o=(h=window.maplibregl)==null?void 0:h.MercatorCoordinate;if(o)return o.fromLngLat([c,t]);const n=(c+180)/360,v=Math.sin(t*Math.PI/180);return{x:n,y:.5-Math.log((1+v)/(1-v))/(4*Math.PI)}}async function Se({container:c,mapplsKey:t,onStatus:o}){var k,F;o==null||o("Loading map SDK…"),await be(t,o),o==null||o("Initialising map…");const n=typeof c=="string"?document.getElementById(c):c;if(!n)throw new Error(`Map container "${c}" is not in the document.`);if(window.__ftEngine&&window.__ftEngine!==null){try{(F=(k=window.__ftEngine).destroy)==null||F.call(k)}catch{}window.__ftEngine=null,window.__map=null}n.replaceChildren();const v={center:{lat:Y,lng:Q},zoom:12.6,pitch:45,bearing:-12,zoomControl:!1,attributionControl:!1,fullscreenControl:!1,preserveDrawingBuffer:!0};let h;try{h=new window.mappls.Map(c,v)}catch(s){console.warn("[engine] map construction failed, clearing and retrying once:",s),n.replaceChildren();try{h=new window.mappls.Map(c,v)}catch(l){throw new Error(`The map could not be initialised (${l.message||l}). Reload the page.`)}}const f=De(),i={THREE:he,map:h,toLocal:(s,l)=>{const u=Te(s,l);return{x:(u.x-f.translateX)/f.scale,z:(u.y-f.translateY)/f.scale}},modelTransform:f,scene:null,camera:null,renderer:null,clock:0,layers:Object.create(null),tickers:new Set,stepHandlers:new Set,triggerRepaint:()=>{try{h.triggerRepaint()}catch{}},destroy:null},T={id:"ft-scene",type:"custom",renderingMode:"3d",onAdd(s,l){i.camera=new ve,i.scene=new ge,i.scene.add(new we(16777215,1)),i.renderer=new ye({canvas:s.getCanvas(),context:l,antialias:!0,preserveDrawingBuffer:!0}),i.renderer.autoClear=!1},render(s,l){var H,N,W;const u=f,S=new Z().makeRotationAxis(new j(1,0,0),u.rotateX),L=new Z().makeRotationAxis(new j(0,1,0),u.rotateY),A=new Z().makeRotationAxis(new j(0,0,1),u.rotateZ),z=new Z().fromArray(l),X=new Z().makeTranslation(u.translateX,u.translateY,u.translateZ).scale(new j(u.scale,-u.scale,u.scale)).multiply(S).multiply(L).multiply(A);i.camera.projectionMatrix=z.multiply(X);const V=s.drawingBufferWidth,G=s.drawingBufferHeight;i.renderer.setViewport(0,0,V,G),i.renderer.resetState(),i.renderer.render(i.scene,i.camera),s.viewport(0,0,V,G),(W=(N=(H=h.painter)==null?void 0:H.context)==null?void 0:N.setDirty)==null||W.call(N)}},P=new URLSearchParams(location.search).get("nogl")==="1";await new Promise(s=>{let l=!1;const u=()=>{if(!l){if(l=!0,!P)try{h.addLayer(T)}catch(S){console.warn("custom layer add:",S)}s()}};h.on("load",u),h.on("style.load",u),setTimeout(u,6e3)});const p=1e3/30;let b=null,w=0,m=0,M=document.hidden;const R=()=>{M=document.hidden,w=0};document.addEventListener("visibilitychange",R);const _=s=>{if(b=requestAnimationFrame(_),M||!i.tickers.size){w=s;return}w||(w=s);const l=Math.min((s-w)/1e3,.05);if(w=s,m+=l*1e3,m<p)return;const u=m/1e3;m=0,i.clock+=u;for(const S of i.tickers)try{S(i.clock,u)}catch(L){console.warn(L)}i.triggerRepaint()};if(b=requestAnimationFrame(_),window.ResizeObserver){const s=typeof c=="string"?document.getElementById(c):c;if(s){let l=null,u=0,S=0;new ResizeObserver(L=>{var z;const A=(z=L[0])==null?void 0:z.contentRect;A&&Math.abs(A.width-u)<1&&Math.abs(A.height-S)<1||(A&&(u=A.width,S=A.height),!l&&(l=requestAnimationFrame(()=>{l=null;try{h.resize()}catch{}})))}).observe(s)}}let E=!1;return i.destroy=()=>{var s,l;if(!E){E=!0;try{cancelAnimationFrame(b)}catch{}try{document.removeEventListener("visibilitychange",R)}catch{}try{i.tickers.clear(),i.stepHandlers.clear()}catch{}try{(l=(s=i.renderer)==null?void 0:s.dispose)==null||l.call(s)}catch{}try{h.remove()}catch{}window.__ftEngine===i&&(window.__ftEngine=null,window.__map=null)}},window.__ftEngine=i,window.__map=h,i}function Ae(c,{xray:t}){var n;const{map:o}=c;try{if(t&&!o.getLayer("xray-dim")&&(o.addSource("xray-dim-src",{type:"geojson",data:{type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[[[-179,-85],[179,-85],[179,85],[-179,85],[-179,-85]]]}}}),o.addLayer({id:"xray-dim",type:"fill",source:"xray-dim-src",paint:{"fill-color":"#0a1420","fill-opacity":0}})),!o.getLayer("xray-dim"))return;if(t){const v=((n=o.style)==null?void 0:n._order)||[];let h=null;for(const f of v){const x=o.getLayer(f);if(x&&x.type==="fill-extrusion"&&!/sea/i.test(f)){h=f;break}}h&&o.moveLayer("xray-dim",h)}o.setPaintProperty("xray-dim","fill-opacity",t?.6:0)}catch(v){console.warn("layer order:",v)}}const Me=192,Re=`
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
}`,Ee=`
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

${pe}

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
}`;function Le(c,t){const{THREE:o,scene:n,toLocal:v}=c,h=t.state.man,f=h.grid_n,x=h.grid_bbox,i=Me,T=(i+1)*(i+1),P=new Float32Array(T*3),C=new Float32Array(T*2);let p=0,b=0;for(let s=0;s<=i;s++)for(let l=0;l<=i;l++){const u=v(x[0]+l/i*(x[2]-x[0]),x[1]+s/i*(x[3]-x[1]));P[p++]=u.x,P[p++]=0,P[p++]=u.z,C[b++]=l/i,C[b++]=s/i}const w=new Uint32Array(i*i*6);let m=0;for(let s=0;s<i;s++)for(let l=0;l<i;l++){const u=s*(i+1)+l,S=u+1,L=u+(i+1),A=L+1;w[m++]=u,w[m++]=L,w[m++]=S,w[m++]=S,w[m++]=L,w[m++]=A}const M=new o.BufferGeometry;M.setAttribute("position",new o.BufferAttribute(P,3)),M.setAttribute("uv",new o.BufferAttribute(C,2)),M.setIndex(new o.BufferAttribute(w,1)),(!t.state.grid||t.state.grid.length!==f*f)&&(t.state.grid=new Float32Array(f*f));const R=new o.DataTexture(t.state.grid,f,f,o.LuminanceFormat,o.FloatType);R.minFilter=o.LinearFilter,R.magFilter=o.LinearFilter,R.needsUpdate=!0;const _=new o.ShaderMaterial({uniforms:{uTime:{value:0},uOpacity:{value:.78},uMaxDepth:{value:t.maxDepthScale},uDepthTex:{value:R},uTexelSize:{value:new o.Vector2(1/f,1/f)},uBlur:{value:1},uWetMin:{value:.01},uWaveAmp:{value:.18},uDepthHeight:{value:.45},uBandOn:{value:new o.Vector4(1,1,1,1)},uBandEdge:{value:new o.Vector3(.2,.6,1.2)},uRipple0:{value:new o.Vector3(0,0,-1)},uRipple1:{value:new o.Vector3(0,0,-1)},uRipple2:{value:new o.Vector3(0,0,-1)},uRipple3:{value:new o.Vector3(0,0,-1)},...fe(o)},vertexShader:Re,fragmentShader:Ee,transparent:!0,side:o.DoubleSide,depthWrite:!1,extensions:{derivatives:!0}}),E=new o.Mesh(M,_);E.frustumCulled=!1,E.renderOrder=0,n.add(E);let k=0;const F=s=>{_.uniforms.uTime.value=s};return c.tickers.add(F),{mesh:E,mat:_,tex:R,setVisible(s){E.visible=s,c.triggerRepaint()},setOpacity(s){_.uniforms.uOpacity.value=s,c.triggerRepaint()},setZoom(s){const l=s>=16?1:s>=14?1.5:s>=12.5?2.2:s>=11?3:4,u=s>=15?.01:s>=13?.022:s>=11.5?.038:.055;(Math.abs(l-_.uniforms.uBlur.value)>.01||Math.abs(u-_.uniforms.uWetMin.value)>1e-4)&&(_.uniforms.uBlur.value=l,_.uniforms.uWetMin.value=u,c.triggerRepaint())},refresh(){R.needsUpdate=!0,_.uniforms.uMaxDepth.value=t.maxDepthScale,c.triggerRepaint()},setBands(s,l){_.uniforms.uBandOn.value.set(s[0]?1:0,s[1]?1:0,s[2]?1:0,s[3]?1:0),l&&_.uniforms.uBandEdge.value.set(l[0],l[1],l[2]),c.triggerRepaint()},ripple(s,l){const u=v(s,l);_.uniforms[`uRipple${k}`].value.set(u.x,u.z,_.uniforms.uTime.value),k=(k+1)%4,c.triggerRepaint()},dispose(){c.tickers.delete(F),n.remove(E),M.dispose(),_.dispose(),R.dispose()}}}function ce(c){var h;const t=c==null?void 0:c.frames;if(!Array.isArray(t)||!t.length)return 0;const o=Date.now();let n=0,v=1/0;for(let f=0;f<t.length;f++){const x=Date.parse(((h=t[f])==null?void 0:h.valid_at)||"");if(Number.isNaN(x))continue;const i=Math.abs(x-o);i<v&&(v=i,n=f)}return n}async function Pe({container:c}){const t=U.getState;t().setStatus("Starting…");const o=window.__FT_CONFIG?Promise.resolve(window.__FT_CONFIG):fetch("/api/config").then(e=>e.ok?e.json():{}).catch(()=>({})),n=me(),v=n.loadManifest("live").then(e=>({id:"live",m:e}),()=>null),h=await o;t().setStatus("Loading map…");const f=Se({container:c,mapplsKey:h.mapplsApiKey,onStatus:e=>t().setStatus(e)}),x=await v;let i,T;x?{m:i,id:T}=x:(i=await n.loadManifest("event"),T="event"),t().setTimeline(i,T);const P=T==="live"?ce(i):0;U.setState({dataset:T,step:P});const C=n.useFrame(P),p=await f;t().setStatus("Building flood surface…"),await C;const b=Le(p,n);p.layers.flood=b,t().setMaxDepth(n.maxDepthScale),b.setOpacity(t().opacity);const w=new Map,m=p.layers,M="ft_stale_build_reloaded",R=e=>{const a=`${(e==null?void 0:e.message)||e}`;return/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(a)},_=(e,a)=>{if(w.has(e))return w.get(e);t().setFeatureStatus(e,"loading");const r=Promise.resolve().then(a).then(d=>(m[e]=d,sessionStorage.removeItem(M),t().setFeatureStatus(e,"ready"),d)).catch(d=>{if(console.warn(`[feature ${e}]`,d),R(d)&&!sessionStorage.getItem(M)){sessionStorage.setItem(M,"1"),t().setStatus("A newer build is live — reloading…"),window.location.reload();return}throw t().setFeatureStatus(e,"error",d.message||String(d)),w.delete(e),d});return w.set(e,r),r},E={flood:async()=>b,wards:async()=>{const{createWards:e}=await O(async()=>{const{createWards:a}=await import("./buildings-CtxGT0Xa.js");return{createWards:a}},__vite__mapDeps([0,1,2,3,4]));return e(p)},buildings:async()=>{const{createBuildings:e}=await O(async()=>{const{createBuildings:a}=await import("./buildings-CtxGT0Xa.js");return{createBuildings:a}},__vite__mapDeps([0,1,2,3,4]));return e(p)},assets:async()=>{const{createAssetsLayer:e}=await O(async()=>{const{createAssetsLayer:r}=await import("./assetsLayer-DMa-Dwd2.js");return{createAssetsLayer:r}},__vite__mapDeps([5,1,2,3,4])),a=await e(p,{onDepthAt:(r,d)=>n.depthAt(r,d),onCounts:r=>t().setAssetCounts(r)});for(const r of J.find(d=>d.id==="assets").children)a.setCategory(r.id,!!t().features[`assets.${r.id}`]);return a},sewer:async()=>{const{createSewerLayer:e}=await O(async()=>{const{createSewerLayer:r}=await import("./sewerLayer-CWO48TAB.js");return{createSewerLayer:r}},[]),a=await e(p);return t().setSewerStats(a.stats),a},roads:async()=>{const{createRoadsLayer:e}=await O(async()=>{const{createRoadsLayer:a}=await import("./roadsLayer-R7LV1nff.js");return{createRoadsLayer:a}},[]);return e(p,{depthAt:(a,r)=>n.depthAtSmooth(a,r),onSegments:a=>t().setRoadSegments(a)})},drainage:async()=>{t().setStatus("Loading drainage network…");const e=n.loadGeometry(),a=O(()=>import("./drainageViz-Doh0kHjy.js"),__vite__mapDeps([6,1,2,3])),r=O(()=>import("./drainageAssets-9Hmr7evM.js"),__vite__mapDeps([7,1,2,3,4])),d=n.fetchHour(t().step).catch(()=>null),[y,{createDrainageViz:D}]=await Promise.all([e,a]);t().setStatus("Building 139,798 conduits…"),await new Promise(I=>requestAnimationFrame(I));const g=D(p,y);g.setZoom(p.map.getZoom());const B=await d;B&&g.updateHour(B,y.nodeMax,n.state.man.depth_scale,n.state.man.flow_scale);const{createDrainageAssets:de}=await r,q=de(p,{depthAt:(I,K)=>n.depthAt(I,K),onReady:I=>{t().setDrainStats({links:g.links,chains:g.chains,tiers:g.tierCount,classes:g.classCount,...I.stats});const K=n.state.hourCache.get(t().step);K&&(I.updateFrame(K,y),t().setSurcharged(I.surchargedCount))}});return m.drainAssets=q,t().setDrainStats({links:g.links,chains:g.chains,tiers:g.tierCount,classes:g.classCount}),B&&(q.updateFrame(B,y),t().setSurcharged(q.surchargedCount)),g}};function k(){const e=t().features;Ae(p,{xray:!!e.xray})}async function F(e,a){var r,d;switch(e){case"flood":b.setVisible(a);break;case"hotspots":a?A():t().setHotspots([]);break;case"xray":k();break;case"terrain":try{p.map.easeTo({pitch:a?55:0,duration:700})}catch{}break;default:{if(!E[e]||!a&&!w.has(e))return;let y;try{y=await _(e,E[e])}catch{return}(r=y.setVisible)==null||r.call(y,a),e==="drainage"&&((d=m.drainAssets)==null||d.setVisible(a),s()),e==="assets"&&l();break}}k()}function s(){const e=m.drainage,a=m.drainAssets,r=t().features;if(!e)return;const d={storm:0,sewer:1,unclass:2};for(const[D,g]of Object.entries(d))e.setClass(g,!!r[`drainage.${D}`]);const y={trunk:0,main:1,lateral:2};for(const[D,g]of Object.entries(y)){const B=r[`drainage.${D}`];e.setTier(g,B==="auto"?null:!!B)}for(const D of["water","shafts"])e.setLayer(D,!!r[`drainage.${D}`]);if(e.setMode(r["drainage.capacity"]?"capacity":"water"),a)for(const D of["surcharge","inlets","outfalls","pumps"])a.setLayer(D,!!r[`drainage.${D}`])}function l(){const e=m.assets;if(e)for(const a of J.find(r=>r.id==="assets").children)e.setCategory(a.id,!!t().features[`assets.${a.id}`])}let u=0;async function S(e){var d,y,D;const a=++u;if(await n.useFrame(e),a!==u)return;b.refresh(),t().setKpi(n.frameStats());const r=n.maxDepthScale;if(Math.abs(r-t().maxDepth)>.001&&(t().setMaxDepth(r),(d=m.drainage)==null||d.setMaxDepth(r),b.setBands(t().bands,t().bandEdges())),m.drainage||m.drainAssets){const g=await n.fetchHour(e);if(a!==u||!g)return;const B=n.state.geom;(y=m.drainage)==null||y.updateHour(g,B.nodeMax,n.state.man.depth_scale,n.state.man.flow_scale),m.drainAssets&&(m.drainAssets.updateFrame(g,B),t().setSurcharged(m.drainAssets.surchargedCount))}(D=m.roads)==null||D.refresh(),A()}let L=null;function A(){clearTimeout(L),L=setTimeout(()=>{var e,a;try{if(t().setKpi(n.frameStats()),!t().features.hotspots)return;const r=(a=(e=p.map).getBounds)==null?void 0:a.call(e),d=r?{s:r.getSouth(),w:r.getWest(),n:r.getNorth(),e:r.getEast()}:null;t().setHotspots(n.hotspots({bounds:d,limit:8,minSepDeg:.006}))}catch(r){console.warn("[derived read-outs]",r)}},200)}let z=null;async function X(e){var a,r;if(!(e===n.state.dataset||z===e)){z=e;try{t().setStatus(`Loading ${((a=oe[e])==null?void 0:a.label)||e}…`);const d=await n.loadManifest(e);t().setTimeline(d,e);const y=Math.min(t().step,Math.max(0,d.n_hours-1));U.setState({step:y}),await S(y),t().setStatus("Ready")}catch(d){console.warn("[dataset]",d),t().setStatus(`Could not load ${((r=oe[e])==null?void 0:r.label)||e}`)}finally{z=null}}}let V=!1;async function G(e){var d,y;const a=(d=e==null?void 0:e.built)==null?void 0:d.run_id;if(!a||V||t().dataset!=="live"||n.state.dataset!=="live")return;const r=(y=n.state.man)==null?void 0:y.run_id;if(!(!r||r===a)){V=!0;try{t().setStatus("A newer forecast run is live — resyncing…");const D=await n.loadManifest("live");t().setTimeline(D,"live");const g=ce(D);U.setState({step:g}),await S(g),t().setStatus("Ready")}catch(D){console.warn("[live resync]",D),t().setStatus("Ready")}finally{V=!1}}}let H=t();const N=U.subscribe(e=>{const a=H;if(H=e,e.features!==a.features){for(const r of Object.keys(e.features))if(e.features[r]!==a.features[r])if(r.includes(".")){const[d]=r.split(".");d==="drainage"?s():d==="assets"&&l()}else F(r,e.features[r])}e.dataset!==a.dataset?X(e.dataset):e.step!==a.step&&S(e.step),e.runStatus!==a.runStatus&&G(e.runStatus),e.opacity!==a.opacity&&b.setOpacity(e.opacity),(e.bands!==a.bands||e.maxDepth!==a.maxDepth)&&b.setBands(e.bands,t().bandEdges())});let W=null;const te=()=>{W||(W=requestAnimationFrame(()=>{var a;W=null;const e=p.map.getZoom();(a=m.drainage)==null||a.setZoom(e),b.setZoom(e)}))};p.map.on("zoom",te),p.map.on("moveend",A),p.map.on("click",e=>{const{lng:a,lat:r}=e.lngLat,d=n.depthAt(a,r);d>.02&&b.ripple(a,r),window.dispatchEvent(new CustomEvent("ft:probe",{detail:{lng:a,lat:r,depth:d,point:e.point}}))});const ae=new URLSearchParams(location.search).get("bare"),le=ae===null?1/0:Number(ae),ue=t().features;let re=0;const ne=[];for(const e of J)if(ue[e.id]){if(re>=le){console.log("[bare] skipping",e.id);continue}re++,ne.push(F(e.id,!0))}await Promise.all(ne),b.setBands(t().bands,t().bandEdges()),b.setZoom(p.map.getZoom()),await S(P),k(),t().setPhase("ready"),t().setStatus("Ready"),window.__ftTwin={engine:p,sim:n,handles:m,applyStep:S,refreshDerived:A,store:U};let se=!1;return{engine:p,sim:n,handles:m,jumpToDeepest(){const e=n.deepestPoint();return e?(p.map.flyTo({center:[e.lng,e.lat],zoom:17,pitch:55,duration:1500}),e):null},flyTo(e,a,r=16){p.map.flyTo({center:[e,a],zoom:r,duration:1200})},depthAt:(e,a)=>n.depthAt(e,a),destroy(){var e;if(!se){se=!0;try{N()}catch{}try{p.map.off("zoom",te)}catch{}try{p.map.off("moveend",A)}catch{}for(const a of Object.values(m))try{(e=a==null?void 0:a.dispose)==null||e.call(a)}catch(r){console.warn("[twin] dispose failed",r)}try{p.destroy()}catch(a){console.warn("[twin] engine destroy failed",a)}}}}}const Ie=Object.freeze(Object.defineProperty({__proto__:null,startTwin:Pe},Symbol.toStringTag,{value:"Module"}));export{_e as F,ze as a,Fe as b,Ie as c};
