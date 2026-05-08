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
const PLANE_SEG=192;
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
  {max:0.5,label:' ',bg:'#e6f7f9',color:'#0e7490',dot:'#B3EBF7'},
  {max:1.0,label:'Moderate',bg:'#cceef5',color:'#0369a1',dot:'#7BCFEE'},
  {max:2.0,label:'High',bg:'#b3dde8',color:'#155e75',dot:'#4B93C8'},
  {max:Infinity,label:'Severe',bg:'#264351',color:'#fff',dot:'#0D2E61'}
];
const fpPopup=document.getElementById('floodPopup');
let fpLat=null,fpLng=null;
document.getElementById('fpClose').addEventListener('click',()=>{fpPopup.style.display='none';fpLat=fpLng=null;});

// position popup at pixel coords (px, py) on screen, centred-above the click point
function placeFloodPopup(px,py){
  // ensure it's in the DOM and visible so offsetWidth/Height are real
  const w=fpPopup.offsetWidth||220;
  const h=fpPopup.offsetHeight||160;
  const margin=12;
  const vpW=window.innerWidth,vpH=window.innerHeight;
  let left=px-w/2;
  let top=py-h-margin;
  // clamp to viewport
  left=Math.max(margin,Math.min(left,vpW-w-margin));
  top=Math.max(margin,Math.min(top,vpH-h-margin));
  fpPopup.style.left=left+'px';
  fpPopup.style.top=top+'px';
}

function repositionFloodPopup(){
  if(fpPopup.style.display==='none'||fpLat===null)return;
  try{
    const container=fpPopupContainer();
    if(fpPopup.parentNode!==container)container.appendChild(fpPopup);
    const rect=document.getElementById('map').getBoundingClientRect();
    const pt=map.project({lat:fpLat,lng:fpLng});
    placeFloodPopup(rect.left+pt.x,rect.top+pt.y);
  }catch(e){}
}

function fpPopupContainer(){
  // In fullscreen the popup must live inside the fullscreen element or it is hidden
  return document.fullscreenElement||document.body;
}

function showFloodPopup(screenX,screenY,lng,lat,depth){
  const sev=SEV.find(s=>depth<s.max);
  fpLat=lat;fpLng=lng;
  document.getElementById('fpVal').textContent=depth.toFixed(2);
  const badge=document.getElementById('fpBadge');
  badge.style.background=sev.bg;badge.style.color=sev.color;
  document.getElementById('fpDot').style.background=sev.dot;
  document.getElementById('fpLabel').textContent=sev.label;
  document.getElementById('fpTime').textContent=document.getElementById('timeDisplay').textContent;
  document.getElementById('fpCoords').textContent=`${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`;
  fpPopup.className='sev-'+sev.label.toLowerCase();
  const container=fpPopupContainer();
  if(fpPopup.parentNode!==container)container.appendChild(fpPopup);
  fpPopup.style.display='block';
  void fpPopup.offsetWidth;
  placeFloodPopup(screenX,screenY);
  fpPopup.classList.add('fp-visible');
}

async function tryFloodHit(screenX,screenY,lat,lng){
  if(!polygonRings)return false;
  const depths=await getDepth(currentStep);if(!depths)return false;
  for(let p=0;p<polygonCount;p++){
    if(depths[p]<=0)continue;
    if(pointInPolygon(lng,lat,polygonRings[p])){showFloodPopup(screenX,screenY,lng,lat,depths[p]);return true;}
  }
  return false;
}

// ── Critical Assets ───────────────────────────────────────────────────────────
const CRITICAL_ASSETS = [
  { key:'hospital',     label:'Hospitals',       icon:'🏥', accent:'#ef4444', amenity:['hospital']             },
  { key:'school',       label:'Schools',         icon:'🏫', accent:'#10b981', amenity:['school']               },
  { key:'college',      label:'Colleges',        icon:'🎓', accent:'#06b6d4', amenity:['college','university'] },
  { key:'fire_station', label:'Fire Stations',   icon:'🚒', accent:'#f43f5e', amenity:['fire_station']         },
  { key:'police',       label:'Police Stations', icon:'🚔', accent:'#6366f1', amenity:['police']               },
  { key:'pharmacy',     label:'Pharmacies',      icon:'💊', accent:'#14b8a6', amenity:['pharmacy']             },
];

const GURUGRAM_BBOX = '28.20,76.70,28.60,77.30';
const _OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const _assetMarkers = {};  // key → [{el, lat, lng, posUpdate}]
const _assetResults = {};  // key → [{name,lat,lng,address}]
const _assetVisible = {};  // key → boolean
CRITICAL_ASSETS.forEach(c => { _assetMarkers[c.key] = []; _assetVisible[c.key] = false; });

function clearAssetMarkers(code) {
  _assetMarkers[code].forEach(m => m.el.remove());
  _assetMarkers[code] = [];
}

function syncAllMarkers() {
  CRITICAL_ASSETS.forEach(c => _assetMarkers[c.key].forEach(m => m.posUpdate()));
  repositionFloodPopup();
}

function _renderAssetMarkers(code, locs) {
  if (!map) return;
  clearAssetMarkers(code);
  if (!_assetVisible[code]) return;
  const cfg   = CRITICAL_ASSETS.find(c => c.key === code);
  const mapEl = document.getElementById('map');

  locs.forEach(loc => {
    const { lat, lng, name, address } = loc;

    const el = document.createElement('div');
    el.className = 'osm-label-marker';
    el.style.borderColor = cfg.accent;
    el.style.color = cfg.accent;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'label-icon';
    iconSpan.textContent = cfg.icon;
    el.appendChild(iconSpan);
    const textSpan = document.createElement('span');
    textSpan.className = 'label-text';
    textSpan.textContent = name;
    el.appendChild(textSpan);
    mapEl.appendChild(el);

    const posUpdate = () => {
      try {
        const pt = map.project({ lat, lng });
        el.style.transform = `translate3d(${pt.x}px,${pt.y}px,0) translate(-50%,-100%)`;
      } catch(e) {}
    };
    posUpdate();

    el.addEventListener('click', ev => {
      ev.stopPropagation();
      document.querySelectorAll('.osm-popup').forEach(p => p.remove());
      const pop = document.createElement('div');
      pop.className = 'osm-popup';
      pop.innerHTML = `<button class="popup-close">✕</button>
        <div class="popup-name">${esc(name)}</div>
        <div class="popup-type">${esc(cfg.label)}</div>
        ${address ? `<div class="popup-addr">${esc(address)}</div>` : ''}`;
      const setPopPos = () => {
        try {
          const pt = map.project({ lat, lng });
          pop.style.transform = `translate3d(${pt.x}px,${pt.y - 44}px,0)`;
        } catch(e) {}
      };
      setPopPos();
      mapEl.appendChild(pop);
      map.on('move', setPopPos);
      pop.querySelector('.popup-close').addEventListener('click', () => {
        pop.remove();
        try { map.off('move', setPopPos); } catch(e) {}
      });
    });

    _assetMarkers[code].push({ el, lat, lng, posUpdate });
  });
}

function _setCount(code, n) {
  const el = document.getElementById('asset-count-' + code);
  if (el) el.textContent = n;
}

function _buildAssetRows() {
  const grid = document.getElementById('assetGrid');
  if (!grid) return;
  grid.innerHTML = CRITICAL_ASSETS.map(cfg =>
    `<div class="asset-row" data-code="${cfg.key}" style="--row-accent:${cfg.accent}">
       <span class="asset-row-icon">${cfg.icon}</span>
       <span class="asset-row-label">${cfg.label}</span>
       <span class="asset-row-count" id="asset-count-${cfg.key}">—</span>
     </div>`
  ).join('');

  grid.querySelectorAll('.asset-row').forEach(row => {
    const code = row.dataset.code;
    _assetVisible[code] = false;
    row.classList.add('asset-row--off');
    row.addEventListener('click', () => {
      _assetVisible[code] = !_assetVisible[code];
      row.classList.toggle('asset-row--off', !_assetVisible[code]);
      if (_assetVisible[code]) {
        if (_assetResults[code]) _renderAssetMarkers(code, _assetResults[code]);
      } else {
        clearAssetMarkers(code);
      }
    });
  });
}

// Single batched query with dual-endpoint retry/backoff
async function _fetchAllCategories() {
  const stmts = CRITICAL_ASSETS.flatMap(cfg =>
    cfg.amenity.flatMap(a => [
      `node["amenity"="${a}"](${GURUGRAM_BBOX});`,
      `way["amenity"="${a}"](${GURUGRAM_BBOX});`,
    ])
  ).join('');
  const query = `[out:json][timeout:60];(${stmts});out center tags;`;

  for (let i = 0; i < 4; i++) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 65000);
      const res  = await fetch(
        _OVERPASS_ENDPOINTS[i % 2] + '?data=' + encodeURIComponent(query),
        { signal: ctrl.signal }
      );
      clearTimeout(tid);
      if (res.status === 429 || res.status === 504) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) { await sleep(1500); continue; }
      const json = await res.json();

      const amenityToCode = {};
      CRITICAL_ASSETS.forEach(cfg => cfg.amenity.forEach(a => { amenityToCode[a] = cfg.key; }));
      const buckets = {};
      CRITICAL_ASSETS.forEach(cfg => { buckets[cfg.key] = []; });

      for (const el of json.elements || []) {
        const amenity = el.tags?.amenity;
        const code = amenityToCode[amenity];
        if (!code) continue;
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (!lat || !lng) continue;
        buckets[code].push({
          name: el.tags?.name || el.tags?.['name:en'] || 'Unnamed',
          lat, lng,
          address: [
            el.tags?.['addr:housenumber'],
            el.tags?.['addr:street'] || el.tags?.['addr:place'],
            el.tags?.['addr:city']   || el.tags?.['addr:district'],
          ].filter(Boolean).join(', '),
        });
      }
      return buckets;
    } catch(e) {
      if (i < 3) await sleep(1500 * (i + 1));
    }
  }
  throw new Error('All Overpass endpoints failed');
}

function loadAllAssets() {
  _buildAssetRows();
  const ab = document.getElementById('assetBadge');
  if (ab) { ab.textContent = 'Loading…'; ab.style.background = ''; ab.style.color = ''; }

  _fetchAllCategories().then(buckets => {
    for (const [code, locs] of Object.entries(buckets)) {
      _assetResults[code] = locs;
      _setCount(code, locs.length);
      _renderAssetMarkers(code, locs);
    }
    if (ab) { ab.textContent = 'Ready'; ab.style.background = '#B1DEE2'; ab.style.color = '#264351'; }
  }).catch(err => {
    console.warn('[Assets] Overpass failed:', err);
    if (ab) { ab.textContent = 'Failed'; ab.style.background = '#fde68a'; ab.style.color = '#92400e'; }
  });
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
    const{x:sx,y:sy}=e.point;
    const rect=document.getElementById('map').getBoundingClientRect();
    document.querySelectorAll('.asset-popup').forEach(p=>p.remove());
    // Road overlay click is handled by the layer-specific handler; skip here
    if(roadOverlayEnabled&&map.queryRenderedFeatures(e.point,{layers:['flooded-roads-fill']}).length)return;
    const hit=await tryFloodHit(rect.left+sx,rect.top+sy,lat,lng);if(hit)return;
    fpPopup.style.display='none';fpLat=fpLng=null;
    roadPopup.style.display='none';rpLat=rpLng=null;
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
  repositionFloodPopup();
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
// Ripple: xy = local XZ position, z = time of impact (uTime value when triggered)
uniform vec3 uRipple0;
uniform vec3 uRipple1;
uniform vec3 uRipple2;
uniform vec3 uRipple3;
varying float vDepth;
varying vec2 vUv;
varying vec3 vWP;

float rippleDisplace(vec3 rip, vec3 p, float t){
  if(rip.z < 0.0) return 0.0;
  float age = t - rip.z;
  if(age < 0.0 || age > 2.2) return 0.0;
  float dist = length(vec2(p.x - rip.x, p.z - rip.y));
  float speed = 18.0;
  float wavefront = age * speed;
  float falloff = exp(-dist * 0.012) * exp(-age * 1.8);
  float wave = sin((dist - wavefront) * 0.55) * falloff * 0.6;
  return wave * smoothstep(0.0, 0.4, age) * (1.0 - smoothstep(1.8, 2.2, age));
}

void main(){
  vUv = uv;
  float depth = texture2D(uDepthTex, uv).r;
  vDepth = depth;
  float df = smoothstep(0.0, 0.25, depth);
  float t = uTime;
  vec3 p = position;
  float w = sin(p.x*0.55 + t*1.7) * cos(p.z*0.60 + t*1.2)
          + 0.55*sin((p.x*0.90 - p.z*0.70)*0.85 + t*1.45);
  float rip = rippleDisplace(uRipple0, p, t)
            + rippleDisplace(uRipple1, p, t)
            + rippleDisplace(uRipple2, p, t)
            + rippleDisplace(uRipple3, p, t);
  p.y = (w * uWaveAmp + rip) * df;
  vWP = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
}`;

const FRAG_SRC=`
uniform float uTime;
uniform float uOpacity;
uniform float uMaxDepth;
uniform sampler2D uDepthTex;
uniform vec2 uTexelSize;
uniform vec3 uRipple0;
uniform vec3 uRipple1;
uniform vec3 uRipple2;
uniform vec3 uRipple3;
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

  // Ripple highlight: bright ring at the wavefront of each active ripple
  float ripHighlight = 0.0;
  for(int ri=0; ri<4; ri++){
    vec3 rip = (ri==0)?uRipple0:(ri==1)?uRipple1:(ri==2)?uRipple2:uRipple3;
    if(rip.z < 0.0) continue;
    float age = uTime - rip.z;
    if(age < 0.0 || age > 2.2) continue;
    float dist = length(vec2(vWP.x - rip.x, vWP.z - rip.y));
    float wavefront = age * 18.0;
    float ring = exp(-pow(dist - wavefront, 2.0) * 0.08) * exp(-age * 1.4) * 0.55;
    ripHighlight += ring;
  }
  col += vec3(0.75, 0.95, 1.0) * ripHighlight;

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
    renderer.resetState();renderer.render(scene,camera);
    // do NOT call triggerRepaint here — that causes an infinite repaint loop
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
      uWaveAmp:{value:0.18},
      uRipple0:{value:new THREE.Vector3(0,0,-1)},
      uRipple1:{value:new THREE.Vector3(0,0,-1)},
      uRipple2:{value:new THREE.Vector3(0,0,-1)},
      uRipple3:{value:new THREE.Vector3(0,0,-1)}
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
    setTimeout(()=>{
      document.getElementById('loadingOverlay').classList.add('hidden');
      updateStep(0);
    },400);
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
    document.getElementById('chunkLoadingIndicator').style.display='flex';
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
  // once avg depths are ready, init colours; then update per-step
  const nc=Math.floor(step/CHUNK_SIZE)+1;
  if(nc<TOTAL_CHUNKS&&!chunkCache.has(nc)&&!chunkQueue.has(nc))loadChunk(nc).catch(()=>{});
  const b=new Date('2025-07-09T01:55:00');b.setMinutes(b.getMinutes()+step*5);
  const z=n=>String(n).padStart(2,'0');
  document.getElementById('timeDisplay').textContent=`${z(b.getDate())}-${MONTHS[b.getMonth()]}-${b.getFullYear()} ${z(b.getHours())}:${z(b.getMinutes())}:${z(b.getSeconds())}`;
  const sl=document.getElementById('timeSlider');sl.value=step;
  sl.style.background=`linear-gradient(to right,#5298A9 ${(step/TOTAL_STEPS*100)}%,#e2e8f0 ${(step/TOTAL_STEPS*100)}%)`;
  scheduleRoadAnalysis(true);
}

// ── Road Inundation Analysis ──────────────────────────────────────────────────
const ROAD_CAUTION_M  = 0.001;
const ROAD_BLOCKED_M  = 0.30;
const ROAD_SRC_ID     = 'flooded-roads';
const ROAD_MIN_ZOOM   = 13;    // overlay only visible at this zoom level and above

let roadOverlayEnabled  = false;
let roadRafId           = null;
let _roadLastAnalysisTs = 0;

const roadPopup = document.getElementById('roadPopup');
let rpLat = null, rpLng = null;
document.getElementById('rpClose').addEventListener('click', () => {
  roadPopup.style.display = 'none'; rpLat = rpLng = null;
});

// ── Road geometry from Mappls rendered features ───────────────────────────────
// Query the map's own rendered road layers, deduplicate tile-clipped copies,
// pre-sample at fine intervals, and cache per viewport.  On each timestep the
// cached samples are tested against active flood polygons (no network calls).

let _roadCache   = null;   // [{ pts:[lng,lat][], name, cls }]
let _roadBbox    = null;   // { s,w,n,e } of the viewport when cache was built
let _polyBboxCache = null; // precomputed per-polygon bbox — recomputed only when polygonRings loads

const ROAD_LAYER_EXCLUDE = /label|symbol|text|icon|aeroway|ferry|rail|waterway|landuse|boundary|transit|tunnel.*casing|bridge.*casing/i;
const MINOR_CLS = /service|parking|footway|cycleway|path|pedestrian|track|steps|alley|driveway/i;
const MAX_ROAD_WAYS = 5000; // hard cap — worker handles the PIP, main thread stays free

function getRoadLayerIds() {
  if (!map) return [];
  return map.getStyle().layers
    .filter(l => l.type === 'line' && !ROAD_LAYER_EXCLUDE.test(l.id))
    .map(l => l.id);
}

// Sample step coarsens with zoom so point counts stay bounded.
function roadSampleStep() {
  const z = map ? map.getZoom() : 14;
  if (z >= 14) return 12;
  if (z >= 13) return 20;
  if (z >= 12) return 40;
  if (z >= 11) return 80;
  return 160;
}

// Build the road sample cache from currently rendered Mappls features.
// Called once on toggle-enable and on moveend; timestep updates skip this.
function buildRoadCache() {
  if (!map) return;
  const zoom = map.getZoom();
  if (zoom < ROAD_MIN_ZOOM) {
    _roadCache = [];
    map.getSource(ROAD_SRC_ID)?.setData({ type:'FeatureCollection', features:[] });
    updateRoadPanel([]);
    return;
  }

  const layerIds = getRoadLayerIds();
  if (!layerIds.length) return;

  // Query the full viewport — idle event guarantees all tiles are loaded
  const raw  = map.queryRenderedFeatures(undefined, { layers: layerIds });
  const seen = new Set();
  const samples = [];
  const step = roadSampleStep();

  for (const f of raw) {
    if (samples.length >= MAX_ROAD_WAYS) break;
    const lines =
      f.geometry.type === 'LineString'     ? [f.geometry.coordinates] :
      f.geometry.type === 'MultiLineString' ? f.geometry.coordinates  : [];

    const name = f.properties?.name || f.properties?.ref || '';
    const cls  = (f.properties?.class || f.properties?.road_class ||
                  f.properties?.type  || f.properties?.highway || '').toLowerCase();
    if (cls && MINOR_CLS.test(cls)) continue;

    for (const line of lines) {
      if (line.length < 2) continue;
      const key = `${line[0][0].toFixed(5)},${line[0][1].toFixed(5)}|` +
                  `${line[line.length-1][0].toFixed(5)},${line[line.length-1][1].toFixed(5)}|` +
                  line.length;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({ pts: sampleRoadLine(line, step), name, cls });
      if (samples.length >= MAX_ROAD_WAYS) break;
    }
  }

  const b = map.getBounds();
  _roadBbox  = { s:b.getSouth(), w:b.getWest(), n:b.getNorth(), e:b.getEast() };
  _roadCache = samples;
  console.log(`[FloodTwin] Road cache: ${samples.length} ways (step=${step}m, zoom=${zoom.toFixed(1)})`);
}

// Precompute polygon bboxes once so getActiveFloodPolygons never recomputes them.
function ensurePolyBboxCache() {
  if (_polyBboxCache || !polygonRings) return;
  _polyBboxCache = new Float32Array(polygonCount * 4); // [minLng,maxLng,minLat,maxLat] * N
  for (let p = 0; p < polygonCount; p++) {
    const ring = polygonRings[p];
    if (!ring) continue;
    let minLng=Infinity,maxLng=-Infinity,minLat=Infinity,maxLat=-Infinity;
    for (const v of ring) {
      if (v.lng < minLng) minLng=v.lng; if (v.lng > maxLng) maxLng=v.lng;
      if (v.lat < minLat) minLat=v.lat; if (v.lat > maxLat) maxLat=v.lat;
    }
    const i = p * 4;
    _polyBboxCache[i]=minLng; _polyBboxCache[i+1]=maxLng;
    _polyBboxCache[i+2]=minLat; _polyBboxCache[i+3]=maxLat;
  }
}


function lngLatDistM(a, b) {
  const R = 6371000, dLat = (b[1]-a[1])*Math.PI/180, dLng = (b[0]-a[0])*Math.PI/180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a[1]*Math.PI/180)*Math.cos(b[1]*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(Math.min(1, s)));
}

// Interpolate along a LineString at ~stepM metre intervals (fine enough for
// narrow flood polygons; coarse enough to stay fast for many roads at once)
function sampleRoadLine(coords, stepM = 8) {
  const pts = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i+1];
    const n = Math.max(1, Math.round(lngLatDistM(a, b) / stepM));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push([a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t]);
    }
  }
  return pts;
}

// Build a bbox-indexed list of active flood polygons for this timestep.
// Only polygons visible in the current map viewport are included, cutting the
// candidate set from ~78k down to the tens actually on screen.
// Each entry carries precomputed bbox so pointInPolygon is only called when
// the sample point is inside the bbox — fast reject avoids the ray-cast.
function getActiveFloodPolygons() {
  if (!polygonRings || !lastDepths || !map) return [];
  ensurePolyBboxCache();
  const b = map.getBounds();
  const vMinLng = b.getWest(), vMaxLng = b.getEast();
  const vMinLat = b.getSouth(), vMaxLat = b.getNorth();

  const active = [];
  for (let p = 0; p < polygonCount; p++) {
    const d = lastDepths[p];
    if (d < ROAD_CAUTION_M) continue;
    const ring = polygonRings[p];
    if (!ring || ring.length < 3) continue;

    const i = p * 4;
    const minLng=_polyBboxCache[i], maxLng=_polyBboxCache[i+1];
    const minLat=_polyBboxCache[i+2], maxLat=_polyBboxCache[i+3];
    if (maxLng < vMinLng || minLng > vMaxLng || maxLat < vMinLat || minLat > vMaxLat) continue;

    active.push({ ring, depth: d, minLng, maxLng, minLat, maxLat });
  }
  return active;
}

// Build GeoJSON of flooded road stretches by clipping Mappls road lines
// against active flood polygons for the current timestep.
// Fast path: bbox reject before ray-cast keeps this well under 1 ms even at
// peak flood extent.
function buildFloodedRoadGFC() {
  if (!_roadCache?.length) return { type:'FeatureCollection', features:[] };

  const active = getActiveFloodPolygons();
  if (!active.length) return { type:'FeatureCollection', features:[] };

  const out = [];

  for (const { pts, name, cls } of _roadCache) {
    let inFlood = false, seg = [], maxD = 0;

    const flush = () => {
      if (seg.length >= 2) out.push({
        type: 'Feature',
        geometry: { type:'LineString', coordinates: seg },
        properties: { name, cls, maxDepth: maxD,
          status: maxD >= ROAD_BLOCKED_M ? 'blocked' : 'caution' }
      });
    };

    for (const pt of pts) {
      const lng = pt[0], lat = pt[1];
      let ptDepth = 0;
      for (const { ring, depth, minLng, maxLng, minLat, maxLat } of active) {
        // Bbox reject — avoids ray-cast for the vast majority of polygons
        if (depth <= ptDepth) continue;
        if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
        if (pointInPolygon(lng, lat, ring)) ptDepth = depth;
      }

      if (ptDepth >= ROAD_CAUTION_M) {
        if (!inFlood) { inFlood = true; seg = []; maxD = 0; }
        if (ptDepth > maxD) maxD = ptDepth;
        seg.push(pt);
      } else if (inFlood) {
        inFlood = false;
        flush();
      }
    }
    if (inFlood) flush();
  }

  return { type:'FeatureCollection', features: out };
}

// Reverse-geocode a road name via Nominatim; cache by ~50m grid cell to avoid
// redundant requests when the user clicks nearby points on the same road.
const _roadNameCache = {};
async function _roadNameAtPoint(lat, lng) {
  const cell = `${(lat / 0.0005 | 0)},${(lng / 0.0005 | 0)}`;
  if (_roadNameCache[cell] !== undefined) return _roadNameCache[cell];
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&zoom=16&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const name = d?.address?.road || d?.address?.suburb
               || d?.address?.neighbourhood || d?.name || '';
    _roadNameCache[cell] = name;
    return name;
  } catch(e) {
    _roadNameCache[cell] = '';
    return '';
  }
}

// Set up MapLibre source + three layers (halo, colour fill, centre dash)
function initRoadOverlay() {
  if (!map || map.getSource(ROAD_SRC_ID)) return;

  map.addSource(ROAD_SRC_ID, { type:'geojson', data:{ type:'FeatureCollection', features:[] } });

  // Colour-coded severity line
  map.addLayer({
    id:'flooded-roads-fill', type:'line', source:ROAD_SRC_ID,
    layout:{ 'line-cap':'round','line-join':'round' },
    paint:{
      'line-color':['case',
        ['>=',['get','maxDepth'],0.60],'#dc2626',
        ['>=',['get','maxDepth'],0.30],'#f97316',
        '#fbbf24'
      ],
      'line-width':['interpolate',['linear'],['get','maxDepth'],0.10,5,2.0,12],
      'line-opacity':0.93
    }
  });

  // White centre dash for a "road closed" look
  map.addLayer({
    id:'flooded-roads-dash', type:'line', source:ROAD_SRC_ID,
    layout:{ 'line-cap':'butt','line-join':'round' },
    paint:{
      'line-color':'#fff','line-width':1.5,
      'line-opacity':0.50,'line-dasharray':[3,5]
    }
  });

  // Pointer cursor on hover
  map.on('mouseenter','flooded-roads-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave','flooded-roads-fill', () => { map.getCanvas().style.cursor = ''; });

  // Click a flooded road segment → show road popup
  map.on('click','flooded-roads-fill', e => {
    if (!e.features?.length) return;
    const props = e.features[0].properties;
    const { lat, lng } = e.lngLat;
    rpLat = lat; rpLng = lng;
    const depth = +props.maxDepth;
    const nameEl = document.getElementById('rpName');
    nameEl.textContent = props.name || 'Loading…';
    _roadNameAtPoint(lat, lng).then(n => {
      nameEl.textContent = n || props.name || 'Unnamed road';
    });
    document.getElementById('rpVal').textContent  = depth.toFixed(2);
    const sev =
      depth >= 0.60 ? { label:'Impassable', cls:'rp-severe'  } :
      depth >= 0.30 ? { label:'Blocked (vehicles)', cls:'rp-blocked' } :
                      { label:'Caution — slow', cls:'rp-caution' };
    const statusEl = document.getElementById('rpStatus');
    statusEl.textContent = sev.label;
    statusEl.className = 'rp-status ' + sev.cls;
    const container = fpPopupContainer();
    if (roadPopup.parentNode !== container) container.appendChild(roadPopup);
    const rect = document.getElementById('map').getBoundingClientRect();
    const pt   = map.project({ lat, lng });
    placeRoadPopup(rect.left + pt.x, rect.top + pt.y);
    roadPopup.style.display = 'block';
  });

  // Rebuild road cache whenever the view changes and tiles have fully loaded.
  // Track whether the viewport actually moved so flood-layer updates don't
  // trigger an unnecessary cache rebuild.
  let _roadViewDirty = false;
  map.on('moveend', () => { if (roadOverlayEnabled) _roadViewDirty = true; });
  map.on('zoomend',  () => { if (roadOverlayEnabled) _roadViewDirty = true; });
  map.on('idle', () => {
    if (!roadOverlayEnabled || !_roadViewDirty) return;
    _roadViewDirty = false;
    buildRoadCache();
    scheduleRoadAnalysis(true);
  });
}

function placeRoadPopup(px, py) {
  const w = roadPopup.offsetWidth  || 200;
  const h = roadPopup.offsetHeight || 130;
  const margin = 12, vpW = window.innerWidth, vpH = window.innerHeight;
  let left = px - w/2, top = py - h - margin;
  left = Math.max(margin, Math.min(left, vpW-w-margin));
  top  = Math.max(margin, Math.min(top,  vpH-h-margin));
  roadPopup.style.left = left + 'px';
  roadPopup.style.top  = top  + 'px';
}

let _roadWorker = null;
let _roadWorkerBusy = false;
let _roadPendingUpdate = false; // a new timestep arrived while worker was busy

function getRoadWorker() {
  if (!_roadWorker) {
    _roadWorker = new Worker('/static/js/road_worker.js');
    _roadWorker.onmessage = (e) => {
      _roadWorkerBusy = false;
      if (!roadOverlayEnabled) {
        // Overlay was disabled while worker was running — discard result
        _roadPendingUpdate = false;
        return;
      }
      map.getSource(ROAD_SRC_ID)?.setData(e.data);
      updateRoadPanel(e.data.features);
      if (_roadPendingUpdate) {
        _roadPendingUpdate = false;
        _dispatchToWorker();
      }
    };
  }
  return _roadWorker;
}

function _dispatchToWorker() {
  if (!_roadCache?.length || !roadOverlayEnabled) return;
  const activePolygons = getActiveFloodPolygons();
  if (!activePolygons.length) {
    map.getSource(ROAD_SRC_ID)?.setData({ type:'FeatureCollection', features:[] });
    updateRoadPanel([]);
    return;
  }
  _roadWorkerBusy = true;
  _roadLastAnalysisTs = performance.now();
  getRoadWorker().postMessage({ roadCache: _roadCache, activePolygons, ROAD_CAUTION_M, ROAD_BLOCKED_M });
}

function scheduleRoadAnalysis(force = false) {
  if (!roadOverlayEnabled) return;
  if (!map || map.getZoom() < ROAD_MIN_ZOOM) {
    map.getSource(ROAD_SRC_ID)?.setData({ type:'FeatureCollection', features:[] });
    updateRoadPanel([]);
    return;
  }
  if (roadRafId) cancelAnimationFrame(roadRafId);
  roadRafId = requestAnimationFrame(() => {
    roadRafId = null;
    if (_roadWorkerBusy) {
      _roadPendingUpdate = true;
      return;
    }
    _dispatchToWorker();
  });
}

function updateRoadPanel(segs) {
  const listEl  = document.getElementById('roadList');
  const badgeEl = document.getElementById('roadBadge');
  if (!listEl || !badgeEl) return;

  const nBlocked = segs.filter(s => s.properties.status === 'blocked').length;
  const nCaution = segs.filter(s => s.properties.status === 'caution').length;
  badgeEl.textContent = nBlocked ? `${nBlocked} blocked` :
                        nCaution ? `${nCaution} caution` : 'All clear';
  badgeEl.className = 'panel-badge ' +
    (nBlocked ? 'rb-blocked' : nCaution ? 'rb-caution' : 'rb-clear');

  if (!segs.length) {
    listEl.innerHTML = '<p class="road-empty">No flooded roads in current viewport</p>';
    return;
  }

  // Group by road name — keep the worst-depth stretch per name
  const byName = new Map();
  for (const s of segs) {
    const k = s.properties.name || '(unnamed road)';
    const e = byName.get(k);
    if (!e || s.properties.maxDepth > e.maxDepth) {
      const mid = s.geometry.coordinates[Math.floor(s.geometry.coordinates.length / 2)];
      byName.set(k, { ...s.properties, mid });
    }
  }

  listEl.innerHTML = [...byName.entries()]
    .sort((a, b) => b[1].maxDepth - a[1].maxDepth)
    .map(([name, p]) => {
      const icon  = p.status === 'blocked' ? '🚫' : '⚠️';
      const label = p.maxDepth >= 0.60 ? 'Impassable' :
                    p.maxDepth >= 0.30 ? 'Blocked' : 'Caution';
      const cls   = p.status === 'blocked' ? 'road-blocked' : 'road-caution';
      return `<div class="road-item ${cls}" data-lat="${p.mid[1]}" data-lng="${p.mid[0]}">
        <span class="ri-icon">${icon}</span>
        <div class="ri-body">
          <span class="ri-name">${esc(name)}</span>
          <span class="ri-depth">${p.maxDepth.toFixed(2)} m — ${label}</span>
        </div>
      </div>`;
    }).join('');

  listEl.querySelectorAll('.road-item').forEach(el => {
    el.addEventListener('click', () => {
      const lat = +el.dataset.lat, lng = +el.dataset.lng;
      try { map.flyTo({ center:{lat,lng}, zoom:16, pitch:40 }); } catch(e) {}
    });
  });
}

document.getElementById('roadOverlayToggle').addEventListener('click', () => {
  roadOverlayEnabled = !roadOverlayEnabled;
  const btn = document.getElementById('roadOverlayToggle');
  btn.classList.toggle('active', roadOverlayEnabled);
  btn.textContent = roadOverlayEnabled ? 'Disable Road Overlay' : 'Enable Road Overlay';

  if (!roadOverlayEnabled) {
    map.getSource(ROAD_SRC_ID)?.setData({ type:'FeatureCollection', features:[] });
    updateRoadPanel([]);
    roadPopup.style.display = 'none';
    _roadPendingUpdate = false;
  } else {
    const zoom = map?.getZoom() ?? 0;
    if (zoom < ROAD_MIN_ZOOM) {
      // Tell user to zoom in — don't build cache yet
      const listEl = document.getElementById('roadList');
      if (listEl) listEl.innerHTML = `<p class="road-empty">Zoom in to level ${ROAD_MIN_ZOOM}+ to see road overlay</p>`;
      document.getElementById('roadBadge').textContent = 'Zoom in';
    } else {
      buildRoadCache();
      scheduleRoadAnalysis(true);
    }
  }
});

// ── UI controls ───────────────────────────────────────────────────────────────
function removeAttribution(){
  ['.mappls-copyright','.mappls-logo','.mappls-watermark','.maplibregl-ctrl-attrib','.mappls-ctrl-attrib','[class*="mappls-logo"]','[class*="mappls-watermark"]','[class*="maplibregl-ctrl-logo"]','.maplibregl-ctrl-bottom-left','.maplibregl-ctrl-bottom-right','.mappls-ctrl-bottom-left','.mappls-ctrl-bottom-right','a[href*="mappls"]','a[href*="mapmyindia"]','img[src*="mappls"]','img[src*="mapmyindia"]'].forEach(sel=>document.querySelectorAll(sel).forEach(el=>{el.style.cssText='display:none!important';}));
}
setInterval(removeAttribution,5000);

function toggleSidebar(){
  const sb=document.getElementById('sidebar'),ham=document.getElementById('hamburgerBtn');
  const c=sb.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed',c);
  ham.classList.toggle('open',!c);
}
document.getElementById('hamburgerBtn').addEventListener('click',toggleSidebar);
document.getElementById('brandSidebarToggle').addEventListener('click',toggleSidebar);
document.getElementById('timeSlider').addEventListener('input',e=>updateStep(+e.target.value));
document.addEventListener('fullscreenchange',syncFullscreenState);

const playBtn=document.getElementById('playBtn');
const liveIndicator=document.getElementById('liveIndicator');
playBtn.addEventListener('click',()=>{
  isPlaying=!isPlaying;playBtn.classList.toggle('active',isPlaying);playBtn.innerHTML=isPlaying?'⏸':'▶';
  liveIndicator.classList.toggle('active',isPlaying);
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

// ── Building texture ──────────────────────────────────────────────────────────

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

    // Expose map for ES module features
    window._floodtwinMap = map;
    window.dispatchEvent(new CustomEvent('floodtwin:mapready', { detail: { map } }));

    let threeReady = false;
    function boot3(){
      if(threeReady||!window.THREE)return;threeReady=true;
      glMap=map;modelTransform=buildTransform();
      try{map.addLayer(customLayer);}catch(e){console.warn('Layer add:',e);}
      if(!rafId){
        let lastTs=0;
        const loop=(ts)=>{
          rafId=requestAnimationFrame(loop);
          const dt=Math.min((ts-lastTs)/1000,0.05);
          lastTs=ts;

          if(waterMeshes.length===0)return;

          animClock+=dt;
          waterMeshes.forEach(m=>{if(m.material?.uniforms?.uTime)m.material.uniforms.uTime.value=animClock;});

          if(glMap)glMap.triggerRepaint();
        };
        rafId=requestAnimationFrame(loop);
      }
    }
    map.on('load', boot3);
    map.on('style.load', ()=>{ boot3(); });
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
            initRoadOverlay();
    });

    setTimeout(()=>{
      if(document.getElementById('loadingProgress').textContent==='Initialising map…'){
        initSearch();loadAllAssets();removeAttribution();
        initializeVisualization();
        updateScaleBars();
        syncFullscreenState();
                initRoadOverlay();
      }
    }, 8000);
  });
});


})();
