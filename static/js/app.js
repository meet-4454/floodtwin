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
  {max:0.5,label:'Low',bg:'#e6f7f9',color:'#0e7490',dot:'#B3EBF7'},
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
  { key:'hospital',     label:'Hospitals',       icon:'🏥', accent:'#ef4444', amenity:['hospital'],             mapplsCat:'hospital'      },
  { key:'school',       label:'Schools',         icon:'🏫', accent:'#10b981', amenity:['school'],               mapplsCat:'school'        },
  { key:'college',      label:'Colleges',        icon:'🎓', accent:'#06b6d4', amenity:['college','university'], mapplsCat:'college'       },
  { key:'fire_station', label:'Fire Stations',   icon:'🚒', accent:'#f43f5e', amenity:['fire_station'],         mapplsCat:'fire station'  },
  { key:'police',       label:'Police Stations', icon:'🚔', accent:'#6366f1', amenity:['police'],               mapplsCat:'police'        },
  { key:'pharmacy',     label:'Pharmacies',      icon:'💊', accent:'#14b8a6', amenity:['pharmacy'],             mapplsCat:'pharmacy'      },
];

const GURUGRAM_BBOX     = '28.20,76.70,28.60,77.30';
const _OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
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

// Fetch critical-asset buckets. Primary path is the server proxy
// (/api/assets) which retries across several Overpass mirrors and caches the
// result — far more reliable than the browser hitting public Overpass
// directly. If the proxy is unreachable we fall back to a direct Overpass
// query so the feature still works when running the static files standalone.
async function _fetchAllCategories() {
  // ── Primary: server proxy ──────────────────────────────────────────────
  try {
    const res = await fetch('/api/assets?bbox=' + encodeURIComponent(GURUGRAM_BBOX));
    if (res.ok) {
      const buckets = await res.json();
      // Ensure every known category key exists even if absent in the response.
      CRITICAL_ASSETS.forEach(cfg => { buckets[cfg.key] = buckets[cfg.key] || []; });
      return buckets;
    }
  } catch(_) { /* fall through to direct Overpass */ }

  // ── Fallback: direct Overpass with multi-endpoint retry/backoff ─────────
  const stmts = CRITICAL_ASSETS.flatMap(cfg =>
    cfg.amenity.flatMap(a => [
      `node["amenity"="${a}"](${GURUGRAM_BBOX});`,
      `way["amenity"="${a}"](${GURUGRAM_BBOX});`,
    ])
  ).join('');
  const query = `[out:json][timeout:25];(${stmts});out center tags;`;

  for (let i = 0; i < 4; i++) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 30000);
      const res  = await fetch(
        _OVERPASS_ENDPOINTS[i % _OVERPASS_ENDPOINTS.length] + '?data=' + encodeURIComponent(query),
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
    // Critical-asset markers come exclusively from OSM (Overpass): both
    // coordinates AND names. No Mappls Nearby enrichment — names stay as
    // OSM reports them so the markers reflect a single, authoritative source.
    for (const [code, locs] of Object.entries(buckets)) {
      _assetResults[code] = locs;
      _setCount(code, locs.length);
      _renderAssetMarkers(code, locs);
    }
    if (ab) {
      ab.textContent = 'Ready';
      ab.style.background = '#B1DEE2'; ab.style.color = '#264351';
    }
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
uniform float uDepthHeight;
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
  float w = sin(p.x*0.55 + t*0.85) * cos(p.z*0.60 + t*0.60)
          + 0.55*sin((p.x*0.90 - p.z*0.70)*0.85 + t*0.72);
  float rip = rippleDisplace(uRipple0, p, t)
            + rippleDisplace(uRipple1, p, t)
            + rippleDisplace(uRipple2, p, t)
            + rippleDisplace(uRipple3, p, t);
  // Volumetric lift: deeper water sits higher. Wave + ripple bob is faded
  // out in shallow areas via df so edges don't shimmer.
  p.y = depth * uDepthHeight + (w * uWaveAmp + rip) * df;
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

  float t = uTime * 0.09;
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
  col = mix(col, vec3(0.92, 0.96, 1.0), F * 0.15);
  col += vec3(1.0, 0.98, 0.92) * spec * 0.20;

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
      uDepthHeight:{value:0.45},
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

  // Anchor the overlay just before the first 3D building (fill-extrusion) layer
  // in the *visible* (non-"_sea") stack. Mappls' style has two parallel stacks:
  // a "_sea" stack (~ids 168–408) that draws sea/coast variants below the main
  // road fills, and the main stack (~ids 499+) with the real road fills and
  // then the building extrusions `footprints_int_3d`, `footprints_ind*_3d`.
  // We must anchor *after* the main road fills but *before* the main building
  // extrusions, otherwise basemap road fills paint over our coloured lines.
  const _findFirstExtrusionId = () => {
    try {
      const layers = map.getStyle()?.layers || [];
      const main = layers.find(l => l.type === 'fill-extrusion' && !/_sea$/.test(l.id));
      return main?.id || layers.find(l => l.type === 'fill-extrusion')?.id;
    } catch { return undefined; }
  };

  const _initialAnchor = _findFirstExtrusionId();

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
      'line-opacity':0.55
    }
  }, _initialAnchor);

  // White centre dash for a "road closed" look
  map.addLayer({
    id:'flooded-roads-dash', type:'line', source:ROAD_SRC_ID,
    layout:{ 'line-cap':'butt','line-join':'round' },
    paint:{
      'line-color':'#fff','line-width':1.5,
      'line-opacity':0.35,'line-dasharray':[3,5]
    }
  }, _initialAnchor);

  // Keep the flooded-road overlay ABOVE the flood water but BEHIND the 3D
  // buildings, so at a low (pitched) camera the buildings occlude the road
  // colouring while it still paints on top of the water.
  //
  // The buildings are the Mappls basemap's native `fill-extrusion` layers
  // (`footprints_*_3d`) — NOT a custom 3D layer (the Three.js 'city-3d' scene
  // only renders trees/roads/stadiums). Native extrusions share MapLibre's
  // depth buffer with 2D layers in the same pass, so a `line` layer placed
  // *before* the first building extrusion is genuinely depth-occluded by the
  // buildings at a pitch. That occlusion is the user's hard requirement, so we
  // anchor the road layers immediately *before* the first non-"_sea" building
  // extrusion. (Anchoring relative to the building, not to 'water-surface', is
  // the fix: the building extrusions sit BELOW 'water-surface' in the array,
  // so the old "first building after water" search found none and dumped the
  // roads on top of everything — which is why occlusion never happened.)
  //
  // Re-asserted on every styledata event because the Mappls style reshuffles
  // its layers as tiles stream in. We pin a deterministic final order:
  //
  //   water-surface → flooded-roads-fill → flooded-roads-dash → <building>
  //
  // so the roads always paint ON TOP of the flood water (they come after it)
  // yet BEHIND the buildings (they come before the first extrusion). The
  // water-surface custom layer is created later (in boot3) just before the
  // road fill; once it exists we also pull it to sit immediately under the
  // road fill so the two never drift apart as the style restreams.
  let _lastAnchorLog = '';
  const _reanchorOverlay = () => {
    if (!map.getLayer('flooded-roads-fill')) return;
    let layers;
    try { layers = map.getStyle().layers; } catch { return; }

    // First non-"_sea" building extrusion in the stack — roads go just before
    // it so the buildings occlude them at a pitch.
    const buildingLayer = layers.find(
      l => l.type === 'fill-extrusion' && !/_sea$/.test(l.id)
    );
    const beforeId = buildingLayer?.id; // undefined → no extrusions yet
    const hasWater = !!map.getLayer('water-surface');

    // Log only when the computed anchor/water-presence actually changes, so we
    // see the transition once water appears without spamming every styledata.
    const sig = `${beforeId ?? '(top)'}|${hasWater}`;
    if (sig !== _lastAnchorLog) {
      _lastAnchorLog = sig;
      const wIdx = layers.findIndex(l => l.id === 'water-surface');
      const bIdx = layers.findIndex(l => l.id === beforeId);
      console.log(`[FloodTwin/roads] anchor before "${beforeId ?? '(top)'}" — water@${wIdx}, building@${bIdx}, totalLayers=${layers.length}`);
    }

    // moveLayer(id, beforeId) inserts `id` just before `beforeId` (or to the
    // top of the stack when beforeId is undefined). Order matters:
    //  1. water just before the building (so water sits below the roads),
    //  2. fill just before the building (lands after water → above water),
    //  3. dash just before the building (lands after fill → above fill).
    try {
      if (hasWater) map.moveLayer('water-surface', beforeId);
      map.moveLayer('flooded-roads-fill', beforeId);
      map.moveLayer('flooded-roads-dash', beforeId);
    } catch (e) { /* swallow — next styledata will retry */ }
  };
  map.on('styledata', _reanchorOverlay);
  _reanchorOverlay();

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

  // Rebuild the road overlay so it tracks the viewport as the user pans/zooms.
  // Two triggers, both gated on the overlay being on and the view having
  // actually changed (so flood-timestep repaints don't rebuild needlessly):
  //
  //   • A short debounce after moveend/zoomend → repopulates promptly while the
  //     user is still moving, rather than only once the map goes fully idle.
  //   • The idle event → a catch-up backstop for the final resting viewport and
  //     for moves where moveend/zoomend don't fire (inertial / programmatic).
  //
  // queryRenderedFeatures only returns features in the current viewport, so
  // each rebuild naturally drops roads that scrolled off-screen and picks up
  // ones that scrolled in.
  //
  // Two dirty flags decouple the eager preview from the authoritative pass:
  //   • the debounced rebuild gives a prompt preview while the user is moving,
  //     but may run before freshly-panned-in tiles have rendered;
  //   • idle then does the final rebuild once every tile is loaded, so newly
  //     revealed roads aren't missed even if the preview ran early.
  let _roadViewDirtyIdle = false;
  let _roadRebuildTimer = null;

  const _markRoadViewDirty = () => {
    if (!roadOverlayEnabled) return;
    _roadViewDirtyIdle = true;
    // Eager preview: rebuild ~150 ms after the last move event.
    clearTimeout(_roadRebuildTimer);
    _roadRebuildTimer = setTimeout(() => {
      if (!roadOverlayEnabled) return;
      buildRoadCache();
      scheduleRoadAnalysis(true);
    }, 150);
  };

  map.on('moveend', _markRoadViewDirty);
  map.on('zoomend', _markRoadViewDirty);
  map.on('idle', () => {
    if (!roadOverlayEnabled || !_roadViewDirtyIdle) return;
    _roadViewDirtyIdle = false;
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
      // Insert the water surface beneath the flood-road overlay so road
      // markings draw on top of the water.
      try{
        const beforeWater = map.getLayer('flooded-roads-fill') ? 'flooded-roads-fill' : undefined;
        map.addLayer(customLayer, beforeWater);
      }catch(e){console.warn('Layer add:',e);}
      if(!rafId){
        let lastTs=0;
        const loop=(ts)=>{
          rafId=requestAnimationFrame(loop);
          const dt=Math.min((ts-lastTs)/1000,0.05);
          lastTs=ts;

          // Tick campus-life (vehicles march along road paths). Done
          // before the water-empty bail-out so vehicles still move when
          // flood data hasn't loaded yet.
          if (typeof tickCampusLife === 'function') tickCampusLife(dt);
          // If campus-life is active (vehicles exist), trigger a repaint
          // each frame so the moving meshes render. Without this the map
          // only repaints on user-input events and vehicles would freeze.
          if (cityState.vehicles?.length && glMap) glMap.triggerRepaint();

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


// ── 3D City overlay (LULC from prediction.geojson) ──────────────────────────
// A separate Three.js custom layer pinned to the geojson centroid (Ahmedabad).
// Loads the polygon footprints and instances roads.glb / trees.glb at each
// Road / Tree polygon's centroid, scaled to its bbox. Grass is intentionally
// skipped for now — the 71 MB grass.glb needs to be optimised before shipping.
const CITY_REF_LNG = 72.6881, CITY_REF_LAT = 23.2144;
// Soil replaces grass on the Grass-class polygons (gives a soil-ground look).
const CITY_CLASSES_ENABLED = { Tree: 'trees.glb' };
// Maps each enabled class key → the geojson `class_name` to consume.
const CITY_CLASS_TO_GEOJSON = { Tree: 'Tree', Soil: 'Grass' };

let cityState = {
  inited:    false,
  buildOnce: null,           // Promise that resolves when scene is built
  scene:     null,
  camera:    null,
  renderer:  null,
  transform: null,
  meshes:    [],
  cullables: [],             // per-cell InstancedMeshes flipped by the culler
  enabled:   false,
};

function buildCityTransform(){
  const MC = window.maplibregl?.MercatorCoordinate;
  if (MC) {
    const c = MC.fromLngLat([CITY_REF_LNG, CITY_REF_LAT], 0);
    return {
      translateX: c.x, translateY: c.y, translateZ: c.z,
      rotateX:    Math.PI / 2, rotateY: 0, rotateZ: 0,
      scale:      c.meterInMercatorCoordinateUnits(),
    };
  }
  const x = (CITY_REF_LNG + 180) / 360;
  const sl = Math.sin(CITY_REF_LAT * Math.PI / 180);
  return {
    translateX: x,
    translateY: 0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI),
    translateZ: 0,
    rotateX:    Math.PI / 2, rotateY: 0, rotateZ: 0,
    scale:      1 / (2 * Math.PI * 6378137 * Math.cos(CITY_REF_LAT * Math.PI / 180)),
  };
}

// lng/lat → local metres, relative to the city anchor (not the Gurugram anchor)
function cityToLocal(lng, lat){
  const mc = window.maplibregl?.MercatorCoordinate
    ? window.maplibregl.MercatorCoordinate.fromLngLat([lng, lat])
    : (() => {
        const x = (lng + 180) / 360;
        const sl = Math.sin(lat * Math.PI / 180);
        return { x, y: 0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI) };
      })();
  const t = cityState.transform;
  return { x: (mc.x - t.translateX) / t.scale, z: (mc.y - t.translateY) / t.scale };
}

function loadGLTFLoaderScript(cb){
  if (window.THREE && THREE.GLTFLoader) { cb(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js';
  s.onload  = cb;
  s.onerror = () => { console.warn('[FloodTwin] GLTFLoader failed to load'); cb(); };
  document.head.appendChild(s);
}

function loadGLB(url){
  return new Promise((resolve, reject) => {
    const loader = new THREE.GLTFLoader();
    loader.load(url, gltf => resolve(gltf), undefined, err => reject(err));
  });
}

// Walk the GLB scene graph and return one prepared instancing template per
// mesh found. Each template is fully ready to drive an InstancedMesh:
//   • parent transforms baked into the geometry
//   • Sketchfab Z-up → Three.js Y-up rotation applied (-π/2 around X)
//   • re-centred on its XZ footprint centroid and dropped so its lowest point
//     sits at y=0 (so position.set(loc.x, 0, loc.z) puts the model on the
//     ground at the polygon centroid)
//   • footprintM = max(width, depth) in the geometry's local units, used to
//     compute a uniform per-instance scale that matches each polygon's size
function collectInstancingTemplates(gltf, className){
  const templates = [];
  gltf.scene.updateMatrixWorld(true);
  // The Sketchfab→glTF export already bakes a Z-up → Y-up rotation into the
  // node hierarchy's world matrix (verified at runtime — the matrix sends
  // local +Z to world +Y). So `geo.applyMatrix4(node.matrixWorld)` alone
  // produces a Three.js-canonical model: footprint in XZ plane, height
  // along +Y. No extra pre-rotation is needed. After the bake:
  //   • Trees: height along +Y, footprint in XZ
  //   • Roads: length along -Z, width along +X, thickness along +Y

  // First pass: bake world matrices and find the *scene-wide* lowest Y so we
  // can drop the whole rig to ground level *as a group*. Per-mesh y-zeroing
  // would lose the relative vertical offset between paired meshes (e.g. tree
  // leaves should sit higher than the trunk base, not at the same elevation).
  const raw = [];
  let sceneMinY = Infinity;
  gltf.scene.traverse(node => {
    if (!node.isMesh || !node.geometry) return;
    node.updateWorldMatrix(true, false);
    const geo = node.geometry.clone();
    geo.applyMatrix4(node.matrixWorld);
    geo.computeBoundingBox();
    if (geo.boundingBox.min.y < sceneMinY) sceneMinY = geo.boundingBox.min.y;
    raw.push({ node, geo });
  });

  // Variant prefix groups meshes that belong together (e.g. "tree4_bark_0"
  // and "tree4_leaves_0" share the prefix "tree4"). Per-variant horizontal
  // centring keeps the bark and leaves stacked at the same XZ centroid.
  // Variant key = first underscore-separated segment of the mesh name.
  // Works for both:
  //   "tree4_bark_0" / "tree4_leaves_0"      → both group as "tree4"
  //   "Grass1_Grass_Mat_0" / "Grass1_Grass2_Mat_0" → both group as "Grass1"
  //   "GrassLawnAutumn_Grass_Mat1_0"         → "GrassLawnAutumn"
  // The previous regex `^[a-zA-Z]+\d+` failed on letters-only prefixes like
  // "GrassLawnAutumn", which broke the sub-mesh pairing.
  const variantOfName = name => (name.split('_')[0] || name);
  const groupCentroid = new Map(); // variant prefix → { cx, cz }
  for (const { node, geo } of raw) {
    const key = variantOfName(node.name || '');
    if (groupCentroid.has(key)) continue;
    // Combine bboxes of all meshes that share this prefix.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of raw) {
      if (variantOfName(r.node.name || '') !== key) continue;
      const b = r.geo.boundingBox;
      if (b.min.x < minX) minX = b.min.x; if (b.max.x > maxX) maxX = b.max.x;
      if (b.min.z < minZ) minZ = b.min.z; if (b.max.z > maxZ) maxZ = b.max.z;
    }
    groupCentroid.set(key, { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 });
  }

  // Per-variant footprint (max width/depth across ALL meshes in the variant).
  // We assign the *same* footprintM to every template in a variant so a per-
  // instance scale applies uniformly to bark and leaves and keeps them paired.
  const variantFootprint = new Map();
  for (const { node, geo } of raw) {
    const key = variantOfName(node.name || '');
    const b = geo.boundingBox;
    const w = b.max.x - b.min.x;
    const d = b.max.z - b.min.z;
    variantFootprint.set(key, Math.max(variantFootprint.get(key) || 0, w, d));
  }

  // For grass, force a single shared light-green unlit material across all
  for (const { node, geo } of raw) {
    const key = variantOfName(node.name || '');
    const { cx, cz } = groupCentroid.get(key);
    geo.applyMatrix4(new THREE.Matrix4().makeTranslation(-cx, -sceneMinY, -cz));
    geo.computeBoundingBox();
    const b2 = geo.boundingBox;
    const widthM = b2.max.x - b2.min.x;
    const depthM = b2.max.z - b2.min.z;
    templates.push({
      geometry:    geo,
      material:    node.material,    // GLB's own textured material
      widthM,
      depthM,
      footprintM:  variantFootprint.get(key),
      variant:     key,
      name:        node.name || '',
    });
  }
  return templates;
}

// Compute a polygon's centroid (lng, lat), bbox extent in metres, and
// principal-axis angle (radians, CCW from +X in local map space). The
// principal axis is the longest direction of the polygon's bbox in the
// local rotated frame — used to orient road tiles along the road.
function polygonGeoStats(coords){
  // coords: [[lng,lat], ...] outer ring
  let sx = 0, sy = 0;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of coords) {
    sx += c[0]; sy += c[1];
    if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
    if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
  }
  const n = coords.length;
  const lng = sx / n, lat = sy / n;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
  // Area in m² via the shoelace formula on the metre-scaled ring.
  let area2 = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i+1];
    area2 += (a[0] * b[1] - b[0] * a[1]);
  }
  const areaM2 = Math.abs(area2) / 2 * mPerDegLng * mPerDegLat;
  return {
    lng, lat,
    minLng, maxLng, minLat, maxLat,
    widthM:  (maxLng - minLng) * mPerDegLng,
    depthM:  (maxLat - minLat) * mPerDegLat,
    areaM2,
    mPerDegLat,
    mPerDegLng,
  };
}

// 2D ray-cast point-in-polygon test in lng/lat space.
function pointInRing(lng, lat, ring){
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Rejection-sample N points inside a polygon. Returns array of {lng, lat}.
// Bails out after MAX_TRIES per point to avoid infinite loops on degenerate
// shapes (very thin slivers); callers should accept fewer points if so.
function samplePointsInPolygon(ring, n, stats){
  const out = [];
  const tries = n * 12;
  let t = 0;
  while (out.length < n && t < tries) {
    t++;
    const lng = stats.minLng + Math.random() * (stats.maxLng - stats.minLng);
    const lat = stats.minLat + Math.random() * (stats.maxLat - stats.minLat);
    if (pointInRing(lng, lat, ring)) out.push({ lng, lat });
  }
  return out;
}

// Principal-axis angle of a polygon's points in *local map space* (metres),
// computed via PCA. Returns radians CCW from +X. Used to orient road tiles
// along the road's long direction.
function polygonPrincipalAngle(ring, stats){
  // Local metres relative to polygon centroid.
  const xs = [], ys = [];
  let mx = 0, my = 0;
  for (const p of ring) {
    const x = (p[0] - stats.lng) * stats.mPerDegLng;
    const y = (p[1] - stats.lat) * stats.mPerDegLat;
    xs.push(x); ys.push(y); mx += x; my += y;
  }
  mx /= xs.length; my /= ys.length;
  // 2x2 covariance
  let cxx = 0, cyy = 0, cxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  // Principal axis = eigenvector of larger eigenvalue.
  // angle = 0.5 * atan2(2*cxy, cxx - cyy)
  return 0.5 * Math.atan2(2 * cxy, cxx - cyy);
}

const cityLayer = {
  id: 'city-3d', type: 'custom', renderingMode: '3d',
  onAdd(m, gl){
    if (cityState.scene) return; // re-add — reuse existing scene
    cityState.scene  = new THREE.Scene();
    cityState.camera = new THREE.Camera();
    cityState.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(50, 100, 30);
    cityState.scene.add(sun);
    cityState.renderer = new THREE.WebGLRenderer({
      canvas: m.getCanvas(), context: gl, antialias: true, preserveDrawingBuffer: true,
    });
    cityState.renderer.autoClear = false;
  },
  render(gl, matrix){
    const t = cityState.transform;
    if (!t || !cityState.scene) return;
    const rx = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1,0,0), t.rotateX);
    const ry = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0,1,0), t.rotateY);
    const rz = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0,0,1), t.rotateZ);
    const M = new THREE.Matrix4().fromArray(matrix);
    const L = new THREE.Matrix4()
      .makeTranslation(t.translateX, t.translateY, t.translateZ)
      .scale(new THREE.Vector3(t.scale, -t.scale, t.scale))
      .multiply(rx).multiply(ry).multiply(rz);
    cityState.camera.projectionMatrix = M.multiply(L);
    cityState.renderer.resetState();
    cityState.renderer.render(cityState.scene, cityState.camera);
  }
};

async function initCityOverlay(){
  if (cityState.buildOnce) return cityState.buildOnce;
  cityState.buildOnce = (async () => {
    setStatus('Loading 3D city…');
    if (!window.THREE) throw new Error('Three.js not ready');
    await new Promise(r => loadGLTFLoaderScript(r));
    if (!THREE.GLTFLoader) throw new Error('GLTFLoader unavailable');

    cityState.transform = buildCityTransform();

    // Add the custom layer so onAdd creates the scene/renderer
    try { map.addLayer(cityLayer); } catch(e) { console.warn('city layer add:', e); }

    // Fetch geojson + GLBs in parallel.
    const [geojson, glbTemplates] = await Promise.all([
      fetch('/prediction.geojson').then(r => r.json()),
      Promise.all(Object.entries(CITY_CLASSES_ENABLED).map(async ([cls, file]) => {
        const gltf = await loadGLB(`/assets/${file}`);
        return [cls, collectInstancingTemplates(gltf, cls)];
      })).then(entries => Object.fromEntries(entries)),
    ]);

    // Group polygon features by enabled class. Each enabled class may map to
    // a different geojson `class_name` (e.g. Soil consumes Grass polygons).
    const byClass = {};
    const geojsonToClass = {};
    for (const cls of Object.keys(CITY_CLASSES_ENABLED)) {
      byClass[cls] = [];
      geojsonToClass[CITY_CLASS_TO_GEOJSON[cls] || cls] = cls;
    }
    for (const feat of geojson.features) {
      const cls = geojsonToClass[feat.properties?.class_name];
      if (!cls) continue;
      const outer = feat.geometry?.coordinates?.[0];
      if (!outer || outer.length < 3) continue;
      byClass[cls].push(outer);
    }

    // Tunables — change these to retune density/size.
    // Total instance count matters less than visible-cell count after
    // culling: at typical user zoom only a fraction of the 32×32 grid is
    // on-screen, so total density can be high without hammering the GPU.
    // Tree area ~420k m², grass area ~750k m².
    const CLASS_CFG = {
      Tree:  { sizeM: 2.5, areaPer: 12, jitter: 0.4 }, // ~35k trees, ~2.5 m
      // grass_green.glb: 14 meshes/variant, 28 tris total. Overlap rejection
      // skips candidates that land inside any non-Grass LULC polygon, so
      // many sampling tries will fail; we sample moderately densely and let
      // rejection prune. ~375k candidates → ~200k placements expected.
      Grass: { sizeM: 1.2, areaPer: 2, jitter: 0.3 },
    };
    // For tile-based classes (Soil): tileSizeM is the grid spacing AND the
    // tile's longest XZ extent in metr   es on the ground. tileScaleAdj > 1
    // makes tiles slightly overlap to avoid seams.
    const TILE_CFG = {
      Soil: { tileSizeM: 8, tileScaleAdj: 1.05, yawJitter: true },
    };

    // Variant groups: meshes sharing the same `t.variant` prefix render
    // together as one logical instance (so trunk+leaves stay paired for
    // trees). Each polygon-sampled point spawns the full variant set.
    // For classes where each sub-mesh is an independent design (Soil:
    // 13 distinct tile variants under one shared prefix `Object`), we give
    // each mesh a unique key so a placement spawns ONE random tile, not all.
    const PER_MESH_CLASSES = new Set(['Soil']);
    function variantGroups(templates, className){
      const perMesh = PER_MESH_CLASSES.has(className);
      const groups = new Map();
      templates.forEach((t, idx) => {
        const key = perMesh ? `${className}-${idx}` : (t.variant || t.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      });
      return [...groups.values()];
    }

    const dummy = new THREE.Object3D();

    // ── Generic union-based dense scattering with cell-bucketed culling ──
    // Strategy for "GPU-independent" perf:
    //   1. At build time, sample N instances uniformly across the union and
    //      pre-bake their matrices into typed arrays grouped by cell. Cells
    //      are a 32×32 grid over the LULC bbox (~50 × 70 m each).
    //   2. Each template still gets ONE InstancedMesh (sized to its total
    //      population) — keeps draw calls minimal.
    //   3. On map move/zoom, compute the visible cell set, repack ONLY the
    //      visible cells' matrices into the front of the InstancedMesh's
    //      buffer, and set `count` accordingly. Off-screen instances cost
    //      zero GPU work.
    //   4. At low zoom we stride the per-cell instances (every Nth) so
    //      density drops gracefully with zoom rather than overwhelming the
    //      GPU at wide views.
    const CELL_GRID = 32;
    function scatterClass(className){
      const cfg       = CLASS_CFG[className];
      const polygons  = byClass[className] || [];
      const templates = glbTemplates[className] || [];
      if (!cfg || !polygons.length || !templates.length) return;
      const variants = variantGroups(templates, className);

      let unionMinLng = Infinity, unionMaxLng = -Infinity;
      let unionMinLat = Infinity, unionMaxLat = -Infinity;
      let unionAreaM2 = 0;
      const polyBoxes = [];
      for (const ring of polygons) {
        const stats = polygonGeoStats(ring);
        polyBoxes.push({ ring, stats });
        if (stats.minLng < unionMinLng) unionMinLng = stats.minLng;
        if (stats.maxLng > unionMaxLng) unionMaxLng = stats.maxLng;
        if (stats.minLat < unionMinLat) unionMinLat = stats.minLat;
        if (stats.maxLat > unionMaxLat) unionMaxLat = stats.maxLat;
        unionAreaM2 += stats.areaM2;
      }

      const targetN = Math.round(unionAreaM2 / cfg.areaPer);
      const lngStep = (unionMaxLng - unionMinLng) / CELL_GRID;
      const latStep = (unionMaxLat - unionMinLat) / CELL_GRID;

      // Spatial index: for each cell in the 32×32 union grid, store the
      // indices of polygons whose bbox overlaps that cell. Reject-sampling
      // then only checks the few polygons in the candidate's cell, not all
      // 2700+ polygons. This is what keeps build time bounded as density
      // grows — without it, high-density grass freezes the page for seconds.
      const cellPolys = new Array(CELL_GRID * CELL_GRID);
      for (let i = 0; i < cellPolys.length; i++) cellPolys[i] = [];
      for (let pi = 0; pi < polyBoxes.length; pi++) {
        const s = polyBoxes[pi].stats;
        const cx0 = Math.max(0, Math.floor((s.minLng - unionMinLng) / lngStep));
        const cx1 = Math.min(CELL_GRID - 1, Math.floor((s.maxLng - unionMinLng) / lngStep));
        const cy0 = Math.max(0, Math.floor((s.minLat - unionMinLat) / latStep));
        const cy1 = Math.min(CELL_GRID - 1, Math.floor((s.maxLat - unionMinLat) / latStep));
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            cellPolys[cy * CELL_GRID + cx].push(pi);
          }
        }
      }

      const inAnyPolygon = (lng, lat, cellIdx) => {
        const candidates = cellPolys[cellIdx];
        if (!candidates || !candidates.length) return false;
        for (const pi of candidates) {
          const pb = polyBoxes[pi];
          const s = pb.stats;
          if (lng < s.minLng || lng > s.maxLng || lat < s.minLat || lat > s.maxLat) continue;
          if (pointInRing(lng, lat, pb.ring)) return true;
        }
        return false;
      };

      // Sample first, store instance specs grouped by (template, cell).
      // Each entry's value is an array of {x, z, s, yaw}. We don't bake
      // matrices yet — that happens during the repack pass.
      const specs = new Map(); // tmpl → Array<Array<{x,z,s,yaw}>> indexed by cellIdx
      const ensureCells = (tmpl) => {
        if (!specs.has(tmpl)) {
          const arr = new Array(CELL_GRID * CELL_GRID);
          for (let i = 0; i < arr.length; i++) arr[i] = [];
          specs.set(tmpl, arr);
        }
        return specs.get(tmpl);
      };

      // ── Cheap overlap rejection (Grass only) ────────────────────────────
      // We exclude grass that falls inside any non-Grass LULC polygon
      // (Tree / Buildings / Road / Cropland / Water / Bareland). This
      // single rule keeps grass off trees, buildings and roads at once —
      // since trees and roads have their own LULC polygons we don't need a
      // per-tree distance check or a per-road-sample distance check (the
      // earlier 4-index version was too heavy). Stadiums are skipped too
      // because they're tiny relative to the LULC extent.
      let isOverlapping = null;
      if (className === 'Grass') {
        const otherCellPolys = new Array(CELL_GRID * CELL_GRID);
        const otherPolyBoxes = [];
        for (let i = 0; i < otherCellPolys.length; i++) otherCellPolys[i] = [];
        for (const f of geojson.features) {
          const cn = f.properties?.class_name;
          if (!cn || cn === 'Grass') continue;
          const outer = f.geometry?.coordinates?.[0];
          if (!outer || outer.length < 3) continue;
          const stats = polygonGeoStats(outer);
          if (stats.maxLng < unionMinLng || stats.minLng > unionMaxLng) continue;
          if (stats.maxLat < unionMinLat || stats.minLat > unionMaxLat) continue;
          const pi = otherPolyBoxes.length;
          otherPolyBoxes.push({ ring: outer, stats });
          const cx0 = Math.max(0, Math.floor((stats.minLng - unionMinLng) / lngStep));
          const cx1 = Math.min(CELL_GRID - 1, Math.floor((stats.maxLng - unionMinLng) / lngStep));
          const cy0 = Math.max(0, Math.floor((stats.minLat - unionMinLat) / latStep));
          const cy1 = Math.min(CELL_GRID - 1, Math.floor((stats.maxLat - unionMinLat) / latStep));
          for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
              otherCellPolys[cy * CELL_GRID + cx].push(pi);
            }
          }
        }
        console.log(`[FloodTwin/Grass] overlap index: ${otherPolyBoxes.length} non-Grass polygons`);
        isOverlapping = (lng, lat, cellIdx) => {
          const cands = otherCellPolys[cellIdx];
          if (!cands) return false;
          for (const pi of cands) {
            const pb = otherPolyBoxes[pi];
            const s = pb.stats;
            if (lng < s.minLng || lng > s.maxLng || lat < s.minLat || lat > s.maxLat) continue;
            if (pointInRing(lng, lat, pb.ring)) return true;
          }
          return false;
        };
      }

      let placed = 0, tries = 0;
      const maxTries = targetN * 8;
      while (placed < targetN && tries < maxTries) {
        tries++;
        const lng = unionMinLng + Math.random() * (unionMaxLng - unionMinLng);
        const lat = unionMinLat + Math.random() * (unionMaxLat - unionMinLat);
        const cx = Math.min(CELL_GRID - 1, Math.floor((lng - unionMinLng) / lngStep));
        const cy = Math.min(CELL_GRID - 1, Math.floor((lat - unionMinLat) / latStep));
        const cellIdx = cy * CELL_GRID + cx;
        if (!inAnyPolygon(lng, lat, cellIdx)) continue;
        // Grass-only: reject if it overlaps any other feature.
        if (isOverlapping && isOverlapping(lng, lat, cellIdx)) continue;
        const loc = cityToLocal(lng, lat);
        const sizeM = cfg.sizeM * (1 + (Math.random() * 2 - 1) * cfg.jitter);
        const yaw = Math.random() * Math.PI * 2;
        const variant = variants[Math.floor(Math.random() * variants.length)];
        for (const tmpl of variant) {
          const s = sizeM / Math.max(0.001, tmpl.footprintM);
          ensureCells(tmpl)[cellIdx].push({ x: loc.x, z: loc.z, s, yaw });
        }
        placed++;
      }

      // Build one InstancedMesh PER CELL per template. Visibility is then a
      // single `mesh.visible = true/false` flip on the culler — no matrix
      // repacking. With a 32×32 grid this caps draw calls at (number of
      // visible cells) × (number of templates per class), typically a few
      // hundred at any zoom.
      for (const [tmpl, cells] of specs) {
        for (let ci = 0; ci < cells.length; ci++) {
          const cellItems = cells[ci];
          if (!cellItems.length) continue;
          const mesh = new THREE.InstancedMesh(tmpl.geometry, tmpl.material, cellItems.length);
          mesh.frustumCulled = false;
          mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
          for (let k = 0; k < cellItems.length; k++) {
            const it = cellItems[k];
            dummy.position.set(it.x, 0, it.z);
            dummy.rotation.set(0, it.yaw, 0);
            dummy.scale.set(it.s, it.s, it.s);
            dummy.updateMatrix();
            mesh.setMatrixAt(k, dummy.matrix);
          }
          mesh.instanceMatrix.needsUpdate = true;
          mesh.visible = false; // culler decides on first pass
          // Cell bbox in lng/lat — used by viewport culler.
          const cx = ci % CELL_GRID, cy = Math.floor(ci / CELL_GRID);
          mesh.userData.cellBbox = [
            unionMinLng + cx * lngStep,
            unionMinLat + cy * latStep,
            unionMinLng + (cx + 1) * lngStep,
            unionMinLat + (cy + 1) * latStep,
          ];
          cityState.scene.add(mesh);
          cityState.meshes.push(mesh);
          cityState.cullables.push(mesh);
        }
      }
      console.log(`[FloodTwin] City: ${polygons.length} ${className} polygons → ${placed} instances ` +
                  `(target ${targetN}, ${tries} samples, union ${unionAreaM2.toFixed(0)} m²)`);
    }

    // ── Tile-the-polygon coverage (used for Soil) ─────────────────────────
    // Walks a regular grid across the union bbox at `tileSizeM` spacing,
    // places one tile per grid cell that lies inside any polygon. Uses the
    // same per-cell InstancedMesh + viewport culling as scatterClass.
    function tileClass(className){
      const polygons  = byClass[className] || [];
      const templates = glbTemplates[className] || [];
      if (!polygons.length || !templates.length) return;
      const variants = variantGroups(templates, className);

      const tileSizeM    = TILE_CFG[className]?.tileSizeM    ?? 10;
      const tileScaleAdj = TILE_CFG[className]?.tileScaleAdj ?? 1.0;
      const yawJitter    = TILE_CFG[className]?.yawJitter    ?? true;

      // Same union bbox + spatial index machinery as scatterClass.
      let unionMinLng = Infinity, unionMaxLng = -Infinity;
      let unionMinLat = Infinity, unionMaxLat = -Infinity;
      const polyBoxes = [];
      for (const ring of polygons) {
        const stats = polygonGeoStats(ring);
        polyBoxes.push({ ring, stats });
        if (stats.minLng < unionMinLng) unionMinLng = stats.minLng;
        if (stats.maxLng > unionMaxLng) unionMaxLng = stats.maxLng;
        if (stats.minLat < unionMinLat) unionMinLat = stats.minLat;
        if (stats.maxLat > unionMaxLat) unionMaxLat = stats.maxLat;
      }
      const lngStep = (unionMaxLng - unionMinLng) / CELL_GRID;
      const latStep = (unionMaxLat - unionMinLat) / CELL_GRID;

      const cellPolys = new Array(CELL_GRID * CELL_GRID);
      for (let i = 0; i < cellPolys.length; i++) cellPolys[i] = [];
      for (let pi = 0; pi < polyBoxes.length; pi++) {
        const s = polyBoxes[pi].stats;
        const cx0 = Math.max(0, Math.floor((s.minLng - unionMinLng) / lngStep));
        const cx1 = Math.min(CELL_GRID - 1, Math.floor((s.maxLng - unionMinLng) / lngStep));
        const cy0 = Math.max(0, Math.floor((s.minLat - unionMinLat) / latStep));
        const cy1 = Math.min(CELL_GRID - 1, Math.floor((s.maxLat - unionMinLat) / latStep));
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            cellPolys[cy * CELL_GRID + cx].push(pi);
          }
        }
      }
      const inAnyPolygon = (lng, lat, cellIdx) => {
        const cs = cellPolys[cellIdx];
        if (!cs || !cs.length) return false;
        for (const pi of cs) {
          const pb = polyBoxes[pi];
          const s = pb.stats;
          if (lng < s.minLng || lng > s.maxLng || lat < s.minLat || lat > s.maxLat) continue;
          if (pointInRing(lng, lat, pb.ring)) return true;
        }
        return false;
      };

      // Convert tileSizeM (metres) to lng/lat degree step at the union's mid
      // latitude.
      const midLat = (unionMinLat + unionMaxLat) / 2;
      const mPerDegLat = 111320;
      const mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180);
      const tileLngStep = tileSizeM / mPerDegLng;
      const tileLatStep = tileSizeM / mPerDegLat;

      const specs = new Map();
      const ensureCells = (tmpl) => {
        if (!specs.has(tmpl)) {
          const arr = new Array(CELL_GRID * CELL_GRID);
          for (let i = 0; i < arr.length; i++) arr[i] = [];
          specs.set(tmpl, arr);
        }
        return specs.get(tmpl);
      };

      let placed = 0;
      const lngCount = Math.ceil((unionMaxLng - unionMinLng) / tileLngStep);
      const latCount = Math.ceil((unionMaxLat - unionMinLat) / tileLatStep);
      for (let j = 0; j < latCount; j++) {
        for (let i = 0; i < lngCount; i++) {
          // Centre of this tile in lng/lat.
          const lng = unionMinLng + (i + 0.5) * tileLngStep;
          const lat = unionMinLat + (j + 0.5) * tileLatStep;
          const cx = Math.min(CELL_GRID - 1, Math.floor((lng - unionMinLng) / lngStep));
          const cy = Math.min(CELL_GRID - 1, Math.floor((lat - unionMinLat) / latStep));
          const cellIdx = cy * CELL_GRID + cx;
          if (!inAnyPolygon(lng, lat, cellIdx)) continue;

          const loc = cityToLocal(lng, lat);
          const variant = variants[Math.floor(Math.random() * variants.length)];
          const yaw = yawJitter ? (Math.floor(Math.random() * 4) * Math.PI / 2) : 0;
          for (const tmpl of variant) {
            // Scale so tile's longest XZ axis ≈ tileSizeM × tileScaleAdj.
            const s = (tileSizeM * tileScaleAdj) / Math.max(0.001, tmpl.footprintM);
            ensureCells(tmpl)[cellIdx].push({ x: loc.x, z: loc.z, s, yaw });
          }
          placed++;
        }
      }

      // Build per-cell InstancedMeshes — same pattern as scatterClass.
      for (const [tmpl, cells] of specs) {
        for (let ci = 0; ci < cells.length; ci++) {
          const cellItems = cells[ci];
          if (!cellItems.length) continue;
          const mesh = new THREE.InstancedMesh(tmpl.geometry, tmpl.material, cellItems.length);
          mesh.frustumCulled = false;
          mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
          for (let k = 0; k < cellItems.length; k++) {
            const it = cellItems[k];
            dummy.position.set(it.x, 0, it.z);
            dummy.rotation.set(0, it.yaw, 0);
            dummy.scale.set(it.s, it.s, it.s);
            dummy.updateMatrix();
            mesh.setMatrixAt(k, dummy.matrix);
          }
          mesh.instanceMatrix.needsUpdate = true;
          mesh.visible = false;
          const cx = ci % CELL_GRID, cy = Math.floor(ci / CELL_GRID);
          mesh.userData.cellBbox = [
            unionMinLng + cx * lngStep,
            unionMinLat + cy * latStep,
            unionMinLng + (cx + 1) * lngStep,
            unionMinLat + (cy + 1) * latStep,
          ];
          cityState.scene.add(mesh);
          cityState.meshes.push(mesh);
          cityState.cullables.push(mesh);
        }
      }
      console.log(`[FloodTwin] City: ${polygons.length} ${className} polygons → ${placed} tiles (${tileSizeM} m grid)`);
    }

    // ── Grass ground: removed (SVG-based approach didn't work; awaiting a
    // lighter grass.glb to wire scatterClass('Grass') back in).

    // Yield to the event loop between build phases so the browser can paint
    // a status update and the page never feels frozen.
    const yieldFrame = () => new Promise(r => setTimeout(r, 0));

    setStatus('Building trees…');
    scatterClass('Tree');
    await yieldFrame();

    setStatus('Building roads…');
    await scatterRoadsFromMapplsLayers();
    placeCricketMarker();
    setStatus('');

    // Campus life (vehicles + people) runs after roads have started
    // populating. Road paths are collected lazily on map idle, so we wait
    // a tick before spawning — and re-run if more roads arrive later.
    setTimeout(() => populateCampusLife(), 2000);
    map.on('idle', () => populateCampusLife());

    // Initial cull pass so we don't render everything for one frame.
    cullCityToViewport();
    // Re-cull on any map movement. moveend fires once after a pan/zoom finishes.
    map.on('moveend', cullCityToViewport);
    map.on('zoomend', cullCityToViewport);

    cityState.inited  = true;
    cityState.enabled = true;
    setStatus('');
  })();
  return cityState.buildOnce;
}

// ── Campus life: vehicles and people ──────────────────────────────────
// Adds simple "campus is alive" details that the per-frame render loop
// drives forward in time:
//   • vehicles: a fixed set of small coloured boxes that march along the
//     sampled road centerlines (cityState.roadPaths). Each vehicle
//     repeatedly traverses one path and respawns at the start.
//   • people: billboard sprites near POI markers. A canvas-drawn human
//     silhouette is used as the texture (no asset dependency). Sprites
//     don't move but always face the camera.
function populateCampusLife(){
  if (cityState.lifeBuilt) return;
  if (!cityState.scene) return;
  if (!cityState.roadPaths || cityState.roadPaths.length === 0) return;
  cityState.lifeBuilt = true;

  // ── Vehicles ─────────────────────────────────────────────────────────
  // Pick the longest N paths so vehicles run on real streets, not tiny
  // service stubs. Then assign vehicles to those paths in round-robin.
  const ranked = cityState.roadPaths
    .map((path, i) => {
      let len = 0;
      for (let j = 1; j < path.length; j++) {
        len += Math.hypot(path[j][0] - path[j-1][0], path[j][1] - path[j-1][1]);
      }
      return { path, len, i };
    })
    .filter(r => r.len > 30)            // skip junk-short paths
    .sort((a, b) => b.len - a.len);

  const VEHICLE_CFG = [
    { count: 12, w: 1.6, h: 1.3, d: 3.8, speed: 8,  colours: [0xeeeeee, 0xb0b0b0, 0x8b1f1f, 0x1f3a8b, 0x2d8b1f, 0xeeb000, 0x404040] }, // cars
    { count: 3,  w: 2.4, h: 2.6, d: 8.5, speed: 6,  colours: [0xf0e040, 0xffffff] },                                                  // buses (yellow/white)
    { count: 4,  w: 1.3, h: 1.4, d: 2.6, speed: 7,  colours: [0xffd400, 0x1a1a1a] },                                                  // autos
  ];

  cityState.vehicles = [];
  const dummy = new THREE.Object3D();
  let pathCursor = 0;
  for (const cfg of VEHICLE_CFG) {
    for (let i = 0; i < cfg.count; i++) {
      if (!ranked.length) break;
      const r = ranked[pathCursor % ranked.length];
      pathCursor++;
      const colour = cfg.colours[i % cfg.colours.length];
      const geo = new THREE.BoxGeometry(cfg.w, cfg.h, cfg.d);
      // Move the box up so its base sits at y=0.
      geo.translate(0, cfg.h / 2, 0);
      const mat = new THREE.MeshBasicMaterial({ color: colour });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      cityState.scene.add(mesh);
      cityState.meshes.push(mesh);
      cityState.vehicles.push({
        mesh,
        path: r.path,
        pathLen: r.len,
        t: Math.random() * r.len,        // initial distance along the path
        speed: cfg.speed * (0.8 + Math.random() * 0.4),
        kind: cfg === VEHICLE_CFG[1] ? 'bus' : (cfg === VEHICLE_CFG[2] ? 'auto' : 'car'),
      });
    }
  }
  console.log(`[FloodTwin/life] ${cityState.vehicles.length} vehicles spawned across ${ranked.length} road paths`);

  // ── People: billboard sprites near POI markers ───────────────────────
  // Procedurally render a tiny human silhouette to a canvas, use that as
  // a sprite texture. POI locations come from the critical-asset list
  // (hospitals, schools, etc.) which gives us anchors at recognisable
  // campus places.
  const peopleCanvas = document.createElement('canvas');
  peopleCanvas.width = 64; peopleCanvas.height = 128;
  const pctx = peopleCanvas.getContext('2d');
  // Head
  pctx.fillStyle = '#e0a880'; // skin tone (single)
  pctx.beginPath(); pctx.arc(32, 22, 11, 0, Math.PI * 2); pctx.fill();
  // Torso
  pctx.fillStyle = '#4a90e2'; // shirt
  pctx.fillRect(20, 32, 24, 38);
  // Legs
  pctx.fillStyle = '#1f2937'; // pants
  pctx.fillRect(22, 70, 8, 50);
  pctx.fillRect(34, 70, 8, 50);
  // Arms
  pctx.fillStyle = '#4a90e2';
  pctx.fillRect(12, 34, 8, 34);
  pctx.fillRect(44, 34, 8, 34);

  const personTexture = new THREE.CanvasTexture(peopleCanvas);
  if (personTexture.colorSpace !== undefined) personTexture.colorSpace = THREE.SRGBColorSpace;
  const personMat = new THREE.SpriteMaterial({
    map: personTexture,
    transparent: true,
    alphaTest: 0.1,
  });

  // POI locations: query Mappls features near the city anchor for any
  // building/POI symbol points. Cheaper proxy: use stadium locations + a
  // handful of fixed-offset extras around the campus centre.
  cityState.people = [];
  const PERSON_HEIGHT_M = 1.7;
  const peopleAnchors = [];

  // Use detected stadium hits as anchors (we know they exist).
  if (cityState.stadiums) {
    for (const s of cityState.stadiums) {
      peopleAnchors.push({ lat: s.lat, lng: s.lng, count: 4 });
    }
  }
  // Plus a scattered set across the campus extent so the rest of the map
  // doesn't feel empty.
  const SPREAD = 0.003; // ~330 m around the city anchor
  for (let i = 0; i < 30; i++) {
    peopleAnchors.push({
      lat: CITY_REF_LAT + (Math.random() * 2 - 1) * SPREAD,
      lng: CITY_REF_LNG + (Math.random() * 2 - 1) * SPREAD,
      count: 1 + Math.floor(Math.random() * 3),
    });
  }

  for (const anchor of peopleAnchors) {
    for (let i = 0; i < anchor.count; i++) {
      const jitter = 4; // metres around the anchor
      const dLng = (Math.random() * 2 - 1) * jitter / (111320 * Math.cos(anchor.lat * Math.PI / 180));
      const dLat = (Math.random() * 2 - 1) * jitter / 111320;
      const loc = cityToLocal(anchor.lng + dLng, anchor.lat + dLat);
      const sprite = new THREE.Sprite(personMat);
      sprite.scale.set(PERSON_HEIGHT_M * 0.5, PERSON_HEIGHT_M, 1);
      sprite.position.set(loc.x, PERSON_HEIGHT_M / 2, loc.z);
      cityState.scene.add(sprite);
      cityState.meshes.push(sprite);
      cityState.people.push(sprite);
    }
  }
  console.log(`[FloodTwin/life] ${cityState.people.length} people sprites placed across ${peopleAnchors.length} anchors`);
}

// Per-frame animation tick for vehicles. Called from the existing render
// loop. Each vehicle marches forward along its assigned path; on reaching
// the end it loops back to t=0. Pose (position + yaw) is recomputed from
// the path tangent at the current point.
function tickCampusLife(dt){
  if (!cityState.vehicles || !cityState.vehicles.length) return;
  for (const v of cityState.vehicles) {
    v.t += v.speed * dt;
    if (v.t >= v.pathLen) v.t -= v.pathLen;
    // Find the segment that contains distance v.t.
    let acc = 0;
    for (let i = 1; i < v.path.length; i++) {
      const segLen = Math.hypot(v.path[i][0] - v.path[i-1][0], v.path[i][1] - v.path[i-1][1]);
      if (acc + segLen >= v.t) {
        const f = (v.t - acc) / segLen;
        const x = v.path[i-1][0] + (v.path[i][0] - v.path[i-1][0]) * f;
        const z = v.path[i-1][1] + (v.path[i][1] - v.path[i-1][1]) * f;
        const dx = v.path[i][0] - v.path[i-1][0];
        const dz = v.path[i][1] - v.path[i-1][1];
        v.mesh.position.set(x, 0, z);
        v.mesh.rotation.y = Math.atan2(dx, dz);
        break;
      }
      acc += segLen;
    }
  }
}

function setCityVisibility(on){
  cityState.enabled = on;
  if (on) {
    // Re-cull (the culler sets `visible` per-cell). Don't blanket-enable —
    // off-screen cells should stay hidden.
    cullCityToViewport();
    // Roads mesh isn't cell-culled — flip it back on directly.
    if (cityState.roadMesh) cityState.roadMesh.visible = true;
    if (cityState.cricketMarkers) cityState.cricketMarkers.forEach(m => { m.el.style.display = ''; });
    if (cityState.stadiums) cityState.stadiums.forEach(s => { s.group.visible = true; });
  } else {
    cityState.meshes.forEach(m => { m.visible = false; });
    if (cityState.cricketMarkers) cityState.cricketMarkers.forEach(m => { m.el.style.display = 'none'; });
    if (cityState.stadiums) cityState.stadiums.forEach(s => { s.group.visible = false; });
  }
  if (glMap) glMap.triggerRepaint();
}

// Build flat textured road strips along every visible Mappls vector road
// feature near the city anchor. Uses the SVG at /static/road-tile.svg as a
// repeating texture (one repeat ≈ ROAD_REPEAT_M of road length).
//
// Approach: query Mappls's rendered road LineString features (same as the
// flood-road overlay), sample each centerline at fine intervals, then for
// each consecutive pair of points emit a quad parallel to the segment with
// UV `u` advancing with cumulative distance (so the SVG tiles). All quads
// for one idle pass go into a single BufferGeometry → one draw call.
// Find a cricket-field label in Mappls's rendered features near the city
// anchor and drop an HTML marker on it. The label text comes from the
// basemap's symbol/label layers; we query them on every `idle` (since
// tiles can load lazily) and stop once we've successfully placed the
// marker. Links to the Sketchfab stadium model on click.
function placeCricketMarker(){
  if (cityState.cricketScheduled) {
    console.log('[FloodTwin/cricket] placeCricketMarker SKIPPED — already scheduled this session (toggle off+on does not re-run it).');
    return;
  }
  cityState.cricketScheduled = true;
  console.log('[FloodTwin/cricket] placeCricketMarker entered — registering tryPlace on idle.');

  // Per-stadium-kind config. The basemap-detection regex picks features by
  // their `h` (label) property; the GLB + mesh-keep filter define what gets
  // rendered. Both models are loaded in FULL (no mesh culling) — earlier
  // heuristic culling dropped too many visually-important parts.
  // Mesh-keep rules (applied per-kind at GLB load):
  //   • flatExtentDrop  + flatHeightCutoff: drop FLAT meshes whose XZ extent
  //     exceeds the value (catches outer ground plates in source units).
  //   • dropNamePattern: drop meshes whose name matches the regex
  //     (decorative trees / lights / bats / etc.).
  //   • dropMinCornerDist: drop meshes whose min-corner distance to the
  //     model origin exceeds this value (catches outer rectangular patches
  //     in unnamed GLBs like football where regex doesn't work).
  const STADIUM_KINDS = [
    {
      key:       'cricket',
      labelRe:   /cricket/i,
      glbUrl:    '/assets/cricket_stadium.glb',
      sourceUrl: 'https://sketchfab.com/3d-models/sharjah-cricket-stadium-3d-model-bfdf96e0ba0a4e5c84d8608190a1c338',
      targetWidthM: 35,
      flatHeightCutoff: 0.3,
      flatExtentDrop:   35,
      // Drops decorative props that sit OUTSIDE the dome footprint by name.
      // Match both 'Material.007' AND 'Material007' (GLTFLoader sometimes
      // strips the period). The 12 floodlight bulb panels surviving the
      // previous cull were named 'CircleNNN_Material007_0'.
      dropNamePattern:  /tree|leaves|branch|casual|icosphere|trunk|black|material\.?00[789]|material\.?01[01]|_red_|bat/i,
      // NO dropMinCornerDist for cricket — the dome itself extends to ~15 m
      // from origin and would get culled. Cricket relies on name-pattern
      // and flat+wide rules only.
    },
    {
      key:       'football',
      labelRe:   /football|soccer/i,
      glbUrl:    '/assets/football.glb',
      sourceUrl: '',
      targetWidthM: 70,
      // football.glb is a clean 8-mesh asset already in real-world metres,
      // centred at origin, natural size ~41 × 23 m (track + pitch + goals
      // + lights). The two "Fled Lights" meshes (typo for Field Lights)
      // are the only props we drop by name.
      dropNamePattern: /fled\s*lights?/i,
      // The model's long (+X) axis is aligned to the matched footprint's PCA
      // principal axis. The track ended up a touch off the footprint, so nudge
      // the yaw to bring the oval onto its outline. Sign/magnitude is a manual
      // tune — read the "[FloodTwin/football] … angle=…° … yaw=…°" console log
      // after a placement and adjust this until the oval sits flush.
      extraYaw:  -2 * Math.PI / 180,
      // No flat/extent/corner rules needed — all surviving meshes are
      // legitimate parts of the football ground.
    },
  ];
  const mapEl = document.getElementById('map');
  let markerEl = null;

  // Lookup of typical text/name fields in basemap features. Mappls uses a
  // minified property name `h` for the label text in its style.
  const featureName = f => {
    const p = f.properties || {};
    return (p.name || p.name_en || p['name:en'] || p.text || p.label || p.title || p.h || '').toString();
  };

  // Return { lng, lat, widthM, depthM, angle } where angle (radians) is the
  // principal-axis direction of the feature's polygon in (lng, lat) space,
  // and widthM/depthM are the metres-extent along the principal axis and its
  // perpendicular. For Point features widthM/depthM/angle are null — caller
  // falls back to the kind's defaults.
  const featureLngLat = f => {
    const g = f.geometry;
    if (!g) return null;
    if (g.type === 'Point') {
      return { lng: g.coordinates[0], lat: g.coordinates[1], widthM: null, depthM: null, angle: null };
    }
    if (g.type === 'MultiPoint' && g.coordinates.length) {
      return { lng: g.coordinates[0][0], lat: g.coordinates[0][1], widthM: null, depthM: null, angle: null };
    }
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map(p => p[0]);
      // Flatten to a single ring of points for PCA + centroid.
      const pts = [];
      for (const ring of rings) for (const c of ring) pts.push(c);
      if (!pts.length) return null;
      let sLng = 0, sLat = 0;
      for (const c of pts) { sLng += c[0]; sLat += c[1]; }
      const lng = sLng / pts.length;
      const lat = sLat / pts.length;
      const mPerDegLat = 111320;
      const mPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
      // PCA in local metres frame relative to centroid.
      let cxx = 0, cyy = 0, cxy = 0;
      const xs = [], ys = [];
      for (const c of pts) {
        const x = (c[0] - lng) * mPerDegLng;
        const y = (c[1] - lat) * mPerDegLat;
        xs.push(x); ys.push(y);
        cxx += x * x; cyy += y * y; cxy += x * y;
      }
      // Principal angle CCW from +east.
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      // Project all points onto the principal axis and its perpendicular
      // to get true extents (better than bbox-diagonal for diagonal shapes).
      const dx = Math.cos(angle), dy = Math.sin(angle);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let i = 0; i < xs.length; i++) {
        const u = xs[i] * dx + ys[i] * dy;
        const v = -xs[i] * dy + ys[i] * dx;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      return {
        lng, lat,
        widthM: Math.max(0.001, maxU - minU),  // along principal axis
        depthM: Math.max(0.001, maxV - minV),  // perpendicular
        angle,
      };
    }
    if (g.type === 'LineString' && g.coordinates.length) {
      const mid = g.coordinates[Math.floor(g.coordinates.length / 2)];
      return { lng: mid[0], lat: mid[1], widthM: null, depthM: null, angle: null };
    }
    return null;
  };

  // Debug pass: keep firing on every idle until we either find cricket
  // features OR the user manually fills in coordinates. We DON'T bail
  // early on markerEl so we can detect BOTH grounds, not just the first.
  let loggedLayers = false;
  let lastGuardState = '';
  const seenFeatureKeys = new Set();
  const hits = []; // { name, pos } for each unique cricket feature found

  const tryPlace = () => {
    if (!map) return;
    const z = map.getZoom();
    const c = map.getCenter();
    const zoomOk   = z >= 14;
    const centerOk = Math.abs(c.lng - CITY_REF_LNG) <= 0.05 && Math.abs(c.lat - CITY_REF_LAT) <= 0.05;

    // Guard diagnostic that re-logs whenever the pass/fail verdict CHANGES, so
    // after the flyTo lands at IITGN we see the new state (the old one-time log
    // fired at Gurugram before the flyTo and then went silent). Tells us which
    // gate is blocking: zoom (<14) or center (>0.05° from IITGN).
    const guardState = `${zoomOk}|${centerOk}`;
    if (guardState !== lastGuardState) {
      lastGuardState = guardState;
      console.log(`[FloodTwin/cricket] tryPlace guard: zoom=${z.toFixed(2)} (ok=${zoomOk}, need ≥14), ` +
        `center=(${c.lng.toFixed(4)},${c.lat.toFixed(4)}) dLng=${Math.abs(c.lng - CITY_REF_LNG).toFixed(4)} ` +
        `dLat=${Math.abs(c.lat - CITY_REF_LAT).toFixed(4)} (ok=${centerOk}, need ≤0.05 from IITGN ${CITY_REF_LNG},${CITY_REF_LAT})`);
    }
    if (!zoomOk || !centerOk) return;

    let layers;
    try { layers = map.getStyle().layers; } catch (e) {
      console.warn('[FloodTwin/cricket] getStyle() threw:', e);
      return;
    }
    // Cast a very wide net: every layer type that could carry text/name
    // data. We'll log them so we can shrink the net later.
    const layerIds = layers
      .filter(l => l.type === 'symbol' || l.type === 'fill' || l.type === 'fill-extrusion')
      .map(l => l.id);

    if (!loggedLayers) {
      loggedLayers = true;
      console.log(`[FloodTwin/cricket] querying ${layerIds.length} layers (zoom=${map.getZoom().toFixed(1)})`);
      console.log('[FloodTwin/cricket] layer ids:', layerIds);
    }

    if (!layerIds.length) return;

    let features;
    try {
      features = map.queryRenderedFeatures(undefined, { layers: layerIds });
    } catch (e) {
      console.warn('[FloodTwin/cricket] queryRenderedFeatures threw:', e);
      return;
    }
    if (!features?.length) {
      console.log('[FloodTwin/cricket] 0 rendered features in viewport.');
      return;
    }

    // For each feature, check which stadium kind (if any) matches its label.
    // Tag each hit with its kind so the placement code knows which GLB to use.
    const matchedFeatures = [];
    for (const f of features) {
      const p = f.properties || {};
      let kind = null;
      outer: for (const v of Object.values(p)) {
        if (typeof v !== 'string') continue;
        for (const k of STADIUM_KINDS) {
          if (k.labelRe.test(v)) { kind = k; break outer; }
        }
      }
      if (kind) matchedFeatures.push({ feat: f, kind });
    }

    if (!matchedFeatures.length) {
      if (!dumpedSample) {
        dumpedSample = true;
        console.log(`[FloodTwin/cricket] no stadium matches among ${features.length} features.`);
        console.log('[FloodTwin/cricket] sample feature[0] properties:', features[0].properties);
      }
      return;
    }

    // For each detected stadium label, try to find the basemap's *fill*
    // polygon at that lat/lng — that's the green field outline you see on
    // the map. If found, attach its real width/depth (metres) to the hit
    // so placement code can scale the GLB to match exactly.
    const queryFootprintAt = (lng, lat) => {
      try {
        const pt = map.project({ lng, lat });
        const features = map.queryRenderedFeatures(pt);
        if (!features?.length) return null;
        let best = null;
        for (const ff of features) {
          const g = ff.geometry;
          if (!g) continue;
          if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
          const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map(p => p[0]);

          // bbox in lng/lat
          let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
          const allPts = [];
          for (const ring of rings) for (const c of ring) {
            if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
            if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
            allPts.push(c);
          }
          const mPerDegLat = 111320;
          const mPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);

          // PCA in metres to find principal-axis angle. Centroid then 2×2
          // covariance; angle is 0.5·atan2(2·Cxy, Cxx-Cyy).
          let cxLng = 0, cyLat = 0;
          for (const c of allPts) { cxLng += c[0]; cyLat += c[1]; }
          cxLng /= allPts.length; cyLat /= allPts.length;
          let cxx = 0, cyy = 0, cxy = 0;
          for (const c of allPts) {
            const x = (c[0] - cxLng) * mPerDegLng;
            const y = (c[1] - cyLat) * mPerDegLat;
            cxx += x*x; cyy += y*y; cxy += x*y;
          }
          const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);

          // True extents along the principal axis + its perpendicular.
          const ca = Math.cos(angle), sa = Math.sin(angle);
          let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
          for (const c of allPts) {
            const x = (c[0] - cxLng) * mPerDegLng;
            const y = (c[1] - cyLat) * mPerDegLat;
            const u = x * ca + y * sa;
            const v = -x * sa + y * ca;
            if (u < minU) minU = u; if (u > maxU) maxU = u;
            if (v < minV) minV = v; if (v > maxV) maxV = v;
          }
          const widthM = Math.max(0.001, maxU - minU);   // along principal axis
          const depthM = Math.max(0.001, maxV - minV);   // perpendicular
          const areaM2 = widthM * depthM;

          if (areaM2 > 50000) continue;
          if (areaM2 < 200) continue;
          if (!best || areaM2 < best.areaM2) {
            best = {
              widthM, depthM, areaM2, angle,
              centroidLng: cxLng,        // polygon centroid (not the click point)
              centroidLat: cyLat,
              layerId: ff.layer?.id,
            };
          }
        }
        return best;
      } catch (e) { return null; }
    };

    // Dedupe and only log NEW finds.
    const newHitsThisRun = [];
    for (const { feat: f, kind } of matchedFeatures) {
      const pos = featureLngLat(f);
      const name = featureName(f) || '(unnamed)';
      const key = `${f.layer?.id}|${name}|${pos?.lng?.toFixed(5)},${pos?.lat?.toFixed(5)}`;
      if (!pos || seenFeatureKeys.has(key)) continue;
      seenFeatureKeys.add(key);

      // Look up the basemap fill polygon at this point — gives us the real
      // field width/depth + orientation so we can scale and rotate the GLB
      // exactly to footprint.
      // A kind can opt out of polygon-match (skipFootprintMatch) when the
      // closest Mappls fill polygon isn't the visible outline — it then falls
      // back to a fixed targetWidthM and no rotation.
      if (!kind.skipFootprintMatch) {
        const footprint = queryFootprintAt(pos.lng, pos.lat);
        if (footprint) {
          pos.widthM  = footprint.widthM;
          pos.depthM  = footprint.depthM;
          pos.angle   = footprint.angle;
          pos.lng = footprint.centroidLng;
          pos.lat = footprint.centroidLat;
          console.log(`[FloodTwin/${kind.key}] footprint for "${name}" from layer ${footprint.layerId}: ${footprint.widthM.toFixed(1)} × ${footprint.depthM.toFixed(1)} m, angle=${(footprint.angle*180/Math.PI).toFixed(1)}°, centroid=(${footprint.centroidLng.toFixed(5)}, ${footprint.centroidLat.toFixed(5)}) (area ${footprint.areaM2.toFixed(0)} m²)`);
        }
      } else {
        console.log(`[FloodTwin/${kind.key}] skipFootprintMatch=true; using targetWidthM=${kind.targetWidthM}, no polygon rotation`);
      }

      hits.push({ name, pos, kind });
      newHitsThisRun.push({ name, pos, kind, layer: f.layer?.id });
    }

    if (newHitsThisRun.length) {
      console.log(`[FloodTwin/cricket] ✅ found ${newHitsThisRun.length} NEW stadium feature(s):`);
      for (const h of newHitsThisRun) {
        console.log(`   [${h.layer}] (${h.kind.key}) "${h.name}" @ ${h.pos.lng.toFixed(5)}, ${h.pos.lat.toFixed(5)}`);
      }
      placeMarkersFor(hits);
    }

    // Stop polling after a reasonable number of stadiums (2 cricket + 1
    // football expected at IITGN). Each duplicate-suppressed re-query still
    // costs CPU on every idle event.
    if (hits.length >= 4) {
      try { map.off('idle', tryPlace); } catch(e){}
      console.log('[FloodTwin/cricket] all expected grounds placed — idle listener detached.');
    }
  };
  let dumpedSample = false;

  // Place one HTML marker + one 3D stadium per hit. Idempotent: each
  // (name, lng, lat) gets at most one of each, even if tryPlace fires again.
  const placedKeys = new Set();
  cityState.cricketMarkers = cityState.cricketMarkers || [];
  cityState.stadiums = cityState.stadiums || [];

  // Per-kind GLB cache. Each kind's GLB is fetched at most once. The
  // returned object has the loaded scene PLUS a Box3 limited to the meshes
  // that pass the kind's `meshKeep` predicate — important: the bbox should
  // reflect the visible (post-cull) extent so scale/centering use the right
  // numbers.
  const stadiumScenePromise = new Map(); // kind.key → Promise<sceneInfo|null>

  const loadStadiumScene = (kind) => {
    if (stadiumScenePromise.has(kind.key)) return stadiumScenePromise.get(kind.key);
    setStatus(`Loading ${kind.key} stadium…`);
    const p = loadGLB(kind.glbUrl)
      .then(gltf => {
        gltf.scene.updateMatrixWorld(true);

        // Pass 1: compute each mesh's world-bbox + min-corner distance.
        const meshInfo = []; // { node, b, heightM, xzExt, minCornerDist, name }
        gltf.scene.traverse(n => {
          if (!n.isMesh || !n.geometry) return;
          n.geometry.computeBoundingBox();
          const b = n.geometry.boundingBox.clone().applyMatrix4(n.matrixWorld);
          const heightM = b.max.y - b.min.y;
          const xzExt = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
          // Min distance from any of the 4 XZ-corners to the model origin.
          // Catches meshes whose nearest edge sits beyond a distance — used
          // to cut the outer "rectangular patch" on unnamed GLBs.
          const c0 = b.min.x * b.min.x + b.min.z * b.min.z;
          const c1 = b.max.x * b.max.x + b.min.z * b.min.z;
          const c2 = b.min.x * b.min.x + b.max.z * b.max.z;
          const c3 = b.max.x * b.max.x + b.max.z * b.max.z;
          const minCornerDist = Math.sqrt(Math.min(c0, c1, c2, c3));
          meshInfo.push({ node: n, b, heightM, xzExt, minCornerDist, name: n.name || '' });
        });

        // Pass 2: drop meshes by the kind's keep rules. Any matching rule drops.
        const cutoff = kind.flatHeightCutoff || 0;
        const extDrop = kind.flatExtentDrop || Infinity;
        const namePat = kind.dropNamePattern || null;
        const minCornerLimit = kind.dropMinCornerDist || Infinity;
        const maxExt = kind.dropMaxExt || Infinity;
        let kept = 0, dropped = 0;
        const dropReason = { name: 0, flatLarge: 0, farOuter: 0, oversized: 0 };
        for (const m of meshInfo) {
          let drop = false;
          if (namePat && namePat.test(m.name)) { drop = true; dropReason.name++; }
          else if (m.heightM < cutoff && m.xzExt > extDrop) { drop = true; dropReason.flatLarge++; }
          else if (m.minCornerDist > minCornerLimit) { drop = true; dropReason.farOuter++; }
          else if (m.xzExt > maxExt) { drop = true; dropReason.oversized++; }
          m.node.visible = !drop;
          if (drop) dropped++; else kept++;
        }

        // Bbox of the KEPT meshes only — this is what scale/center use.
        const box = new THREE.Box3();
        for (const { node, b } of meshInfo) {
          if (node.visible) box.union(b);
        }
        const size = new THREE.Vector3();
        box.getSize(size);
        console.log(`[FloodTwin/${kind.key}] GLB loaded: ${size.x.toFixed(1)} × ${size.z.toFixed(1)} m (×Y=${size.y.toFixed(1)}), kept ${kept}/${kept+dropped} meshes (dropped: ${dropReason.name} by name, ${dropReason.flatLarge} flat+wide, ${dropReason.farOuter} far-outer, ${dropReason.oversized} oversized)`);
        // Diagnostic: list every surviving mesh so we can see exactly what
        // visible residues (lights, red plates, etc.) are actually being kept.
        console.log(`[FloodTwin/${kind.key}] surviving meshes:`);
        for (const m of meshInfo) {
          if (!m.node.visible) continue;
          const cx = ((m.b.min.x + m.b.max.x) / 2).toFixed(1);
          const cz = ((m.b.min.z + m.b.max.z) / 2).toFixed(1);
          const dist = Math.sqrt(((m.b.min.x+m.b.max.x)/2)**2 + ((m.b.min.z+m.b.max.z)/2)**2).toFixed(1);
          console.log(`   name=${m.name!=''?JSON.stringify(m.name):'<unnamed>'} H=${m.heightM.toFixed(2)} ext=${m.xzExt.toFixed(1)} mind=${m.minCornerDist.toFixed(1)} centerDist=${dist} center=(${cx},${cz})`);
        }
        setStatus('');
        return { scene: gltf.scene, box, size };
      })
      .catch(err => {
        console.warn(`[FloodTwin/${kind.key}] GLB failed to load:`, err);
        setStatus('');
        return null;
      });
    stadiumScenePromise.set(kind.key, p);
    return p;
  };

  const placeMarkersFor = async (hits) => {
    const newHits = hits.filter(hit => {
      const key = `${hit.name}|${hit.pos.lat.toFixed(5)},${hit.pos.lng.toFixed(5)}`;
      if (placedKeys.has(key)) return false;
      placedKeys.add(key);
      return true;
    });
    if (!newHits.length) return;

    // Kick off GLB loads (one per unique kind seen) in parallel.
    const kindsNeeded = new Map();
    for (const h of newHits) kindsNeeded.set(h.kind.key, h.kind);
    const sceneByKey = new Map();
    await Promise.all([...kindsNeeded.values()].map(async k => {
      sceneByKey.set(k.key, await loadStadiumScene(k));
    }));

    for (const hit of newHits) {
      // (HTML markers intentionally not placed — user wants only the 3D
      // models on the basemap.)

      const stadium = sceneByKey.get(hit.kind.key);
      if (!stadium || !cityState.scene) continue;

      // If the matched feature is a polygon we have its real extent + angle;
      // otherwise (point feature) fall back to the kind's defaults.
      const polyW = hit.pos.widthM;       // metres along principal axis
      const polyD = hit.pos.depthM;       // metres perpendicular
      const polyAngle = hit.pos.angle;    // radians CCW from east

      // Total yaw to align the GLB's natural +X axis with the polygon's
      // principal axis on the map. A rotation around +Y in Three.js by α
      // sends +X to (cos α, 0, -sin α). The layer's map transform makes
      // Three.js +X = east and Three.js +Z = south. So model-X lands as
      // map (east=cos α, north=+sin α). The polygon's principal axis is
      // (east=cos θ, north=sin θ). Setting these equal gives α = θ.
      // Plus any per-kind extraYaw baked in.
      const ang = (polyAngle != null ? polyAngle : 0) + (hit.kind.extraYaw || 0);

      // The polygon's principal-axis extent is `polyW` and perpendicular
      // is `polyD` — these are already in the rotated frame that aligns
      // with the model after yaw=α (set above so model-X points along the
      // polygon's principal direction). So scale is direct:
      //   sx = polyW / modelX  (model's X axis is now along principal)
      //   sz = polyD / modelZ  (model's Z is perpendicular)
      // The earlier projection formula was wrong: it assumed polyW/polyD
      // were E-W/N-S extents and tried to re-project them, but they're
      // ALREADY along the principal/perpendicular axes of the polygon.
      let scaleX, scaleZ;
      if (polyW && polyD) {
        scaleX = polyW / Math.max(0.001, stadium.size.x);
        scaleZ = polyD / Math.max(0.001, stadium.size.z);
      } else {
        const s = hit.kind.targetWidthM / Math.max(0.001, stadium.size.x);
        scaleX = s; scaleZ = s;
      }
      // Use the scaleX value for Y (vertical) so heights don't get
      // distorted in lockstep with horizontal stretching.
      const scaleY = scaleX;
      const baseLiftY = -stadium.box.min.y * scaleY;
      const cx = (stadium.box.min.x + stadium.box.max.x) / 2;
      const cz = (stadium.box.min.z + stadium.box.max.z) / 2;

      const loc = cityToLocal(hit.pos.lng, hit.pos.lat);
      const group = stadium.scene.clone(true);
      group.scale.set(scaleX, scaleY, scaleZ);
      group.rotation.y = ang;

      // Translation: place the model's XZ centroid at the feature centroid
      // and lift its base to ground. The centroid offset (cx, cz) is in
      // model-local coords; after scale + yaw it rotates with the group, so
      // we have to apply the rotation manually before subtracting.
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const cxScaled = cx * scaleX;
      const czScaled = cz * scaleZ;
      const cxRot = cxScaled * cosA + czScaled * sinA;
      const czRot = -cxScaled * sinA + czScaled * cosA;
      group.position.set(loc.x - cxRot, baseLiftY, loc.z - czRot);

      cityState.scene.add(group);
      cityState.meshes.push(group);
      const radiusM = Math.max(scaleX * stadium.size.x, scaleZ * stadium.size.z) / 2;
      cityState.stadiums.push({ group, lat: hit.pos.lat, lng: hit.pos.lng, radiusM });
      console.log(`[FloodTwin/${hit.kind.key}] 3D stadium placed @ ${hit.pos.lat.toFixed(5)}, ${hit.pos.lng.toFixed(5)} (sx=${scaleX.toFixed(3)} sz=${scaleZ.toFixed(3)}, yaw=${(ang * 180 / Math.PI).toFixed(1)}°, polyW=${polyW?.toFixed(1) ?? '-'}m polyD=${polyD?.toFixed(1) ?? '-'}m)`);
    }
    if (glMap) glMap.triggerRepaint();
  };

  tryPlace();
  // Bind to BOTH idle and moveend. The per-frame render loop calls
  // triggerRepaint() continuously whenever flood water or vehicles exist, so
  // the map may never fire 'idle' — relying on idle alone meant tryPlace never
  // re-ran after the flyTo to IITGN and stadiums were never placed. moveend
  // fires reliably when the flyTo settles regardless of the repaint loop.
  map.on('idle', tryPlace);
  map.on('moveend', tryPlace);
  // Belt-and-suspenders: also poll a few times after the camera should have
  // arrived, in case neither event lands cleanly (basemap still streaming
  // tiles when moveend fired, so queryRenderedFeatures returned nothing yet).
  for (const delay of [1500, 3000, 5000, 8000]) setTimeout(tryPlace, delay);
}

async function scatterRoadsFromMapplsLayers(){
  if (cityState.roadsScheduled) return;
  cityState.roadsScheduled = true;

  // Procedural road material: asphalt-grey base with a dashed centerline
  // drawn in the fragment shader. Pure GLSL, no texture asset — fully
  // tileable, no edge artifacts, and easy to tweak via the uniforms below.
  //
  // UV convention from the strip-building loop:
  //   u ∈ [0, 1] across the road's width (left edge → right edge)
  //   v advances along the road's length, repeating every ROAD_REPEAT_M
  //     metres — so `fract(v)` is the position within one repeat.
  //
  // We render fully opaque (no discards) so trees still occlude correctly
  // via the depth buffer at pitched zoom, and so the basemap road paint
  // doesn't poke through anywhere.
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uAsphalt:     { value: new THREE.Color(0x1a1a1a) }, // road surface
      uDash:        { value: new THREE.Color(0xffffff) }, // centerline dashes
      uDashesPerRepeat: { value: 2.0 },                   // dashes per ROAD_REPEAT_M
      uDashFill:    { value: 0.55 },                      // fraction of cycle that's painted
      uDashHalfWidth: { value: 0.10 },                    // dash half-width in U (wider so visible on thin roads)
    },
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3  uAsphalt;
      uniform vec3  uDash;
      uniform float uDashesPerRepeat;
      uniform float uDashFill;
      uniform float uDashHalfWidth;
      varying vec2  vUv;
      void main(){
        // Centerline dash mask: along V, the dashes repeat at
        // uDashesPerRepeat per unit of V. Each cycle of length 1.0 has a
        // painted segment of length uDashFill at the start.
        float cycle = fract(vUv.y * uDashesPerRepeat);
        float dashOnV = step(cycle, uDashFill);

        // Across U, the dash is centred at u = 0.5 with half-width
        // uDashHalfWidth, with a small smoothstep for anti-aliasing.
        float distFromCentre = abs(vUv.x - 0.5);
        float dashOnU = 1.0 - smoothstep(uDashHalfWidth, uDashHalfWidth + 0.01, distFromCentre);

        float dash = dashOnV * dashOnU;
        vec3 col = mix(uAsphalt, uDash, dash);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side:       THREE.DoubleSide,
    depthWrite: true,
    depthTest:  true,
  });

  // Strip parameters. Per-class width is computed from each feature's road
  // classification; the lookup is below in `widthForClass`. These constants
  // are the fallbacks and tuning knobs.
  const ROAD_REPEAT_M = 8;    // metres of road covered by one dash cycle
  const SAMPLE_STEP_M = 6;    // centerline resampling — finer for sharper turns
  const ROAD_Y        = 0.05; // tiny lift so the strip doesn't z-fight the basemap

  // Mapbox/Mappls road class → strip width in metres. Tuned to roughly match
  // the basemap's painted line widths at z16. Anything not listed gets the
  // default (residential street width).
  // All widths /3 from the previous values (motorway 14→4.67, primary 10→3.33,
  // residential 6→2, etc.) so the strips visually match the basemap line paint.
  const ROAD_WIDTH_BY_CLASS = {
    motorway:       4.67,
    trunk:          4.0,
    primary:        3.33,
    secondary:      2.67,
    tertiary:       2.33,
    street:         2.0,
    residential:    2.0,
    unclassified:   2.0,
    service:        1.33,
    driveway:       1.0,
    track:          1.0,
    pedestrian:     1.0,
    footway:        0.83,
    path:           0.67,
    cycleway:       0.67,
    steps:          0.67,
  };
  const DEFAULT_ROAD_WIDTH_M = 2.0;
  function widthForFeature(feat){
    const cls = (feat.properties?.class || feat.properties?.road_class ||
                 feat.properties?.type  || feat.properties?.highway || '').toLowerCase();
    if (cls in ROAD_WIDTH_BY_CLASS) return ROAD_WIDTH_BY_CLASS[cls];
    // Fuzzy match: many basemaps use compound classes like "primary_link"
    // or "motorway_link" — fall back to the base name.
    for (const k of Object.keys(ROAD_WIDTH_BY_CLASS)) {
      if (cls.startsWith(k)) return ROAD_WIDTH_BY_CLASS[k];
    }
    return DEFAULT_ROAD_WIDTH_M;
  }

  // Single mesh that we'll rebuild on each idle pass. Starts empty.
  const geo = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  cityState.scene.add(mesh);
  cityState.meshes.push(mesh);
  cityState.roadMesh = mesh;

  // Cumulative state across idle passes. Each line we've already eaten gets
  // its key cached so a re-query after a pan only adds new lines.
  const seenLines = new Set();
  // We accumulate vertices/indices/uvs in plain arrays and re-bake the
  // BufferGeometry whenever new lines arrive.
  const positions = []; // (x, y, z) per vertex
  const uvs       = []; // (u, v)    per vertex
  const indices   = []; // triangle vertex indices

  const placeFromRendered = () => {
    if (!cityState.enabled) return;
    if (map.getZoom() < 14) return;
    const c = map.getCenter();
    if (Math.abs(c.lng - CITY_REF_LNG) > 0.05 || Math.abs(c.lat - CITY_REF_LAT) > 0.05) return;

    const layerIds = getRoadLayerIds();
    if (!layerIds.length) return;
    const raw = map.queryRenderedFeatures(undefined, { layers: layerIds });
    if (!raw.length) return;

    let addedAny = false;

    for (const f of raw) {
      // Per-feature road width based on class. Halve for emitting offsets
      // left/right of centerline.
      const halfW = widthForFeature(f) / 2;
      const lines =
        f.geometry.type === 'LineString'      ? [f.geometry.coordinates] :
        f.geometry.type === 'MultiLineString' ? f.geometry.coordinates  : [];
      for (const line of lines) {
        if (line.length < 2) continue;
        const key = `${line[0][0].toFixed(5)},${line[0][1].toFixed(5)}|` +
                    `${line[line.length-1][0].toFixed(5)},${line[line.length-1][1].toFixed(5)}|` +
                    line.length;
        if (seenLines.has(key)) continue;
        seenLines.add(key);

        const pts = sampleRoadLine(line, SAMPLE_STEP_M);
        if (pts.length < 2) continue;

        // Convert centerline to local (x, z) once.
        const xz = pts.map(p => {
          const l = cityToLocal(p[0], p[1]);
          return [l.x, l.z];
        });
        // Side-effect: keep the path so the campus-life loop can spawn
        // vehicles along it. We dedup by `key` above so each path is
        // stored at most once.
        if (!cityState.roadPaths) cityState.roadPaths = [];
        cityState.roadPaths.push(xz);

        // Walk pairs of consecutive centerline points; emit one quad per
        // pair. UV `v` is cumulative distance / ROAD_REPEAT_M so the SVG
        // tiles continuously along the road (the SVG's vertical axis is
        // its length, ~16 viewBox units).
        let cumV = 0;
        let prevLeft = null, prevRight = null;
        for (let i = 0; i < xz.length; i++) {
          const [cx, cz] = xz[i];
          // Tangent direction at point i (average of prev/next segments).
          let tx = 0, tz = 0;
          if (i > 0)               { tx += xz[i][0] - xz[i-1][0]; tz += xz[i][1] - xz[i-1][1]; }
          if (i < xz.length - 1)   { tx += xz[i+1][0] - xz[i][0]; tz += xz[i+1][1] - xz[i][1]; }
          const tl = Math.hypot(tx, tz);
          if (tl > 0) { tx /= tl; tz /= tl; }
          // Perpendicular in the XZ plane (-z, +x rotated 90° CCW gives the
          // road-width direction).
          const nx = -tz, nz = tx;
          const left  = [cx + nx * halfW, ROAD_Y, cz + nz * halfW];
          const right = [cx - nx * halfW, ROAD_Y, cz - nz * halfW];

          // Advance the V coordinate by this segment's length. V is the
          // road's length direction (the SVG's own vertical axis); it
          // repeats every ROAD_REPEAT_M metres.
          if (i > 0) {
            const segLen = Math.hypot(xz[i][0] - xz[i-1][0], xz[i][1] - xz[i-1][1]);
            cumV += segLen / ROAD_REPEAT_M;
          }
          const v = cumV;

          // Push vertices with full U range [0, 1] across the road width;
          // the procedural shader uses u=0.5 as the centerline.
          const baseIdx = positions.length / 3;
          positions.push(left[0],  left[1],  left[2]);
          positions.push(right[0], right[1], right[2]);
          uvs.push(0, v);
          uvs.push(1, v);

          if (prevLeft !== null) {
            const a = baseIdx - 2; // prev left
            const b = baseIdx - 1; // prev right
            const c = baseIdx;     // curr left
            const d = baseIdx + 1; // curr right
            // Two triangles per quad
            indices.push(a, c, b);
            indices.push(b, c, d);
          }
          prevLeft = left; prevRight = right;
        }
        addedAny = true;
      }
    }

    if (!addedAny) return;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices.length > 65535
      ? new THREE.Uint32BufferAttribute(indices, 1)
      : new THREE.Uint16BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    if (glMap) glMap.triggerRepaint();
    console.log(`[FloodTwin] City roads: ${seenLines.size} road lines → ${indices.length / 3} triangles`);
  };

  placeFromRendered();
  map.on('idle', placeFromRendered);
}

// Viewport culler: hide cell meshes that lie outside the current map view,
// keeping on-screen draw calls to a small constant regardless of total
// instance count. Called once per `moveend`/`zoomend` — not per frame.
function cullCityToViewport(){
  if (!cityState.enabled || !cityState.cullables?.length || !map) return;
  let b;
  try { b = map.getBounds(); } catch (e) { return; }
  const w = b.getWest(), e = b.getEast();
  const s = b.getSouth(), n = b.getNorth();
  // Pad the viewport by 20% so panning a small amount doesn't pop new cells in.
  const padLng = (e - w) * 0.2, padLat = (n - s) * 0.2;
  const wPad = w - padLng, ePad = e + padLng;
  const sPad = s - padLat, nPad = n + padLat;

  let visibleCount = 0;
  for (const mesh of cityState.cullables) {
    const [minLng, minLat, maxLng, maxLat] = mesh.userData.cellBbox;
    // AABB-intersect test.
    const intersects =
      maxLng >= wPad && minLng <= ePad &&
      maxLat >= sPad && minLat <= nPad;
    mesh.visible = intersects;
    if (intersects) visibleCount++;
  }
  if (glMap) glMap.triggerRepaint();
  // console.log(`[FloodTwin] City cull: ${visibleCount}/${cityState.cullables.length} cells visible`);
}

document.getElementById('view3DCityBtn').addEventListener('click', async () => {
  const btn = document.getElementById('view3DCityBtn');
  try {
    if (!cityState.inited) {
      btn.classList.add('active');
      await initCityOverlay();
    } else {
      const next = !cityState.enabled;
      setCityVisibility(next);
      btn.classList.toggle('active', next);
    }
    // Fly to the LULC area so the user can actually see the 3D city
    try {
      map.flyTo({ center: { lat: CITY_REF_LAT, lng: CITY_REF_LNG }, zoom: 16, pitch: 55 });
    } catch(e){}
  } catch (err) {
    console.error('[FloodTwin] City overlay failed:', err);
    setStatus('❌ 3D city failed to load (assets/soil_ground.glb 404? — restart the Flask server).');
    btn.classList.remove('active');
    // Reset so the user can retry without reloading the page. Without this
    // the rejected promise is cached and every subsequent click immediately
    // re-throws. Also detach any partially-built meshes so a retry doesn't
    // double them up.
    for (const m of cityState.meshes) {
      if (cityState.scene) cityState.scene.remove(m);
    }
    cityState.meshes = [];
    cityState.cullables = [];
    cityState.buildOnce = null;
    cityState.inited = false;
  }
});

})();
