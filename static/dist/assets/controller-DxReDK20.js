const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/buildings-D5RZJRhI.js","assets/index-ZAVyR596.js","assets/react-H_K-hxkn.js","assets/index-DIAR3FUE.css","assets/three-ab00-b5W.js","assets/assetsLayer-BuNEagKt.js","assets/drainageViz-DthwL5g9.js","assets/drainageAssets-BGqs38S9.js"])))=>i.map(i=>d[i]);
import{G as De,r as _e,F as ne,c as Te,D as fe,_ as V}from"./index-ZAVyR596.js";import{T as Se,M as K,V as J,C as Ae,S as Me,A as Re,W as Le}from"./three-ab00-b5W.js";const Q=28.4595,se=77.0266,Pe=u=>`https://apis.mappls.com/advancedmaps/api/${encodeURIComponent(u)}/map_sdk?v=3.0&layer=vector`,oe=()=>!!(window.mappls&&typeof window.mappls.Map=="function");function me(u=1e4){return new Promise((c,s)=>{if(oe())return c();const h=Date.now(),m=setInterval(()=>{oe()?(clearInterval(m),c()):Date.now()-h>u&&(clearInterval(m),s(new Error("Mappls SDK loaded but never exposed mappls.Map")))},25)})}let Y=null;function Ee(u,c){return oe()?Promise.resolve():Y||(Y=new Promise((s,h)=>{const m=document.getElementById("ft-mappls-sdk");if(m){me(15e3).then(s,()=>{m.remove(),D()});return}D();function D(){if(!u){h(new Error("Mappls API key not configured on the server (MAPPLS_API_KEY)."));return}let f=0;const _=3,v=()=>{f++;const w=document.createElement("script");w.src=Pe(u),w.async=!0,w.onload=()=>me().then(s,h),w.onerror=()=>{w.remove(),f<_?(c==null||c(`Map SDK unreachable — retrying (${f}/${_-1})…`),setTimeout(v,1500*f)):h(new Error("Map SDK failed to load. Check network / adblock / API key."))},document.head.appendChild(w)};v()}}).catch(s=>{throw Y=null,s}),Y)}const ke=["Open Sans Regular"],Ze=["Open Sans Bold"];function Ge(u,c,s){if((c==null?void 0:c.type)==="symbol"){const h=c.layout||(c.layout={});h["text-field"]&&!h["text-font"]&&(h["text-font"]=ke)}return u.addLayer(c,s)}function Be(){var h;const u=(h=window.maplibregl)==null?void 0:h.MercatorCoordinate;if(u){const m=u.fromLngLat([se,Q],0);return{translateX:m.x,translateY:m.y,translateZ:m.z,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:m.meterInMercatorCoordinateUnits()}}const c=(se+180)/360,s=Math.sin(Q*Math.PI/180);return{translateX:c,translateY:.5-Math.log((1+s)/(1-s))/(4*Math.PI),translateZ:0,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:1/(2*Math.PI*6378137*Math.cos(Q*Math.PI/180))}}function Fe(u,c){var D;const s=(D=window.maplibregl)==null?void 0:D.MercatorCoordinate;if(s)return s.fromLngLat([u,c]);const h=(u+180)/360,m=Math.sin(c*Math.PI/180);return{x:h,y:.5-Math.log((1+m)/(1-m))/(4*Math.PI)}}let Ie=0;async function Oe({container:u,mapplsKey:c,onStatus:s,client:h=null,debug:m=!1,skipGL:D=!1}){s==null||s("Loading map SDK…"),await Ee(c,s),s==null||s("Initialising map…");const f=typeof u=="string"?document.getElementById(u):u;if(!f)throw new Error(`Map container "${u}" is not in the document.`);f.id||(f.id=`ft-map-${++Ie}-${Math.random().toString(36).slice(2,8)}`);const _=f.id;f.replaceChildren();const v={center:{lat:Q,lng:se},zoom:12.6,pitch:45,bearing:-12,zoomControl:!1,attributionControl:!1,fullscreenControl:!1,preserveDrawingBuffer:!0};let w;try{w=new window.mappls.Map(_,v)}catch(p){console.warn("[engine] map construction failed, clearing and retrying once:",p),f.replaceChildren();try{w=new window.mappls.Map(_,v)}catch(i){throw new Error(`The map could not be initialised (${i.message||i}). Reload the page.`)}}const a=Be(),n={THREE:Se,map:w,toLocal:(p,i)=>{const y=Fe(p,i);return{x:(y.x-a.translateX)/a.scale,z:(y.y-a.translateY)/a.scale}},modelTransform:a,client:h,container:f,debug:m,scene:null,camera:null,renderer:null,clock:0,layers:Object.create(null),tickers:new Set,stepHandlers:new Set,triggerRepaint:()=>{try{w.triggerRepaint()}catch{}},destroy:null},H={id:"ft-scene",type:"custom",renderingMode:"3d",onAdd(p,i){n.camera=new Ae,n.scene=new Me,n.scene.add(new Re(16777215,1)),n.renderer=new Le({canvas:p.getCanvas(),context:i,antialias:!0,preserveDrawingBuffer:!0}),n.renderer.autoClear=!1},render(p,i){var G,O,z;const y=a,I=new K().makeRotationAxis(new J(1,0,0),y.rotateX),P=new K().makeRotationAxis(new J(0,1,0),y.rotateY),W=new K().makeRotationAxis(new J(0,0,1),y.rotateZ),X=new K().fromArray(i),U=new K().makeTranslation(y.translateX,y.translateY,y.translateZ).scale(new J(y.scale,-y.scale,y.scale)).multiply(I).multiply(P).multiply(W);n.camera.projectionMatrix=X.multiply(U);const $=p.drawingBufferWidth,Z=p.drawingBufferHeight;n.renderer.setViewport(0,0,$,Z),n.renderer.resetState(),n.renderer.render(n.scene,n.camera),p.viewport(0,0,$,Z),(z=(O=(G=w.painter)==null?void 0:G.context)==null?void 0:O.setDirty)==null||z.call(O)}},R=D;await new Promise(p=>{let i=!1;const y=()=>{if(!i){if(i=!0,!R)try{w.addLayer(H)}catch(I){console.warn("custom layer add:",I)}p()}};w.on("load",y),w.on("style.load",y),setTimeout(y,6e3)});const B=1e3/30;let M=null,x=0,A=0,L=document.hidden;const F=()=>{L=document.hidden,x=0};document.addEventListener("visibilitychange",F);const d=p=>{if(M=requestAnimationFrame(d),L||!n.tickers.size){x=p;return}x||(x=p);const i=Math.min((p-x)/1e3,.05);if(x=p,A+=i*1e3,A<B)return;const y=A/1e3;A=0,n.clock+=y;for(const I of n.tickers)try{I(n.clock,y)}catch(P){console.warn(P)}n.triggerRepaint()};M=requestAnimationFrame(d);let o=null;if(window.ResizeObserver){let p=null,i=0,y=0;o=new ResizeObserver(I=>{var W;const P=(W=I[0])==null?void 0:W.contentRect;P&&Math.abs(P.width-i)<1&&Math.abs(P.height-y)<1||(P&&(i=P.width,y=P.height),!p&&(p=requestAnimationFrame(()=>{p=null;try{w.resize()}catch{}})))}),o.observe(f)}let g=!1;return n.destroy=()=>{var p,i;if(!g){g=!0;try{cancelAnimationFrame(M)}catch{}try{document.removeEventListener("visibilitychange",F)}catch{}try{o==null||o.disconnect()}catch{}try{n.tickers.clear(),n.stepHandlers.clear()}catch{}try{(i=(p=n.renderer)==null?void 0:p.dispose)==null||i.call(p)}catch{}try{w.remove()}catch{}m&&window.__ftEngine===n&&(window.__ftEngine=null,window.__map=null)}},m&&(window.__ftEngine=n,window.__map=w),n}function ze(u,{xray:c}){var h;const{map:s}=u;try{if(c&&!s.getLayer("xray-dim")&&(s.addSource("xray-dim-src",{type:"geojson",data:{type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[[[-179,-85],[179,-85],[179,85],[-179,85],[-179,-85]]]}}}),s.addLayer({id:"xray-dim",type:"fill",source:"xray-dim-src",paint:{"fill-color":"#0a1420","fill-opacity":0}})),!s.getLayer("xray-dim"))return;if(c){const m=((h=s.style)==null?void 0:h._order)||[];let D=null;for(const f of m){const _=s.getLayer(f);if(_&&_.type==="fill-extrusion"&&!/sea/i.test(f)){D=f;break}}D&&s.moveLayer("xray-dim",D)}s.setPaintProperty("xray-dim","fill-opacity",c?.6:0)}catch(m){console.warn("layer order:",m)}}const Ce=192,Ve=`
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
}`,Ne=`
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

${De}

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
}`;function We(u,c){const{THREE:s,scene:h,toLocal:m}=u,D=c.state.man,f=D.grid_n,_=D.grid_bbox,v=Ce,w=(v+1)*(v+1),a=new Float32Array(w*3),N=new Float32Array(w*2);let n=0,H=0;for(let d=0;d<=v;d++)for(let o=0;o<=v;o++){const g=m(_[0]+o/v*(_[2]-_[0]),_[1]+d/v*(_[3]-_[1]));a[n++]=g.x,a[n++]=0,a[n++]=g.z,N[H++]=o/v,N[H++]=d/v}const R=new Uint32Array(v*v*6);let k=0;for(let d=0;d<v;d++)for(let o=0;o<v;o++){const g=d*(v+1)+o,p=g+1,i=g+(v+1),y=i+1;R[k++]=g,R[k++]=i,R[k++]=p,R[k++]=p,R[k++]=i,R[k++]=y}const B=new s.BufferGeometry;B.setAttribute("position",new s.BufferAttribute(a,3)),B.setAttribute("uv",new s.BufferAttribute(N,2)),B.setIndex(new s.BufferAttribute(R,1)),(!c.state.grid||c.state.grid.length!==f*f)&&(c.state.grid=new Float32Array(f*f));const M=new s.DataTexture(c.state.grid,f,f,s.LuminanceFormat,s.FloatType);M.minFilter=s.LinearFilter,M.magFilter=s.LinearFilter,M.needsUpdate=!0;const x=new s.ShaderMaterial({uniforms:{uTime:{value:0},uOpacity:{value:.78},uMaxDepth:{value:c.maxDepthScale},uDepthTex:{value:M},uTexelSize:{value:new s.Vector2(1/f,1/f)},uBlur:{value:1},uWetMin:{value:.01},uWaveAmp:{value:.18},uDepthHeight:{value:.45},uBandOn:{value:new s.Vector4(1,1,1,1)},uBandEdge:{value:new s.Vector3(.2,.6,1.2)},uRipple0:{value:new s.Vector3(0,0,-1)},uRipple1:{value:new s.Vector3(0,0,-1)},uRipple2:{value:new s.Vector3(0,0,-1)},uRipple3:{value:new s.Vector3(0,0,-1)},..._e(s)},vertexShader:Ve,fragmentShader:Ne,transparent:!0,side:s.DoubleSide,depthWrite:!1,extensions:{derivatives:!0}}),A=new s.Mesh(B,x);A.frustumCulled=!1,A.renderOrder=0,h.add(A);let L=0;const F=d=>{x.uniforms.uTime.value=d};return u.tickers.add(F),{mesh:A,mat:x,tex:M,setVisible(d){A.visible=d,u.triggerRepaint()},setOpacity(d){x.uniforms.uOpacity.value=d,u.triggerRepaint()},setZoom(d){const o=d>=16?1:d>=14?1.5:d>=12.5?2.2:d>=11?3:4,g=d>=15?.01:d>=13?.022:d>=11.5?.038:.055;(Math.abs(o-x.uniforms.uBlur.value)>.01||Math.abs(g-x.uniforms.uWetMin.value)>1e-4)&&(x.uniforms.uBlur.value=o,x.uniforms.uWetMin.value=g,u.triggerRepaint())},refresh(){M.needsUpdate=!0,x.uniforms.uMaxDepth.value=c.maxDepthScale,u.triggerRepaint()},setBands(d,o){x.uniforms.uBandOn.value.set(d[0]?1:0,d[1]?1:0,d[2]?1:0,d[3]?1:0),o&&x.uniforms.uBandEdge.value.set(o[0],o[1],o[2]),u.triggerRepaint()},ripple(d,o){const g=m(d,o);x.uniforms[`uRipple${L}`].value.set(g.x,g.z,x.uniforms.uTime.value),L=(L+1)%4,u.triggerRepaint()},dispose(){u.tickers.delete(F),h.remove(A),B.dispose(),x.dispose(),M.dispose()}}}function he(u){var D;const c=u==null?void 0:u.frames;if(!Array.isArray(c)||!c.length)return 0;const s=Date.now();let h=0,m=1/0;for(let f=0;f<c.length;f++){const _=Date.parse(((D=c[f])==null?void 0:D.valid_at)||"");if(Number.isNaN(_))continue;const v=Math.abs(_-s);v<m&&(m=v,h=f)}return h}async function He({container:u,store:c,client:s,dataset:h=null,mapplsKey:m="",debug:D=!1,skipGL:f=!1,featureLimit:_=1/0,onChunkError:v=null}){const w=c,a=c.getState;a().setStatus("Starting…");const N=m?Promise.resolve({}):window.__FT_CONFIG?Promise.resolve(window.__FT_CONFIG):s.jsonOrNull("/api/config").then(e=>e||{}),n=Te(s),R=h==null?"live":h,k=n.loadManifest(R).then(e=>({id:R,m:e}),()=>null),B=await N;a().setStatus("Loading map…");const M=Oe({container:u,client:s,debug:D,skipGL:f,mapplsKey:m||B.mapplsApiKey,onStatus:e=>a().setStatus(e)}),x=await k;let A,L;x?{m:A,id:L}=x:(A=await n.loadManifest("event"),L="event"),a().setTimeline(A,L);const F=L==="live"?he(A):0;w.setState({dataset:L,step:F});const d=n.useFrame(F),o=await M;a().setStatus("Building flood surface…"),await d;const g=We(o,n);o.layers.flood=g,a().setMaxDepth(n.maxDepthScale),g.setOpacity(a().opacity);const p=new Map,i=o.layers,y="ft_stale_build_reloaded",I=D||v===null,P=e=>{const t=`${(e==null?void 0:e.message)||e}`;return/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(t)},W=(e,t)=>{if(p.has(e))return p.get(e);a().setFeatureStatus(e,"loading");const r=Promise.resolve().then(t).then(l=>(i[e]=l,sessionStorage.removeItem(y),a().setFeatureStatus(e,"ready"),l)).catch(l=>{if(console.warn(`[feature ${e}]`,l),P(l)&&(v==null||v(l,e),I&&!sessionStorage.getItem(y))){sessionStorage.setItem(y,"1"),a().setStatus("A newer build is live — reloading…"),window.location.reload();return}throw a().setFeatureStatus(e,"error",l.message||String(l)),p.delete(e),l});return p.set(e,r),r},X={flood:async()=>g,wards:async()=>{const{createWards:e}=await V(async()=>{const{createWards:t}=await import("./buildings-D5RZJRhI.js");return{createWards:t}},__vite__mapDeps([0,1,2,3,4]));return e(o)},buildings:async()=>{const{createBuildings:e}=await V(async()=>{const{createBuildings:t}=await import("./buildings-D5RZJRhI.js");return{createBuildings:t}},__vite__mapDeps([0,1,2,3,4]));return e(o)},assets:async()=>{const{createAssetsLayer:e}=await V(async()=>{const{createAssetsLayer:r}=await import("./assetsLayer-BuNEagKt.js");return{createAssetsLayer:r}},__vite__mapDeps([5,1,2,3,4])),t=await e(o,{onDepthAt:(r,l)=>n.depthAt(r,l),onCounts:r=>a().setAssetCounts(r)});for(const r of ne.find(l=>l.id==="assets").children)t.setCategory(r.id,!!a().features[`assets.${r.id}`]);return t},sewer:async()=>{const{createSewerLayer:e}=await V(async()=>{const{createSewerLayer:r}=await import("./sewerLayer-PPZjoxuT.js");return{createSewerLayer:r}},[]),t=await e(o);return a().setSewerStats(t.stats),t},roads:async()=>{const{createRoadsLayer:e}=await V(async()=>{const{createRoadsLayer:t}=await import("./roadsLayer-R7LV1nff.js");return{createRoadsLayer:t}},[]);return e(o,{depthAt:(t,r)=>n.depthAtSmooth(t,r),onSegments:t=>a().setRoadSegments(t)})},drainage:async()=>{a().setStatus("Loading drainage network…");const e=n.loadGeometry(),t=V(()=>import("./drainageViz-DthwL5g9.js"),__vite__mapDeps([6,1,2,3])),r=V(()=>import("./drainageAssets-BGqs38S9.js"),__vite__mapDeps([7,1,2,3,4])),l=n.fetchHour(a().step).catch(()=>null),[T,{createDrainageViz:S}]=await Promise.all([e,t]);a().setStatus("Building 139,798 conduits…"),await new Promise(C=>requestAnimationFrame(C));const b=S(o,T);b.setZoom(o.map.getZoom());const E=await l;E&&b.updateHour(E,T.nodeMax,n.state.man.depth_scale,n.state.man.flow_scale);const{createDrainageAssets:be}=await r,re=be(o,{depthAt:(C,q)=>n.depthAt(C,q),onReady:C=>{a().setDrainStats({links:b.links,chains:b.chains,tiers:b.tierCount,classes:b.classCount,...C.stats});const q=n.state.hourCache.get(a().step);q&&(C.updateFrame(q,T),a().setSurcharged(C.surchargedCount))}});return i.drainAssets=re,a().setDrainStats({links:b.links,chains:b.chains,tiers:b.tierCount,classes:b.classCount}),E&&(re.updateFrame(E,T),a().setSurcharged(re.surchargedCount)),b}};function U(){const e=a().features;ze(o,{xray:!!e.xray})}async function $(e,t){var r,l;switch(e){case"flood":g.setVisible(t);break;case"hotspots":t?j():a().setHotspots([]);break;case"xray":U();break;case"terrain":try{o.map.easeTo({pitch:t?55:0,duration:700})}catch{}break;default:{if(!X[e]||!t&&!p.has(e))return;let T;try{T=await W(e,X[e])}catch{return}(r=T.setVisible)==null||r.call(T,t),e==="drainage"&&((l=i.drainAssets)==null||l.setVisible(t),Z()),e==="assets"&&G();break}}U()}function Z(){const e=i.drainage,t=i.drainAssets,r=a().features;if(!e)return;const l={storm:0,sewer:1,unclass:2};for(const[S,b]of Object.entries(l))e.setClass(b,!!r[`drainage.${S}`]);const T={trunk:0,main:1,lateral:2};for(const[S,b]of Object.entries(T)){const E=r[`drainage.${S}`];e.setTier(b,E==="auto"?null:!!E)}for(const S of["water","shafts"])e.setLayer(S,!!r[`drainage.${S}`]);if(e.setMode(r["drainage.capacity"]?"capacity":"water"),t)for(const S of["surcharge","inlets","outfalls","pumps"])t.setLayer(S,!!r[`drainage.${S}`])}function G(){const e=i.assets;if(e)for(const t of ne.find(r=>r.id==="assets").children)e.setCategory(t.id,!!a().features[`assets.${t.id}`])}let O=0;async function z(e){var l,T,S;const t=++O;if(await n.useFrame(e),t!==O)return;g.refresh(),a().setKpi(n.frameStats());const r=n.maxDepthScale;if(Math.abs(r-a().maxDepth)>.001&&(a().setMaxDepth(r),(l=i.drainage)==null||l.setMaxDepth(r),g.setBands(a().bands,a().bandEdges())),i.drainage||i.drainAssets){const b=await n.fetchHour(e);if(t!==O||!b)return;const E=n.state.geom;(T=i.drainage)==null||T.updateHour(b,E.nodeMax,n.state.man.depth_scale,n.state.man.flow_scale),i.drainAssets&&(i.drainAssets.updateFrame(b,E),a().setSurcharged(i.drainAssets.surchargedCount))}(S=i.roads)==null||S.refresh(),j()}let ie=null;function j(){clearTimeout(ie),ie=setTimeout(()=>{var e,t;try{if(a().setKpi(n.frameStats()),!a().features.hotspots)return;const r=(t=(e=o.map).getBounds)==null?void 0:t.call(e),l=r?{s:r.getSouth(),w:r.getWest(),n:r.getNorth(),e:r.getEast()}:null;a().setHotspots(n.hotspots({bounds:l,limit:8,minSepDeg:.006}))}catch(r){console.warn("[derived read-outs]",r)}},200)}let ee=null;async function ve(e){var t,r;if(!(e===n.state.dataset||ee===e)){ee=e;try{a().setStatus(`Loading ${((t=fe[e])==null?void 0:t.label)||e}…`);const l=await n.loadManifest(e);a().setTimeline(l,e);const T=Math.min(a().step,Math.max(0,l.n_hours-1));w.setState({step:T}),await z(T),a().setStatus("Ready")}catch(l){console.warn("[dataset]",l),a().setStatus(`Could not load ${((r=fe[e])==null?void 0:r.label)||e}`)}finally{ee=null}}}let te=!1;async function ge(e){var l,T;const t=(l=e==null?void 0:e.built)==null?void 0:l.run_id;if(!t||te||a().dataset!=="live"||n.state.dataset!=="live")return;const r=(T=n.state.man)==null?void 0:T.run_id;if(!(!r||r===t)){te=!0;try{a().setStatus("A newer forecast run is live — resyncing…");const S=await n.loadManifest("live");a().setTimeline(S,"live");const b=he(S);w.setState({step:b}),await z(b),a().setStatus("Ready")}catch(S){console.warn("[live resync]",S),a().setStatus("Ready")}finally{te=!1}}}let ce=a();const ye=w.subscribe(e=>{const t=ce;if(ce=e,e.features!==t.features){for(const r of Object.keys(e.features))if(e.features[r]!==t.features[r])if(r.includes(".")){const[l]=r.split(".");l==="drainage"?Z():l==="assets"&&G()}else $(r,e.features[r])}e.dataset!==t.dataset?ve(e.dataset):e.step!==t.step&&z(e.step),e.runStatus!==t.runStatus&&ge(e.runStatus),e.opacity!==t.opacity&&g.setOpacity(e.opacity),(e.bands!==t.bands||e.maxDepth!==t.maxDepth)&&g.setBands(e.bands,a().bandEdges())});let ae=null;const le=()=>{ae||(ae=requestAnimationFrame(()=>{var t;ae=null;const e=o.map.getZoom();(t=i.drainage)==null||t.setZoom(e),g.setZoom(e)}))};o.map.on("zoom",le),o.map.on("moveend",j),o.map.on("click",e=>{const{lng:t,lat:r}=e.lngLat,l=n.depthAt(t,r);l>.02&&g.ripple(t,r),o.container.dispatchEvent(new CustomEvent("ft:probe",{bubbles:!1,detail:{lng:t,lat:r,depth:l,point:e.point}}))});const we=_,xe=a().features;let ue=0;const de=[];for(const e of ne)if(xe[e.id]){if(ue>=we){console.log("[bare] skipping",e.id);continue}ue++,de.push($(e.id,!0))}await Promise.all(de),g.setBands(a().bands,a().bandEdges()),g.setZoom(o.map.getZoom()),await z(F),U(),a().setPhase("ready"),a().setStatus("Ready"),D&&(window.__ftTwin={engine:o,sim:n,handles:i,applyStep:z,refreshDerived:j,store:w});let pe=!1;return{engine:o,sim:n,handles:i,jumpToDeepest(){const e=n.deepestPoint();return e?(o.map.flyTo({center:[e.lng,e.lat],zoom:17,pitch:55,duration:1500}),e):null},flyTo(e,t,r=16){o.map.flyTo({center:[e,t],zoom:r,duration:1200})},depthAt:(e,t)=>n.depthAt(e,t),destroy(){var e;if(!pe){pe=!0;try{ye()}catch{}try{o.map.off("zoom",le)}catch{}try{o.map.off("moveend",j)}catch{}for(const t of Object.values(i))try{(e=t==null?void 0:t.dispose)==null||e.call(t)}catch(r){console.warn("[twin] dispose failed",r)}try{o.destroy()}catch(t){console.warn("[twin] engine destroy failed",t)}}}}}const je=Object.freeze(Object.defineProperty({__proto__:null,startTwin:He},Symbol.toStringTag,{value:"Module"}));export{ke as F,Ge as a,Ze as b,je as c};
