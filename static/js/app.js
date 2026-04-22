(function(){
'use strict';

const CFG = window.FLOODTWIN_CONFIG || {
  mapplsApiKey: '',
  dataUrls: { polygonIndex:'/polygon_index.json', coordinates:'/coordinates.bin', chunksBase:'/chunks/' }
};

// ── External SDK loaders ──────────────────────────────────────────────────────
function loadMapplsSDK(cb) {
  if (window.mappls && typeof window.mappls.Map === 'function') { cb(); return; }
  if (!CFG.mapplsApiKey) {
    setStatus('❌ Mappls API key not configured on server (MAPPLS_API_KEY).');
    return;
  }
  var s = document.createElement('script');
  s.src = 'https://apis.mappls.com/advancedmaps/api/' + encodeURIComponent(CFG.mapplsApiKey) + '/map_sdk?v=3.0&layer=vector';
  s.async = true;
  s.onload = function() {
    var t = 0;
    var check = setInterval(function() {
      t++;
      if (window.mappls && typeof window.mappls.Map === 'function') { clearInterval(check); cb(); }
      if (t > 100) { clearInterval(check); cb(); }
    }, 100);
  };
  s.onerror = function() { setStatus('❌ Map SDK failed to load. Check network / API key.'); };
  document.head.appendChild(s);
}

function loadThreeJS(cb) {
  if (window.THREE) { cb(); return; }
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  s.async = true;
  s.onload = cb;
  s.onerror = function() { console.warn('Three.js failed to load'); cb(); };
  document.head.appendChild(s);
}

const CHUNK_SIZE=10,TOTAL_CHUNKS=34,MAX_CACHED=3,TOTAL_STEPS=336;
const REF_LAT=28.4595,REF_LNG=77.0266;
const NOM_UA='FloodTwin/1.0';
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];

const GRID_W=512,GRID_H=512;
const PLANE_SEG=384;
const DEPTH_MAX=3.0;

let map,glMap,scene,camera,renderer,modelTransform;
let currentStep=0,isPlaying=false,playInterval=null,playSpeed=500;
let floodOpacity=0.70,depthScale=1.0;
let waterMeshes=[],polygonCount=0,coordinatesBuffer=null;
let is3DMode=false;
let isFullscreen=false;
const chunkCache=new Map(),chunkQueue=new Set();
let polygonRings=null;
let lastDepths=null;
let gridMinX=0,gridMaxX=0,gridMinZ=0,gridMaxZ=0;
let polyToTexel=null,depthGrid=null,depthTexture=null;
let waterSurfaceBuilt=false,waterMaterial=null;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function setStatus(t){
  const el=document.getElementById('loadingProgress');
  if(el)el.textContent=t;
}

// ── Polygon ring data ─────────────────────────────────────────────────────────
function buildPolygonRings(){
  if(!coordinatesBuffer||polygonRings)return;
  const dv=new DataView(coordinatesBuffer);
  polygonRings=[];
  let off=0;
  for(let p=0;p<polygonCount;p++){
    const pc=dv.getUint32(off,true);off+=4;
    const ring=[];
    for(let i=0;i<pc;i++){ring.push({lng:dv.getFloat64(off,true),lat:dv.getFloat64(off+8,true)});off+=16;}
    polygonRings.push(ring);
  }
}
function pointInPolygon(lng,lat,ring){
  let inside=false;const n=ring.length;
  for(let i=0,j=n-1;i<n;j=i++){
    const xi=ring[i].lng,yi=ring[i].lat,xj=ring[j].lng,yj=ring[j].lat;
    if(((yi>lat)!==(yj>lat))&&(lng<(xj-xi)*(lat-yi)/(yj-yi)+xi))inside=!inside;
  }
  return inside;
}

// ── Flood popup ───────────────────────────────────────────────────────────────
const SEV=[
  {max:0.5,label:'Low',bg:'#e6f7f9',color:'#0e7490',dot:'#B3EBF7'},
  {max:1.0,label:'Moderate',bg:'#cceef5',color:'#0369a1',dot:'#7BCFEE'},
  {max:2.0,label:'High',bg:'#b3dde8',color:'#155e75',dot:'#4B93C8'},
  {max:Infinity,label:'Severe',bg:'#264351',color:'#fff',dot:'#0D2E61'}
];
const fpPopup=document.getElementById('floodPopup');
let fpLat=null,fpLng=null;
document.getElementById('fpClose').addEventListener('click',()=>{fpPopup.style.display='none';fpLat=fpLng=null;});

function repositionFloodPopup(){
  if(fpPopup.style.display==='none'||fpLat===null)return;
  try{const pt=map.project({lat:fpLat,lng:fpLng});fpPopup.style.transform=`translate3d(${pt.x}px,${pt.y-14}px,0) translate(-50%,-100%)`;}catch(e){}
}
function showFloodPopup(lng,lat,depth){
  const sev=SEV.find(s=>depth<s.max);
  fpLat=lat;fpLng=lng;
  document.getElementById('fpVal').textContent=depth.toFixed(2);
  const badge=document.getElementById('fpBadge');
  badge.style.background=sev.bg;badge.style.color=sev.color;
  document.getElementById('fpDot').style.background=sev.dot;
  document.getElementById('fpLabel').textContent=sev.label;
  document.getElementById('fpTime').textContent=document.getElementById('timeDisplay').textContent;
  document.getElementById('fpCoords').textContent=`${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`;
  const mapEl=document.getElementById('map');
  if(fpPopup.parentNode!==mapEl)mapEl.appendChild(fpPopup);
  fpPopup.style.display='block';repositionFloodPopup();
}
async function tryFloodHit(lat,lng){
  if(!polygonRings)return false;
  const depths=await getDepth(currentStep);if(!depths)return false;
  for(let p=0;p<polygonCount;p++){
    if(depths[p]<=0)continue;
    if(pointInPolygon(lng,lat,polygonRings[p])){showFloodPopup(lng,lat,depths[p]);return true;}
  }
  return false;
}

// ── Critical Assets ───────────────────────────────────────────────────────────
const ASSET_CATS=[
  {key:'hospital',icon:'🏥',label:'Hospitals',accent:'#ef4444'},
  {key:'school',icon:'🏫',label:'Schools',accent:'#10b981'},
  {key:'college',icon:'🎓',label:'Colleges',accent:'#06b6d4'},
  {key:'fire_station',icon:'🚒',label:'Fire Stations',accent:'#f43f5e'},
  {key:'police',icon:'🚔',label:'Police',accent:'#6366f1'},
  {key:'pharmacy',icon:'💊',label:'Pharmacies',accent:'#14b8a6'}
];
const catMarkers={},catEnabled={},catFeatures={};
ASSET_CATS.forEach(c=>{catMarkers[c.key]=[];catEnabled[c.key]=false;catFeatures[c.key]=null;});
const AMENITY_TO_KEY={hospital:'hospital',school:'school',university:'college',college:'college',fire_station:'fire_station',police:'police',pharmacy:'pharmacy'};

function renderAssetPills(){
  const grid=document.getElementById('assetGrid');
  grid.innerHTML=ASSET_CATS.map(c=>`<div class="asset-pill" data-cat="${c.key}" style="--pill-accent:${c.accent}"><span class="pill-icon">${c.icon}</span><span class="pill-label">${c.label}</span><span class="pill-count" id="cnt-${c.key}">0</span></div>`).join('');
  grid.querySelectorAll('.asset-pill').forEach(pill=>{
    pill.addEventListener('click',()=>{
      const key=pill.dataset.cat;catEnabled[key]=!catEnabled[key];
      pill.classList.toggle('on',catEnabled[key]);
      catEnabled[key]?showMarkers(key):hideMarkers(key);
    });
  });
}
function hideMarkers(key){catMarkers[key].forEach(m=>m.el.remove());catMarkers[key]=[];document.querySelectorAll('.osm-popup').forEach(p=>p.remove());}
function showMarkers(key){if(catFeatures[key]?.length>0)addMarkers(key,catFeatures[key]);}
function addMarkers(key,features){
  hideMarkers(key);
  const cat=ASSET_CATS.find(c=>c.key===key);
  const mapEl=document.getElementById('map');
  features.forEach(f=>{
    const[lng,lat]=f.geometry.coordinates;
    const p=f.properties;
    const name=p.name||p['name:en']||p['name:hi']||p.operator||'Unnamed';
    const addrLine=[p['addr:housename'],p['addr:housenumber'],p['addr:street']||p['addr:place'],p['addr:city']||p['addr:district'],p['addr:state']].filter(Boolean).join(', ');
    const el=document.createElement('div');el.className='osm-marker';el.style.background=cat.accent;el.textContent=cat.icon;
    mapEl.appendChild(el);
    const posUpdate=()=>{try{const pt=map.project({lat,lng});el.style.transform=`translate3d(${pt.x}px,${pt.y}px,0) translate(-50%,-100%)`;}catch(e){}};
    posUpdate();
    el.addEventListener('click',e=>{
      e.stopPropagation();document.querySelectorAll('.osm-popup').forEach(p=>p.remove());
      const pop=document.createElement('div');pop.className='osm-popup';
      pop.innerHTML=`<button class="popup-close">✕</button><div class="popup-name">${esc(name)}</div><div class="popup-type">${esc(cat.label)}</div>${addrLine?`<div class="popup-addr">${esc(addrLine)}</div>`:''}`;
      const setPopPos=()=>{try{const pt=map.project({lat,lng});pop.style.transform=`translate3d(${pt.x}px,${pt.y-44}px,0)`;}catch(e){}};
      setPopPos();
      mapEl.appendChild(pop);
      map.on('move',setPopPos);
      pop.querySelector('.popup-close').addEventListener('click',()=>{pop.remove();try{map.off('move',setPopPos);}catch(e){}});
    });
    catMarkers[key].push({el,lat,lng,posUpdate});
  });
  const badge=document.getElementById('cnt-'+key);if(badge)badge.textContent=features.length;
}
function syncAllMarkers(){ASSET_CATS.forEach(c=>catMarkers[c.key].forEach(m=>m.posUpdate()));repositionFloodPopup();}

async function fetchAllOverpass(){
  const bbox='28.20,76.70,28.60,77.30';
  const amenities=['hospital','school','university','college','fire_station','police','pharmacy'];
  const stmts=amenities.flatMap(a=>[`node["amenity"="${a}"](${bbox});`,`way["amenity"="${a}"](${bbox});`]).join('');
  const ql=`[out:json][timeout:40];(${stmts});out center tags;`;
  const endpoints=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
  for(let i=0;i<4;i++){
    try{
      const ctrl=new AbortController();const tid=setTimeout(()=>ctrl.abort(),42000);
      const res=await fetch(endpoints[i%endpoints.length]+'?data='+encodeURIComponent(ql),{signal:ctrl.signal});clearTimeout(tid);
      if(res.status===429||res.status===504){await sleep(2000*(i+1));continue;}
      if(!res.ok){await sleep(1500);continue;}
      const json=await res.json();
      return(json.elements||[]).filter(el=>(el.lat!=null&&el.lon!=null)||el.center);
    }catch(e){if(i<3)await sleep(1500*(i+1));}
  }
  return[];
}

async function loadAllAssets(){
  renderAssetPills();
  const ab=document.getElementById('assetBadge');ab.textContent='Loading…';
  const elements=await fetchAllOverpass();
  const buckets={};ASSET_CATS.forEach(c=>{buckets[c.key]=[];});
  elements.forEach(el=>{
    const key=AMENITY_TO_KEY[(el.tags||{}).amenity];if(!key)return;
    buckets[key].push({type:'Feature',geometry:{type:'Point',coordinates:[el.lon??el.center.lon,el.lat??el.center.lat]},properties:el.tags||{}});
  });
  ASSET_CATS.forEach(c=>{
    catFeatures[c.key]=buckets[c.key];
    const badge=document.getElementById('cnt-'+c.key);if(badge)badge.textContent=buckets[c.key].length;
    if(catEnabled[c.key]&&buckets[c.key].length>0)addMarkers(c.key,buckets[c.key]);
  });
  ab.textContent='Ready';ab.style.background='#B1DEE2';ab.style.color='#264351';
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchInitDone=false,searchDebounce=null;
function initSearch(){
  if(searchInitDone)return;searchInitDone=true;
  const input=document.getElementById('searchInput');
  const list=document.getElementById('searchSuggestions');
  input.addEventListener('input',()=>{
    clearTimeout(searchDebounce);const q=input.value.trim();
    if(q.length<3){list.style.display='none';return;}
    searchDebounce=setTimeout(()=>nominatimForward(q,list,input),350);
  });
  document.addEventListener('click',e=>{if(!document.getElementById('searchRow').contains(e.target))list.style.display='none';});
  map.on('click',async e=>{
    const{lat,lng}=e.lngLat;
    document.querySelectorAll('.osm-popup').forEach(p=>p.remove());
    const hit=await tryFloodHit(lat,lng);if(hit)return;
    fpPopup.style.display='none';fpLat=fpLng=null;
    const label=await nominatimReverse(lat,lng);input.value=label;flyPin(lat,lng,label);
  });
}

function formatScaleDistance(meters){
  if(meters >= 1000){
    const km = meters / 1000;
    return (km >= 10 ? Math.round(km) : km.toFixed(km >= 2 ? 1 : 2).replace(/\.?0+$/,'')) + ' km';
  }
  return Math.round(meters) + ' m';
}

function getNiceScaleDistance(maxMeters){
  const steps=[1,2,5];
  const pow=Math.pow(10,Math.floor(Math.log10(Math.max(maxMeters,1))));
  let best=pow;
  for(let exp=pow;exp<=pow*10;exp*=10){
    for(const step of steps){
      const candidate=step*exp;
      if(candidate<=maxMeters)best=candidate;
    }
  }
  return best;
}

function updateScaleBars(){
  if(!map)return;
  try{
    const center=map.getCenter();
    const zoom=map.getZoom();
    const metersPerPixel=156543.03392*Math.cos((center.lat||0)*Math.PI/180)/Math.pow(2,zoom);
    const maxWidthPx=120;
    const niceMeters=getNiceScaleDistance(metersPerPixel*maxWidthPx);
    const widthPx=Math.max(36,Math.min(maxWidthPx,niceMeters/metersPerPixel));
    ['mapScaleRight'].forEach(id=>{
      const root=document.getElementById(id);
      if(!root)return;
      const bar=root.querySelector('.map-scale-bar');
      const label=root.querySelector('.map-scale-label');
      if(bar)bar.style.width=widthPx+'px';
      if(label)label.textContent=formatScaleDistance(niceMeters);
    });
  }catch(e){}
}

function syncFullscreenState(){
  isFullscreen=!!document.fullscreenElement;
  document.body.classList.toggle('is-fullscreen',isFullscreen);
  if(isFullscreen){
    const sb=document.getElementById('sidebar');
    if(sb&&!sb.classList.contains('collapsed'))toggleSidebar();
  }
  updateScaleBars();
}
async function nominatimForward(query,list,input){
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=6&addressdetails=1`,{headers:{'User-Agent':NOM_UA}});
    if(!r.ok)return;const results=await r.json();
    if(!results.length){list.style.display='none';return;}
    list.innerHTML=results.map(res=>`<li data-lat="${res.lat}" data-lng="${res.lon}">${esc(res.display_name)}</li>`).join('');
    list.style.display='block';
    list.querySelectorAll('li').forEach(li=>li.addEventListener('click',()=>{const lat=+li.dataset.lat,lng=+li.dataset.lng;input.value=li.textContent.trim();list.style.display='none';flyPin(lat,lng,li.textContent.trim());}));
  }catch(e){}
}
async function nominatimReverse(lat,lng){
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`,{headers:{'User-Agent':NOM_UA}});
    if(!r.ok)throw new Error(r.status);
    const data=await r.json();const a=data.address||{};
    const parts=[a.road||a.pedestrian||a.footway,a.suburb||a.neighbourhood,a.city||a.town||a.village||a.county,a.state].filter(Boolean);
    return parts.length?parts.join(', '):data.display_name||`${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }catch(e){return`${lat.toFixed(5)}, ${lng.toFixed(5)}`;}
}
let currentPin=null;
function flyPin(lat,lng,name){
  try{map.flyTo({center:{lat,lng},zoom:15,pitch:50});}catch(e){}
  if(currentPin){currentPin();currentPin=null;}
  const el=document.createElement('div');el.className='search-pin';el.textContent='📍';el.title=name;
  document.getElementById('map').appendChild(el);
  const upd=()=>{try{const p=map.project({lat,lng});el.style.transform=`translate3d(${p.x}px,${p.y}px,0) translate(-50%,-100%)`;}catch(e){}};
  upd();map.on('move',upd);
  const rm=()=>{el.remove();try{map.off('move',upd);}catch(e){}};
  currentPin=rm;setTimeout(()=>{if(currentPin===rm){rm();currentPin=null;}},10000);
}

// ── THREE.JS custom layer ─────────────────────────────────────────────────────
const VERT_SRC=`
uniform float uTime;
uniform sampler2D uDepthTex;
uniform float uWaveAmp;
varying float vDepth;
varying vec2 vUv;
varying vec3 vWP;

void main(){
  vUv = uv;
  float depth = texture2D(uDepthTex, uv).r;
  vDepth = depth;
  float df = smoothstep(0.0, 0.25, depth);
  float t = uTime;
  vec3 p = position;
  float w = sin(p.x*0.55 + t*1.7) * cos(p.z*0.60 + t*1.2)
          + 0.55*sin((p.x*0.90 - p.z*0.70)*0.85 + t*1.45);
  p.y = w * uWaveAmp * df;
  vWP = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
}`;

const FRAG_SRC=`
uniform float uTime;
uniform float uOpacity;
uniform float uMaxDepth;
uniform sampler2D uDepthTex;
uniform vec2 uTexelSize;
varying float vDepth;
varying vec2 vUv;
varying vec3 vWP;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),
             mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x), f.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5;
  for(int i=0;i<4;i++){ v+=a*noise(p); p=p*2.1+vec2(1.7,9.2); a*=0.5; }
  return v;
}

float sampleSoft(vec2 c){
  float s = 0.0;
  s += texture2D(uDepthTex, c + uTexelSize*vec2(-1.0,-1.0)).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2( 0.0,-1.0)).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2( 1.0,-1.0)).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2(-1.0, 0.0)).r;
  s += texture2D(uDepthTex, c).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2( 1.0, 0.0)).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2(-1.0, 1.0)).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2( 0.0, 1.0)).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2( 1.0, 1.0)).r;
  return s * 0.111111;
}

vec3 gradient4(float d){
  vec3 c0 = vec3(0.70, 0.92, 0.97);
  vec3 c1 = vec3(0.38, 0.72, 0.90);
  vec3 c2 = vec3(0.16, 0.42, 0.72);
  vec3 c3 = vec3(0.05, 0.18, 0.38);
  if(d < 0.25) return mix(c0, c1, d / 0.25);
  if(d < 0.60) return mix(c1, c2, (d - 0.25) / 0.35);
  return mix(c2, c3, clamp((d - 0.60) / 0.40, 0.0, 1.0));
}

void main(){
  float depth = sampleSoft(vUv);
  float alphaMask = smoothstep(0.02, 0.22, depth);
  if(alphaMask <= 0.001) discard;

  float d = clamp(depth / uMaxDepth, 0.0, 1.0);
  vec3 base = gradient4(d);

  float dL = sampleSoft(vUv - vec2(uTexelSize.x, 0.0));
  float dR = sampleSoft(vUv + vec2(uTexelSize.x, 0.0));
  float dDn = sampleSoft(vUv - vec2(0.0, uTexelSize.y));
  float dUp = sampleSoft(vUv + vec2(0.0, uTexelSize.y));
  vec3 N = normalize(vec3(-(dR - dL)*2.2, 1.0, -(dUp - dDn)*2.2));

  float t = uTime * 0.18;
  vec2 wv1 = vUv*220.0 + vec2( t*1.6,  t*1.2);
  vec2 wv2 = vUv*340.0 + vec2(-t*1.1,  t*0.9);
  float eps = 0.01;
  float nA  = fbm(wv1);
  float nAx = fbm(wv1 + vec2(eps, 0.0)) - nA;
  float nAz = fbm(wv1 + vec2(0.0, eps)) - nA;
  float nB  = fbm(wv2);
  float nBx = fbm(wv2 + vec2(eps, 0.0)) - nB;
  float nBz = fbm(wv2 + vec2(0.0, eps)) - nB;
  vec3 bumpN = normalize(vec3(-(nAx + nBx)*4.5, 1.0, -(nAz + nBz)*4.5));
  N = normalize(mix(N, bumpN, 0.55));

  vec3 V = vec3(0.0, 1.0, 0.0);
  vec3 L = normalize(vec3(0.45, 0.90, 0.30));
  vec3 H = normalize(L + V);
  float NdotV = max(dot(N, V), 0.0);
  float F = pow(1.0 - NdotV, 5.0);
  float spec = pow(max(dot(N, H), 0.0), 96.0);
  float diff = max(dot(N, L), 0.0) * 0.6 + 0.4;

  vec3 col = base * diff;
  col = mix(col, vec3(0.92, 0.96, 1.0), F * 0.30);
  col += vec3(1.0, 0.98, 0.92) * spec * 0.55;

  float caustic = pow(clamp(1.0 - abs(nA - nB), 0.0, 1.0), 8.0);
  col += vec3(0.6, 0.9, 1.0) * caustic * 0.07 * (1.0 - d);

  gl_FragColor = vec4(col, uOpacity * alphaMask);
}`;

function buildTransform(){
  const MC=window.maplibregl?.MercatorCoordinate;
  if(MC){const c=MC.fromLngLat([REF_LNG,REF_LAT],0);return{translateX:c.x,translateY:c.y,translateZ:c.z,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:c.meterInMercatorCoordinateUnits()};}
  const x=(REF_LNG+180)/360;const sl=Math.sin(REF_LAT*Math.PI/180);
  return{translateX:x,translateY:0.5-Math.log((1+sl)/(1-sl))/(4*Math.PI),translateZ:0,rotateX:Math.PI/2,rotateY:0,rotateZ:0,scale:1/(2*Math.PI*6378137*Math.cos(REF_LAT*Math.PI/180))};
}
function merc(lng,lat){
  if(window.maplibregl?.MercatorCoordinate)return window.maplibregl.MercatorCoordinate.fromLngLat([lng,lat]);
  const x=(lng+180)/360;const sl=Math.sin(lat*Math.PI/180);
  return{x,y:0.5-Math.log((1+sl)/(1-sl))/(4*Math.PI)};
}
function toLocal(lng,lat){const mc=merc(lng,lat);return{x:(mc.x-modelTransform.translateX)/modelTransform.scale,z:(mc.y-modelTransform.translateY)/modelTransform.scale};}

const customLayer={
  id:'water-surface',type:'custom',renderingMode:'3d',
  onAdd(m,gl){
    camera=new THREE.Camera();scene=new THREE.Scene();waterMeshes=[];
    scene.add(new THREE.AmbientLight(0xffffff,1.0));
    renderer=new THREE.WebGLRenderer({canvas:m.getCanvas(),context:gl,antialias:true,preserveDrawingBuffer:true});
    renderer.autoClear=false;
  },
  render(gl,matrix){
    if(!modelTransform)return;
    const rx=new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1,0,0),modelTransform.rotateX);
    const ry=new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0,1,0),modelTransform.rotateY);
    const rz=new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0,0,1),modelTransform.rotateZ);
    const m=new THREE.Matrix4().fromArray(matrix);
    const l=new THREE.Matrix4()
      .makeTranslation(modelTransform.translateX,modelTransform.translateY,modelTransform.translateZ)
      .scale(new THREE.Vector3(modelTransform.scale,-modelTransform.scale,modelTransform.scale))
      .multiply(rx).multiply(ry).multiply(rz);
    camera.projectionMatrix=m.multiply(l);
    renderer.resetState();renderer.render(scene,camera);glMap.triggerRepaint();
  }
};

let animClock=0,rafId=null;

function buildPolygonTexelMap(){
  if(!coordinatesBuffer||!modelTransform||polyToTexel)return;
  const dv=new DataView(coordinatesBuffer);
  const cx=new Float32Array(polygonCount);
  const cz=new Float32Array(polygonCount);
  let mnX=Infinity,mxX=-Infinity,mnZ=Infinity,mxZ=-Infinity;
  let off=0;
  for(let p=0;p<polygonCount;p++){
    const pc=dv.getUint32(off,true);off+=4;
    let sx=0,sz=0;
    for(let i=0;i<pc;i++){
      const loc=toLocal(dv.getFloat64(off,true),dv.getFloat64(off+8,true));
      off+=16;sx+=loc.x;sz+=loc.z;
    }
    const x=sx/pc,z=sz/pc;
    cx[p]=x;cz[p]=z;
    if(x<mnX)mnX=x;if(x>mxX)mxX=x;
    if(z<mnZ)mnZ=z;if(z>mxZ)mxZ=z;
  }
  const padX=(mxX-mnX)*0.02,padZ=(mxZ-mnZ)*0.02;
  gridMinX=mnX-padX;gridMaxX=mxX+padX;
  gridMinZ=mnZ-padZ;gridMaxZ=mxZ+padZ;
  const gw=gridMaxX-gridMinX,gh=gridMaxZ-gridMinZ;
  polyToTexel=new Int32Array(polygonCount);
  for(let p=0;p<polygonCount;p++){
    const u=Math.min(GRID_W-1,Math.max(0,Math.floor((cx[p]-gridMinX)/gw*GRID_W)));
    const v=Math.min(GRID_H-1,Math.max(0,Math.floor((cz[p]-gridMinZ)/gh*GRID_H)));
    polyToTexel[p]=v*GRID_W+u;
  }
  depthGrid=new Float32Array(GRID_W*GRID_H);
  depthTexture=new THREE.DataTexture(depthGrid,GRID_W,GRID_H,THREE.LuminanceFormat,THREE.FloatType);
  depthTexture.minFilter=THREE.LinearFilter;
  depthTexture.magFilter=THREE.LinearFilter;
  depthTexture.wrapS=THREE.ClampToEdgeWrapping;
  depthTexture.wrapT=THREE.ClampToEdgeWrapping;
  depthTexture.generateMipmaps=false;
  depthTexture.needsUpdate=true;
}

function buildWaterSurfaceMesh(){
  if(!scene||!window.THREE||waterMeshes.length)return;
  const segX=PLANE_SEG,segZ=PLANE_SEG;
  const nVerts=(segX+1)*(segZ+1);
  const pos=new Float32Array(nVerts*3);
  const uvs=new Float32Array(nVerts*2);
  const sx=(gridMaxX-gridMinX)/segX;
  const sz=(gridMaxZ-gridMinZ)/segZ;
  let vi=0,ui=0;
  for(let j=0;j<=segZ;j++){
    for(let i=0;i<=segX;i++){
      pos[vi++]=gridMinX+i*sx;
      pos[vi++]=0;
      pos[vi++]=gridMinZ+j*sz;
      uvs[ui++]=i/segX;
      uvs[ui++]=j/segZ;
    }
  }
  const nQuads=segX*segZ;
  const idx=nVerts>65535?new Uint32Array(nQuads*6):new Uint16Array(nQuads*6);
  let ii=0;
  for(let j=0;j<segZ;j++){
    for(let i=0;i<segX;i++){
      const a=j*(segX+1)+i,b=a+1,c=a+(segX+1),d=c+1;
      idx[ii++]=a;idx[ii++]=c;idx[ii++]=b;
      idx[ii++]=b;idx[ii++]=c;idx[ii++]=d;
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  geo.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
  geo.setIndex(new THREE.BufferAttribute(idx,1));

  waterMaterial=new THREE.ShaderMaterial({
    uniforms:{
      uTime:{value:animClock},
      uOpacity:{value:floodOpacity},
      uMaxDepth:{value:DEPTH_MAX},
      uDepthTex:{value:depthTexture},
      uTexelSize:{value:new THREE.Vector2(1/GRID_W,1/GRID_H)},
      uWaveAmp:{value:0.18}
    },
    vertexShader:VERT_SRC,fragmentShader:FRAG_SRC,
    transparent:true,side:THREE.DoubleSide,depthWrite:false
  });
  const mesh=new THREE.Mesh(geo,waterMaterial);
  mesh.frustumCulled=false;
  scene.add(mesh);waterMeshes.push(mesh);
}

function ensureWaterSurface(){
  if(waterSurfaceBuilt)return true;
  if(!scene||!modelTransform||!coordinatesBuffer||!polygonCount||!window.THREE)return false;
  buildPolygonTexelMap();
  buildWaterSurfaceMesh();
  waterSurfaceBuilt=true;
  return true;
}

function updateDepthTexture(depths){
  if(!ensureWaterSurface()||!depthGrid||!depths)return;
  depthGrid.fill(0);
  for(let p=0;p<polygonCount;p++){
    const d=depths[p];
    if(d>0){
      const idx=polyToTexel[p];
      if(d>depthGrid[idx])depthGrid[idx]=d;
    }
  }
  if(waterMaterial)waterMaterial.uniforms.uOpacity.value=floodOpacity;
  depthTexture.needsUpdate=true;
}

// ── Flood data loading ────────────────────────────────────────────────────────
async function initializeVisualization(){
  try{
    setStatus('10% – Loading metadata…');
    const ir=await fetch(CFG.dataUrls.polygonIndex);
    if(!ir.ok)throw new Error(`polygon_index.json → HTTP ${ir.status}`);
    polygonCount=(await ir.json()).length;

    setStatus('30% – Loading coordinates…');
    const cr=await fetch(CFG.dataUrls.coordinates);
    if(!cr.ok)throw new Error(`coordinates.bin → HTTP ${cr.status}`);
    coordinatesBuffer=await cr.arrayBuffer();
    buildPolygonRings();

    setStatus('50% – Preloading chunks…');
    await Promise.all([loadChunk(0),loadChunk(1)]);

    setStatus('100% – Ready!');
    setTimeout(()=>{document.getElementById('loadingOverlay').classList.add('hidden');updateStep(0);},400);
  }catch(err){
    console.error(err);
    setStatus('❌ '+err.message);
    document.querySelector('#loadingOverlay .loader h2').textContent='Load Failed';
    document.querySelector('#loadingOverlay .spinner').style.display='none';
  }
}

async function loadChunk(idx){
  if(chunkCache.has(idx))return;
  if(chunkQueue.has(idx)){while(chunkQueue.has(idx))await sleep(50);return;}
  chunkQueue.add(idx);
  try{
    const r=await fetch(`${CFG.dataUrls.chunksBase}chunk_${String(idx).padStart(3,'0')}.bin`);
    if(!r.ok)throw new Error(`chunk_${idx}`);
    const v=new Float32Array(await r.arrayBuffer());
    const d={},s=idx*CHUNK_SIZE,e=Math.min(s+CHUNK_SIZE,TOTAL_STEPS+1);
    for(let ts=s,i=0;ts<e;ts++,i++)d[ts]=v.slice(i*polygonCount,(i+1)*polygonCount);
    chunkCache.set(idx,d);
    if(chunkCache.size>MAX_CACHED)chunkCache.delete(chunkCache.keys().next().value);
  }catch(e){console.error(e);}finally{chunkQueue.delete(idx);}
}
async function getDepth(step){
  const ci=Math.floor(step/CHUNK_SIZE);
  if(!chunkCache.has(ci)){
    document.getElementById('chunkLoadingIndicator').style.display='block';
    await loadChunk(ci);
    document.getElementById('chunkLoadingIndicator').style.display='none';
  }
  return chunkCache.get(ci)?.[step]??null;
}

async function updateStep(step){
  step=Math.max(0,Math.min(TOTAL_STEPS,step));
  const depths=await getDepth(step);if(!depths)return;
  lastDepths=depths;
  currentStep=step;updateDepthTexture(depths);
  fpPopup.style.display='none';fpLat=fpLng=null;
  const nc=Math.floor(step/CHUNK_SIZE)+1;
  if(nc<TOTAL_CHUNKS&&!chunkCache.has(nc)&&!chunkQueue.has(nc))loadChunk(nc).catch(()=>{});
  const b=new Date('2025-07-09T01:55:00');b.setMinutes(b.getMinutes()+step*5);
  const z=n=>String(n).padStart(2,'0');
  document.getElementById('timeDisplay').textContent=`${z(b.getDate())}-${MONTHS[b.getMonth()]}-${b.getFullYear()} ${z(b.getHours())}:${z(b.getMinutes())}:${z(b.getSeconds())}`;
  const sl=document.getElementById('timeSlider');sl.value=step;
  sl.style.background=`linear-gradient(to right,#5298A9 ${(step/TOTAL_STEPS*100)}%,#e2e8f0 ${(step/TOTAL_STEPS*100)}%)`;
}

// ── UI controls ───────────────────────────────────────────────────────────────
function removeAttribution(){
  ['.mappls-copyright','.mappls-logo','.mappls-watermark','.maplibregl-ctrl-attrib','.mappls-ctrl-attrib','[class*="mappls-logo"]','[class*="mappls-watermark"]','[class*="maplibregl-ctrl-logo"]','.maplibregl-ctrl-bottom-left','.maplibregl-ctrl-bottom-right','.mappls-ctrl-bottom-left','.mappls-ctrl-bottom-right','a[href*="mappls"]','a[href*="mapmyindia"]','img[src*="mappls"]','img[src*="mapmyindia"]'].forEach(sel=>document.querySelectorAll(sel).forEach(el=>{el.style.cssText='display:none!important';}));
}
setInterval(removeAttribution,5000);

function toggleSidebar(){
  const sb=document.getElementById('sidebar'),ham=document.getElementById('hamburgerBtn'),chv=document.getElementById('collapseBtn');
  const c=sb.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed',c);
  ham.classList.toggle('open',!c);
  chv.innerHTML=c?'›':'‹';
}
document.getElementById('hamburgerBtn').addEventListener('click',toggleSidebar);
document.getElementById('collapseBtn').addEventListener('click',toggleSidebar);
document.getElementById('headerSidebarToggle').addEventListener('click',toggleSidebar);
document.getElementById('timeSlider').addEventListener('input',e=>updateStep(+e.target.value));
document.addEventListener('fullscreenchange',syncFullscreenState);

const playBtn=document.getElementById('playBtn');
playBtn.addEventListener('click',()=>{
  isPlaying=!isPlaying;playBtn.classList.toggle('active',isPlaying);playBtn.innerHTML=isPlaying?'⏸':'▶';
  if(isPlaying)playInterval=setInterval(()=>updateStep(currentStep>=TOTAL_STEPS?0:currentStep+1),playSpeed);
  else clearInterval(playInterval);
});
document.getElementById('prevBtn').addEventListener('click',()=>{if(currentStep>0)updateStep(currentStep-1);});
document.getElementById('nextBtn').addEventListener('click',()=>{if(currentStep<TOTAL_STEPS)updateStep(currentStep+1);});
document.getElementById('resetBtn').addEventListener('click',()=>{if(isPlaying)playBtn.click();updateStep(0);});

document.querySelectorAll('.speed-pill').forEach(p=>p.addEventListener('click',()=>{
  document.querySelectorAll('.speed-pill').forEach(x=>x.classList.remove('active'));
  p.classList.add('active');playSpeed=+p.dataset.speed;
  if(isPlaying){clearInterval(playInterval);playBtn.click();}
}));

document.getElementById('floodOpSlider').addEventListener('input',e=>{
  floodOpacity=+e.target.value/100;
  document.getElementById('floodOpVal').textContent=e.target.value+'%';
  waterMeshes.forEach(m=>{if(m.material?.uniforms?.uOpacity)m.material.uniforms.uOpacity.value=floodOpacity;});
});
document.getElementById('zoomInBtn').addEventListener('click',()=>{try{map.setZoom(map.getZoom()+1);}catch(e){}});
document.getElementById('zoomOutBtn').addEventListener('click',()=>{try{map.setZoom(map.getZoom()-1);}catch(e){}});
document.getElementById('toggle3DBtn').addEventListener('click',()=>{
  is3DMode=!is3DMode;
  document.getElementById('toggle3DBtn').classList.toggle('active',!is3DMode);
  try{map.setPitch(is3DMode?60:0);}catch(e){}
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
setStatus('Loading map SDK…');

loadThreeJS(()=>{
  setStatus('Loading map…');
  loadMapplsSDK(()=>{
    setStatus('Initialising map…');

    try{
      map = new mappls.Map('map', {
        center: {lat:28.4595, lng:77.0266},
        zoom: 13, pitch: 0, bearing: 0,
        zoomControl: false, attributionControl: false
      });
    }catch(e){
      setStatus('❌ Map init failed: ' + e.message);
      console.error(e);
      return;
    }

    document.getElementById('toggle3DBtn').classList.add('active');

    let threeReady = false;
    function boot3(){
      if(threeReady||!window.THREE)return;threeReady=true;
      glMap=map;modelTransform=buildTransform();
      try{map.addLayer(customLayer);}catch(e){console.warn('Layer add:',e);}
      if(!rafId){
        const loop=()=>{
          animClock+=0.016;
          waterMeshes.forEach(m=>{if(m.material?.uniforms?.uTime)m.material.uniforms.uTime.value=animClock;});
          if(glMap)glMap.triggerRepaint();
          rafId=requestAnimationFrame(loop);
        };
        rafId=requestAnimationFrame(loop);
      }
    }
    map.on('load', boot3);
    map.on('style.load', boot3);
    setTimeout(()=>{if(!threeReady)boot3();}, 6000);

    let syncRaf=null;
    const scheduleMapSync=()=>{
      if(syncRaf)return;
      syncRaf=requestAnimationFrame(()=>{
        syncRaf=null;
        syncAllMarkers();
        updateScaleBars();
      });
    };
    ['move','zoom','pitch','rotate','resize'].forEach(ev=>map.on(ev,scheduleMapSync));

    map.on('load', ()=>{
      initSearch();
      loadAllAssets();
      removeAttribution();
      initializeVisualization();
      updateScaleBars();
      syncFullscreenState();
    });

    setTimeout(()=>{
      if(document.getElementById('loadingProgress').textContent==='Initialising map…'){
        initSearch();loadAllAssets();removeAttribution();
        initializeVisualization();
        updateScaleBars();
        syncFullscreenState();
      }
    }, 8000);
  });
});

})();
