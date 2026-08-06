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
  // A single transient CDN/DNS blip used to hard-fail the whole app; retry a
  // few times with backoff before declaring the SDK unreachable.
  var attempt = 0, MAX_TRIES = 3;
  function tryLoad() {
    attempt++;
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
    s.onerror = function() {
      s.remove();
      if (attempt < MAX_TRIES) {
        setStatus('Map SDK unreachable — retrying (' + attempt + '/' + (MAX_TRIES - 1) + ')…');
        setTimeout(tryLoad, 1500 * attempt);
      } else {
        setStatus('❌ Map SDK failed to load after ' + MAX_TRIES + ' tries. Check network / adblock / API key.');
      }
    };
    document.head.appendChild(s);
  }
  tryLoad();
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

const CHUNK_SIZE=13,TOTAL_CHUNKS=1,MAX_CACHED=3;
// Timeline length depends on the active dataset: 12 (13 hourly steps) for the
// 09-July-2025 event, 144 (145 × 10-min frames) for the daily live forecast.
let TOTAL_STEPS=12;
// Dataset switch. Only the DYNAMICS differ between the two — the drainage
// geometry, the flood-plane grid and its bbox are shared and immutable, so
// switching sources never rebuilds geometry.
let SIM_BASE='/sim';               // '/sim' = July 2025 event, '/live' = forecast
let simDataset='event';            // 'event' | 'live'
const REF_LAT=28.4595,REF_LNG=77.0266;
const NOM_UA='FloodTwin/1.0';
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];

const GRID_W=1024,GRID_H=1024;
const PLANE_SEG=192;
const DEPTH_MAX=3.0;

// ── Drainage network (Gurugram storm + sewer, June-5 actual event) ───────────
// Rendered as underground tubes in the SAME Three.js scene as the flood water
// (anchored at REF_LAT/REF_LNG via toLocal). storm_network / sewer_network
// GeoJSON come from build_drainage_web_v2.py (141k Manning-verified hydraulic
// segments chained to ~41k polylines) and carry depth_crown_m / sec_h_m (metres
// below local ground); radius is exaggerated so 0.3 m pipes stay visible at
// city zoom. Tune these to taste.
const DRAIN_VEXAG=1.0;        // vertical exaggeration of pipe depth (m → scene)
const DRAIN_RADIUS_EXAG=3.0;  // cross-section radius exaggeration
const DRAIN_RADIUS_MIN=0.35;  // floor pipe radius in scene metres (small — lets real dimensions show)
const DRAIN_RADIUS_MAX=2.6;   // cap so 5.5 m trunk channels don't dwarf the street
// 1.6, not 3: at street zoom a 3× exaggerated trunk rendered as a ~10 m-wide
// water strip reads as a glossy highway, not a drain (user's recording).
const PIPE_RADIUS_SCALE=1.6;  // visibility exaggeration of the real cross-section (radius = sec_h·0.5·scale)
const SEWER_BASE_FILL=0.30;   // dry-weather sewage level (d/D ≈ 0.3 is typical design flow)
const SLOPE_DEV_MAX=9.0;      // cap the slope-induced vertical deviation (scene units) so a
                              // long steep trunk can't dive off-screen at PERF_VEXAG
const WAVE_TIME_SCALE=3;      // DISCLOSED exaggeration: the wetting wave plays 3× slower
                              // than real Manning travel time so propagation is visible at
                              // hourly steps — ordering & relative timing stay exact.
// Component hierarchy (mirrors the standard street-drainage cutaway vocabulary:
// side-entry pit → lateral pipe → stormwater main → trunk/outfall). Every conduit
// is assigned one tier; the tier drives its casing colour, the structured legend,
// per-tier visibility and the click-to-identify popup.
const DRAIN_TIERS=[
  {key:'trunk',   label:'Trunk Drain',      color:0xff7a3c, hex:'#ff7a3c'},  // Badshahpur legs etc.
  {key:'smain',   label:'Stormwater Main',  color:0x2f8fd6, hex:'#2f8fd6'},  // ≥0.8 m storm pipe
  {key:'slat',    label:'Lateral Pipe',     color:0x35c4d6, hex:'#35c4d6'},  // small storm pipe
  {key:'schan',   label:'Open Channel',     color:0x1f5fb0, hex:'#1f5fb0'},  // rectangular box/open drain
  {key:'sewmain', label:'Sewer Main',       color:0xc98f3c, hex:'#c98f3c'},  // ≥0.4 m sewer
  {key:'sewlat',  label:'Sewer Lateral',    color:0x8a6a3a, hex:'#8a6a3a'},
];
const STORM_MAIN_MIN_D=0.8;   // storm pipe ≥ this dia (m) counts as a "Stormwater Main"
function drainTierFor(p,netF){
  if(netF===1)return p.asset_class==='sewer main'?4:5;
  if(p.trunk_id||p.trunk_name||p.asset_class==='main drain leg')return 0;
  if(p.asset_class==='storm channel')return 3;
  return (p.sec_h_m??0.6)>=STORM_MAIN_MIN_D?1:2;
}
const DRAIN_CLASS_COLOR={
  'storm pipe':0x35c4d6,          // cyan
  'storm channel':0x1f5fb0,       // blue (rectangular open/box drains)
  'sewer main':0xc98f3c,          // amber
  'sewer lateral':0x8a6a3a,       // brown
  'main drain leg':0xff7a3c,      // orange (trunk)
};

// ── Drainage PERFORMANCE overlay (manhole fill + backflow over the event) ─────
// 152 actionable manholes animate over the July-9 timeline: water column rises
// from invert→rim between onset_min and peak_min, then erupts as a backflow
// plume. Synced to the existing hourly slider (eventMinute = step × 60).
const PERF_VEXAG   = 4.0;   // vertical scale of manhole/pipe depth (moderate — readable at neighbourhood zoom+tilt)
const MANHOLE_R_M  = 1.2;   // manhole shaft radius in scene metres (~2.4 m cover — realistic)
const PERF_BACKFLOW_FULL_M3 = 25000;   // cumulative backflow that maps to "max severity" colour
// Causal-order timing (physically: inlet → pipe fills → manhole fills → overflow).
// PIPE filling is now fully physical (wetting wave from the network heads at each
// pipe's Manning velocity + calibrated utilisation — see updateDrainFill); the
// manhole/inlet windows below still anchor to each manhole's OBSERVED backflow
// onset T_bf (onset_min in the data), and the shaft remains capped by its pipe.
const MH_FILL_WIN_MIN = 45;   // manhole shaft fills over this window, full (overflow) at T_bf
const INLET_LEAD_MIN  = 90;   // inlets start capturing even earlier (surface water arrives first)

// Depth-band legend filter. The legend doubles as a filter: each band can be
// toggled on/off to show only flood polygons whose depth falls in the selected
// range(s). Bands match the legend rows (and the FRAG_SRC colour gradient).
// e.g. to find hotspots >1 m, leave only 'high' and 'sev' active.
// Band edges track the day's own depth range (see recomputeDepthScale) and sit at
// the same normalised stops as the shader ramp, so the legend always describes
// what is actually on screen rather than a fixed 3 m event.
const DEPTH_BAND_STOPS=[0.18,0.40,0.62];
const DEPTH_BANDS=[
  {key:'low', max:0.2},
  {key:'mod', max:0.6},
  {key:'high',max:1.2},
  {key:'sev', max:Infinity}
];
const activeBands=new Set(DEPTH_BANDS.map(b=>b.key));   // all visible by default
function bandKeyForDepth(d){
  for(const b of DEPTH_BANDS)if(d<b.max)return b.key;
  return 'sev';
}
// The depth colour scale for the ACTIVE day/event. Live-forecast manifests carry
// per-frame max_depth_m so the range is known up front; the event dataset has no
// per-frame stats, so we track the deepest cell actually seen and grow into it.
let depthScaleMax=DEPTH_MAX, depthScaleObserved=0, depthScaleInit=false;
function applyDepthScale(){
  const m=Math.max(0.25,depthScaleMax);
  for(const mat of [(typeof waterMaterial!=='undefined'?waterMaterial:null),
                    (typeof simState!=='undefined'&&simState?simState.floodMat:null)]){
    if(mat&&mat.uniforms&&mat.uniforms.uMaxDepth)mat.uniforms.uMaxDepth.value=m;
  }
  DEPTH_BAND_STOPS.forEach((s,i)=>{ DEPTH_BANDS[i].max=+(s*m).toFixed(3); });
  renderDepthLegend();
  if(glMap)glMap.triggerRepaint();
}
function recomputeDepthScale(){
  const man=(typeof simState!=='undefined'&&simState)?simState.man:null;
  let mx=0;
  if(man&&Array.isArray(man.frames))
    for(const f of man.frames)if(f&&f.max_depth_m>mx)mx=f.max_depth_m;
  if(!mx)mx=depthScaleObserved;                 // event dataset: whatever we've seen
  if(!mx)mx=DEPTH_MAX;
  mx=Math.max(0.25,Math.ceil(mx*10)/10);        // tidy 0.1 m step
  if(depthScaleInit&&Math.abs(mx-depthScaleMax)<1e-3)return;
  depthScaleInit=true;                          // always paint the legend once
  depthScaleMax=mx;
  applyDepthScale();
}
// Continuous swatch + the day's own numbers, mirroring the shader's stops.
function rampCssStops(){
  return '#B3EBF7 0%, #7BCFEE 18%, #4B93C8 40%, #FA8F26 62%, #DC2626 82%, #7A0B0B 100%';
}
function renderDepthLegend(){
  const bar=document.getElementById('legendRamp');
  if(bar)bar.style.background=`linear-gradient(90deg,${rampCssStops()})`;
  const fmt=v=>v>=10?v.toFixed(0):v>=1?v.toFixed(1):v.toFixed(2);
  const e=DEPTH_BANDS.map(b=>b.max);
  const txt=[`<${fmt(e[0])}m`,`${fmt(e[0])}–${fmt(e[1])}m`,`${fmt(e[1])}–${fmt(e[2])}m`,`>${fmt(e[2])}m`];
  document.querySelectorAll('#legend .legend-row').forEach((row,i)=>{
    const r=row.querySelector('.legend-range'); if(r&&txt[i])r.textContent=txt[i];
  });
  const mx=document.getElementById('legendMax');
  if(mx)mx.textContent=`0 – ${fmt(depthScaleMax)} m today`;
}

let map,glMap,scene,camera,renderer,modelTransform;
let currentStep=0,isPlaying=false,playInterval=null,playSpeed=500;
let floodOpacity=0.70,depthScale=1.0;
let waterMeshes=[],polygonCount=0,coordinatesBuffer=null;
let drainMeshes=[],drainEnabled=false,drainLoaded=false,drainLight=null;
// Default to the READABLE subset: trunk + stormwater mains + open channels +
// sewer mains — BOTH networks are part of the story. The 4.3k storm laterals
// and 30k sewer laterals are opt-in via the legend (spaghetti at city zoom).
let drainTierVis=[1,1,0,1,1,0];          // per-tier visibility (DRAIN_TIERS order)
let drainTierStats=null,drainPickAdded=false,eventPeakStep=null;
let drainLinkDyn=null,drainAVel=null,drainSurfAVel=null;   // SWMM-solved per-link series + velocity buffers
let useSimNetwork=false;   // true once the REAL coupled 1D-2D run is driving the view
let drainCatch=null,drainCatchAdded=false;                 // catchment polygons + per-hour inundation
let drainEngMode=false,drainWaterMesh=null,drainSurfMesh=null,drainRingMesh=null;   // WATER view is the default (drains filling); capacity choropleth is the opt-in skin
let drainConduits=[],drainAFill=null,drainAFront=null,drainFlowMat=null,mhWaterMat=null;   // flow + manhole-water shaders
let drainSurfMat=null,drainSurfAFill=null;   // flat water-surface ribbon inside the pipes
let perfManholes=[],perfEnabled=false,perfLoaded=false,perfHydro=null,overflowRippleMat=null,perfSurcharging=0;
let eventHydro=null,eventStorageMax=1;               // shared citywide hydrograph (drives fill)
let perfBackflowAdded=false,perfPumpsAdded=false,perfPumpsData=null,perfInletsAdded=false,perfOutfallsAdded=false;   // maplibre marker layers (lazy)
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
  const len=coordinatesBuffer.byteLength;
  polygonRings=[];
  let off=0;
  // coordinates.bin is self-describing: per polygon, [uint32 vertexCount,
  // vertexCount × (float64 lng, float64 lat)], repeated to EOF. Walking to the
  // end yields polygonCount directly, so we no longer download the 6 MB
  // polygon_index.json on the critical path just to read its length.
  while(off+4<=len){
    const pc=dv.getUint32(off,true);off+=4;
    if(off+pc*16>len)break;
    const ring=[];
    for(let i=0;i<pc;i++){ring.push({lng:dv.getFloat64(off,true),lat:dv.getFloat64(off+8,true)});off+=16;}
    polygonRings.push(ring);
  }
  polygonCount=polygonRings.length;
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
  {max:0.2,label:'Low',bg:'#e6f7f9',color:'#0e7490',dot:'#B3EBF7'},
  {max:0.6,label:'Moderate',bg:'#cceef5',color:'#0369a1',dot:'#7BCFEE'},
  {max:1.2,label:'High',bg:'#fde3d6',color:'#c2410c',dot:'#FA8F26'},      // >0.6 m → critical (red)
  {max:Infinity,label:'Severe',bg:'#5c0f0f',color:'#fff',dot:'#DC2626'}
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
  const allBands=activeBands.size===DEPTH_BANDS.length;
  for(let p=0;p<polygonCount;p++){
    if(depths[p]<=0)continue;
    // Only inspect flood that's actually visible under the legend filter.
    if(!allBands&&!activeBands.has(bandKeyForDepth(depths[p])))continue;
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

// Gurugram-proper extent (south,west,north,east). Deliberately tighter than the
// district so critical-asset markers stay within the city and don't pull in
// prominent south-Delhi POIs (AIIMS, Saket, Kapashera) that a looser box covers.
const GURUGRAM_BBOX     = '28.37,76.95,28.51,77.10';
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

// Keep every visible asset marker glued to its lat/lng on the Mappls basemap.
// Called from scheduleMapSync on move/zoom/pitch/rotate/resize.
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

// Run the asset fetch once, when the browser is idle, so the ~Google round-trips
// never compete with the critical flood-data download on first paint.
let _assetsBootStarted = false;
function bootAssetsDeferred() {
  if (_assetsBootStarted) return;
  _assetsBootStarted = true;
  if (window.requestIdleCallback) requestIdleCallback(loadAllAssets, { timeout: 4000 });
  else setTimeout(loadAllAssets, 1200);
}

function loadAllAssets() {
  _buildAssetRows();
  const ab = document.getElementById('assetBadge');
  if (ab) { ab.textContent = 'Loading…'; ab.style.background = ''; ab.style.color = ''; }

  _fetchAllCategories().then(buckets => {
    // Critical-asset markers (coordinates AND names) come from the /api/assets
    // proxy, which serves Google Places when a key is configured and otherwise
    // falls back to OSM/Overpass. Either way the response is one bucket per
    // category, so the rendering below is source-agnostic.
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
    if(q.length<2){list.style.display='none';return;}
    searchDebounce=setTimeout(()=>googleForward(q,list,input),300);
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

let _searchHome=null;   // remembers the search bar's normal parent (the sidebar)
function syncFullscreenState(){
  isFullscreen=!!document.fullscreenElement;
  document.body.classList.toggle('is-fullscreen',isFullscreen);
  const sw=document.getElementById('searchWrap');
  if(isFullscreen){
    const sb=document.getElementById('sidebar');
    if(sb&&!sb.classList.contains('collapsed'))toggleSidebar();
    // Lift the search bar out of the (now collapsed, transformed) sidebar into
    // the fullscreen element. A position:fixed child of a transformed ancestor
    // is positioned relative to that ancestor — which is off-screen — so without
    // this the top-middle search bar would be invisible in fullscreen.
    const host=document.fullscreenElement||document.body;
    if(sw&&sw.parentNode!==host){_searchHome={parent:sw.parentNode,next:sw.nextSibling};host.appendChild(sw);}
  }else if(sw&&_searchHome){
    _searchHome.parent.insertBefore(sw,_searchHome.next);_searchHome=null;   // restore original position
  }
  const fsBtn=document.getElementById('fullscreenBtn');
  if(fsBtn){fsBtn.classList.toggle('active',isFullscreen);fsBtn.textContent=isFullscreen?'✕':'⛶';fsBtn.title=isFullscreen?'Exit fullscreen':'Toggle fullscreen';}
  // Map container size changes with fullscreen; resize the GL canvas to fit.
  setTimeout(()=>{try{map&&map.resize();}catch(e){}updateScaleBars();repositionFloodPopup();},80);
  updateScaleBars();
  repositionFloodPopup();
}
// Fullscreen the whole app shell so the kept overlays — top-middle search bar,
// depth-legend filter, and flood-hotspots panel — stay inside the fullscreen
// element (header + sidebar are hidden by the body.is-fullscreen CSS).
function toggleFullscreen(){
  const el=document.querySelector('.app-shell')||document.documentElement;
  try{
    if(!document.fullscreenElement){
      (el.requestFullscreen||el.webkitRequestFullscreen||el.msRequestFullscreen).call(el);
    }else{
      (document.exitFullscreen||document.webkitExitFullscreen||document.msExitFullscreen).call(document);
    }
  }catch(e){}
}
// Forward search via Google Places Autocomplete (proxied through /api/geocode).
// Autocomplete returns placeIds only; coordinates are resolved on selection via
// /api/geocode/place. Reverse geocoding (map-click) still uses Nominatim below.
async function googleForward(query,list,input){
  try{
    const r=await fetch('/api/geocode/autocomplete?q='+encodeURIComponent(query));
    if(!r.ok){list.style.display='none';return;}
    const {suggestions}=await r.json();
    if(!suggestions||!suggestions.length){list.style.display='none';return;}
    list.innerHTML=suggestions.map(s=>
      `<li data-pid="${esc(s.placeId)}"><span class="sg-main">${esc(s.main)}</span>`+
      (s.secondary?`<span class="sg-sec">${esc(s.secondary)}</span>`:'')+`</li>`
    ).join('');
    list.style.display='block';
    list.querySelectorAll('li').forEach(li=>li.addEventListener('click',async()=>{
      const label=li.querySelector('.sg-main').textContent.trim();
      input.value=label;list.style.display='none';
      try{
        const pr=await fetch('/api/geocode/place?id='+encodeURIComponent(li.dataset.pid));
        if(!pr.ok)return;
        const p=await pr.json();
        if(p.lat!=null&&p.lng!=null)flyPin(p.lat,p.lng,p.address||label);
      }catch(e){}
    }));
  }catch(e){list.style.display='none';}
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
// 2 octaves, not 4. This shader runs over a near-fullscreen transparent mesh
// and was the single biggest frame cost in the app (hiding it tripled FPS), so
// the octave count and the number of fbm() evaluations below are deliberately
// kept minimal — the visual difference at water scale is negligible.
float fbm(vec2 p){
  float v = 0.5*noise(p);
  p = p*2.1 + vec2(1.7,9.2);
  v += 0.25*noise(p);
  return v;
}
// value + screen-space gradient from ONE evaluation instead of three.
vec3 fbmG(vec2 p){
  float v = fbm(p);
  return vec3(v, dFdx(v), dFdy(v));
}

// 5-tap cross instead of a 9-tap box — same softening, ~half the texture reads
float sampleSoft(vec2 c){
  float s = 0.0;
  s += texture2D(uDepthTex, c + uTexelSize*vec2( 0.0,-1.0)).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2(-1.0, 0.0)).r;
  s += texture2D(uDepthTex, c).r * 5.0;
  s += texture2D(uDepthTex, c + uTexelSize*vec2( 1.0, 0.0)).r;
  s += texture2D(uDepthTex, c + uTexelSize*vec2( 0.0, 1.0)).r;
  return s * 0.111111;
}

// Colour ramp: shallow/moderate (≤0.6 m) stays BLUE; critical depths (>0.6 m)
// switch to an orange→red→dark-red gradient so deep zones read as danger.
// Continuous ramp in NORMALISED depth (t = depth / uMaxDepth), so the palette
// stretches to whatever the day's actual range is instead of assuming a 3 m
// event. Successive smoothstep mixes leave no seam — the old version jumped
// straight from blue to orange at 0.6 m, which read as a hard contour line.
vec3 gradient4(float depth){
  float t = clamp(depth / max(uMaxDepth, 0.05), 0.0, 1.0);
  vec3 a = vec3(0.702, 0.922, 0.969);  // #B3EBF7  pale cyan   (shallowest)
  vec3 b = vec3(0.482, 0.812, 0.933);  // #7BCFEE
  vec3 c = vec3(0.294, 0.576, 0.784);  // #4B93C8  blue max
  vec3 o = vec3(0.980, 0.560, 0.150);  // #FA8F26  critical
  vec3 r = vec3(0.863, 0.149, 0.149);  // #DC2626
  vec3 dr= vec3(0.478, 0.043, 0.043);  // #7A0B0B  deepest
  vec3 col = mix(a,  b,  smoothstep(0.00, 0.18, t));
  col      = mix(col, c, smoothstep(0.14, 0.40, t));
  col      = mix(col, o, smoothstep(0.40, 0.62, t));
  col      = mix(col, r, smoothstep(0.62, 0.82, t));
  col      = mix(col, dr,smoothstep(0.82, 1.00, t));
  return col;
}

void main(){
  float depth = sampleSoft(vUv);
  float alphaMask = smoothstep(0.02, 0.22, depth);
  if(alphaMask <= 0.001) discard;

  float d = clamp(depth / uMaxDepth, 0.0, 1.0);   // normalised — used by caustics below
  vec3 base = gradient4(depth);                    // colour straight from depth in metres

  float dL = sampleSoft(vUv - vec2(uTexelSize.x, 0.0));
  float dR = sampleSoft(vUv + vec2(uTexelSize.x, 0.0));
  float dDn = sampleSoft(vUv - vec2(0.0, uTexelSize.y));
  float dUp = sampleSoft(vUv + vec2(0.0, uTexelSize.y));
  vec3 N = normalize(vec3(-(dR - dL)*2.2, 1.0, -(dUp - dDn)*2.2));

  float t = uTime * 0.09;
  vec2 wv1 = vUv*220.0 + vec2( t*1.6,  t*1.2);
  vec2 wv2 = vUv*340.0 + vec2(-t*1.1,  t*0.9);
  // 2 fbm evaluations (was 6) — gradients come from screen-space derivatives
  vec3 gA = fbmG(wv1), gB = fbmG(wv2);
  float nA = gA.x, nB = gB.x;
  vec3 bumpN = normalize(vec3(-(gA.y + gB.y)*90.0, 1.0, -(gA.z + gB.z)*90.0));
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

// Flood-sheet grid over the flood scene bbox. Each vertex carries:
//   uv → the depth texture (from scene x,z, matching polyToTexel)
function buildGridArrays(seg){
  const n=(seg+1)*(seg+1);
  const pos=new Float32Array(n*3);
  const duv=new Float32Array(n*2);
  const gw=gridMaxX-gridMinX, gh=gridMaxZ-gridMinZ;
  let vi=0,di=0;
  for(let j=0;j<=seg;j++){
    for(let i=0;i<=seg;i++){
      const x=gridMinX + (i/seg)*gw, z=gridMinZ + (j/seg)*gh;
      pos[vi++]=x; pos[vi++]=0; pos[vi++]=z;
      duv[di++]=(x-gridMinX)/gw; duv[di++]=(z-gridMinZ)/gh;
    }
  }
  const q=seg*seg;
  const idx=n>65535?new Uint32Array(q*6):new Uint16Array(q*6);
  let ii=0;
  for(let j=0;j<seg;j++)for(let i=0;i<seg;i++){
    const a=j*(seg+1)+i,b=a+1,c=a+(seg+1),d=c+1;
    idx[ii++]=a;idx[ii++]=c;idx[ii++]=b;
    idx[ii++]=b;idx[ii++]=c;idx[ii++]=d;
  }
  return {pos,duv,idx};
}

function buildWaterSurfaceMesh(){
  if(!scene||!window.THREE||waterMeshes.length)return;
  const g = buildGridArrays(PLANE_SEG);
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(g.pos,3));
  geo.setAttribute('uv',new THREE.BufferAttribute(g.duv,2));
  geo.setIndex(new THREE.BufferAttribute(g.idx,1));

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
    transparent:true,side:THREE.DoubleSide,depthWrite:false,
    extensions:{derivatives:true}          // fbmG() uses dFdx/dFdy for the normal
  });
  const mesh=new THREE.Mesh(geo,waterMaterial);
  mesh.frustumCulled=false;
  scene.add(mesh);waterMeshes.push(mesh);
}




// ── Drainage network: underground 3D tubes ───────────────────────────────────
function drainColorFor(p){
  const c=DRAIN_CLASS_COLOR[p.asset_class];
  if(c!==undefined)return c;
  if(p.trunk_id||p.trunk_name)return 0xff7a3c;   // trunk legs file has no asset_class
  if(p.net==='sewer')return 0xc98f3c;
  return 0x35c4d6;
}
function drainLineParts(geom){
  if(!geom)return [];
  if(geom.type==='LineString')return [geom.coordinates];
  if(geom.type==='MultiLineString')return geom.coordinates;
  return [];
}
// Shared citywide hydrograph (node storage / links-active over the event). One
// fetch, reused by both the drain-fill and manhole overlays.
async function getEventHydro(){
  if(eventHydro)return eventHydro;
  try{
    eventHydro=await fetch('/drainage/hydrograph.json').then(r=>r.json());
    eventStorageMax=Math.max(1,...(eventHydro.frames||[]).map(f=>f.node_storage_m3));
  }catch(e){ eventHydro=null; }
  return eventHydro;
}
function storageFracAt(step){                          // 0 (dry) … 1 (peak network storage)
  if(!eventHydro||!eventHydro.frames)return 0;
  const fr=eventHydro.frames.find(f=>Math.round(f.t_h)===step);
  return fr?Math.min(1,fr.node_storage_m3/eventStorageMax):0;
}
let eventRainStart=null;                               // first minute the network sees water
function rainStartMin(){
  if(eventRainStart!==null)return eventRainStart;
  eventRainStart=0;
  if(eventHydro&&eventHydro.frames)
    for(const f of eventHydro.frames){ if(f.node_storage_m3>0.02*eventStorageMax){eventRainStart=Math.round(f.t_h)*60;break;} }
  return eventRainStart;
}
// Causal event phase for the current hour — the one-line story stakeholders read
// while scrubbing: rain → inlets capture → mains load → surcharge → recession.
function eventPhaseAt(step){
  if(!eventHydro||!eventHydro.frames)return null;
  if(eventPeakStep===null){
    let m=-1;
    for(const f of eventHydro.frames)if(f.node_storage_m3>m){m=f.node_storage_m3;eventPeakStep=Math.round(f.t_h);}
  }
  const frac=storageFracAt(step), rising=step<=eventPeakStep;
  if(frac<0.05) return rising
    ? {n:1,label:'Rain building — runoff on streets',color:'#7bcfee'}
    : {n:5,label:'Network drained',color:'#8fa3b5'};
  if(rising){
    if(frac<0.35) return {n:2,label:'Inlets capturing — network filling',color:'#2fd0ff'};
    if(frac<0.85) return {n:3,label:'Storm mains loading',color:'#2f8fd6'};
    return {n:4,label:'AT CAPACITY — manholes surcharging',color:'#e64c30'};
  }
  if(frac>=0.85) return {n:4,label:'AT CAPACITY — manholes surcharging',color:'#e64c30'};
  return {n:5,label:'Receding — outfalls discharging',color:'#12b39a'};
}
function updateDrainPhase(step){
  const el=document.getElementById('drainPhase');
  const ph=eventPhaseAt(step);
  if(!el||!ph)return;
  el.innerHTML=`<span class="ph-dot" style="background:${ph.color}"></span>Hour ${step} · Phase ${ph.n}/5 — ${ph.label}`;
  el.style.borderColor=ph.color;
  // KPI strip: the hour's story in numbers — what an operations desk reads.
  const kp=document.getElementById('drainKpis');
  if(kp&&useSimNetwork&&simState.ready){
    // REAL solved counts straight from the coupled run
    const rec=simState.hourCache.get(simState.hour);
    let active=0,hot=0;
    if(rec){ const fs=simState.man.flow_scale||100;
      for(let i=0;i<rec.flow.length;i++){const q=Math.abs(rec.flow[i])/fs; if(q>0.001)active++; if(q>0.5)hot++;} }
    kp.innerHTML=
      `<span class="kpi ${simSurchargedCount>5000?'bad':''}"><b>${simSurchargedCount.toLocaleString()}</b> nodes surcharging</span>`+
      `<span class="kpi"><b>${active.toLocaleString()}</b> links flowing</span>`+
      `<span class="kpi"><b>${hot.toLocaleString()}</b> above 0.5 m³/s</span>`+
      `<span class="kpi">real 133 mm·12 h run</span>`;
    return;
  }
  if(kp&&drainConduits.length){
    let kmS=0,kmH=0;
    for(const cd of drainConduits){
      if(!drainTierVis[cd.tier])continue;
      if(cd.fillT>=0.9)kmS+=cd.len; else if(cd.fillT>=0.6)kmH+=cd.len;
    }
    let cs=0,ct=0;
    for(const ft of (drainCatch&&drainCatch.features||[])){
      ct++; const i=Math.min(step,ft.properties.fill.length-1);
      if(ft.properties.fill[i]>=55)cs++;
    }
    let pOn=0,pT=0;
    if(perfPumpsData){ for(const f of perfPumpsData.features){ pT++; if(f.properties._on)pOn++; } }
    kp.innerHTML=
      `<span class="kpi ${kmS>1000?'bad':''}"><b>${(kmS/1000).toFixed(1)} km</b> surcharged</span>`+
      `<span class="kpi"><b>${(kmH/1000).toFixed(0)} km</b> above 60%</span>`+
      (ct?`<span class="kpi ${cs?'bad':''}"><b>${cs}/${ct}</b> catchments stressed</span>`:'')+
      (pT?`<span class="kpi"><b>${pOn}/${pT}</b> pumps running</span>`:'');
  }
  // outfalls breathe while the network is discharging (synced to storage curve)
  if(map&&map.getLayer('outfalls-circles')){
    const frac=storageFracAt(step);
    map.setPaintProperty('outfalls-circles','circle-radius',
      ['interpolate',['linear'],['zoom'],11,4+6*frac,16,11+9*frac]);
    map.setPaintProperty('outfalls-circles','circle-color',frac>0.4?'#19e0c0':'#12b39a');
  }
}
// Pipe-fill shader: the pipe wall is a faint x-ray casing; WATER physically sits
// in the bottom of the cross-section and its level RISES as the conduit fills
// (vY vs the per-pipe waterline aBottom+aFill·aDiam), with a gentle flow ripple
// on the surface. Just like water filling a storm drain in the reference video.
const PIPE_VERT=`
attribute float aLen;
attribute float aFill;     // cross-section fill 0..1 (water LEVEL)
attribute float aBottom;   // scene-Y of the pipe invert (bottom)
attribute float aDiam;     // pipe internal height (crown − invert)
attribute float aFront;    // longitudinal fill 0..1 (how far water has travelled)
attribute float aNet;      // 0 = storm, 1 = sewer (water tint)
attribute float aTier;     // component tier (DRAIN_TIERS index — casing colour + visibility)
attribute float aVel;      // current flow velocity m/s (solved) — drives streak speed
// tier lookups happen HERE: GLSL ES 1.0 fragment shaders can't index uniform
// arrays dynamically, so visibility + casing colour go down as varyings.
uniform float uTierVis[6];
uniform vec3  uTierCol[6];
varying float vY; varying float vFill; varying float vBottom; varying float vDiam;
varying float vU; varying float vAround; varying float vLen; varying float vFront; varying float vNet;
varying float vVis; varying vec3 vWall; varying float vVel;
void main(){
  vY = position.y; vFill = aFill; vBottom = aBottom; vDiam = aDiam; vNet = aNet;
  vU = uv.x * aLen; vAround = uv.y; vLen = aLen; vFront = aFront; vVel = aVel;
  int t = int(aTier + 0.5);
  vVis = uTierVis[t]; vWall = uTierCol[t];
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
}`;
const PIPE_FRAG=`
precision highp float;
uniform float uTime; uniform float uSpeed; uniform float uSpacing;
varying float vY; varying float vFill; varying float vBottom; varying float vDiam;
varying float vU; varying float vAround; varying float vLen; varying float vFront; varying float vNet;
varying float vVis; varying vec3 vWall; varying float vVel;   // tier visibility/casing colour + flow velocity
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.1+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
  if(vVis<0.5) discard;                                      // tier toggled off in the legend
  float fill=clamp(vFill,0.0,1.0);
  float waterY = vBottom + fill*vDiam;                       // GRAVITY-horizontal water surface
  float edge   = max(vDiam*0.06, 0.01);
  float underw = 1.0 - smoothstep(waterY-edge, waterY+edge, vY);   // below the water surface
  // longitudinal water front: water only exists where it has already travelled (air pocket ahead)
  float frontU = vFront*vLen;
  float fsoft  = max(vLen*0.03, 3.0);
  float behind = 1.0 - smoothstep(frontU, frontU+fsoft, vU);  // 1 well behind front → 0 ahead of it
  float present = underw*behind;
  if(present < 0.02) discard;                                // dry wall/air — the CASING mesh draws the pipe now
  // depth below the surface → absorption (storm: shallow cyan → deep teal-blue;
  // sewer: murky olive → dark brown — sewage, not rainwater)
  float depth = clamp((waterY - vY)/max(vDiam,0.001), 0.0, 1.0);
  vec3 shallow = mix(vec3(0.55,0.82,0.95), vec3(0.64,0.60,0.38), vNet);
  vec3 deep    = mix(vec3(0.06,0.30,0.52), vec3(0.22,0.18,0.07), vNet);
  vec3 col = mix(shallow, deep, pow(depth,0.7));
  // flow: advected fbm drifting downstream at the SOLVED velocity → the water
  // visibly moves faster where the hydraulics say it does
  float adv = uTime*(0.25 + vVel*0.55);
  vec2 fuv = vec2(vU*0.05 - adv, vAround*4.0);
  float f1 = fbm(fuv), f2 = fbm(fuv*1.7 + vec2(uTime*0.15,0.0));
  float caustic = pow(clamp(1.0 - abs(f1-f2), 0.0, 1.0), 3.0);
  // caustics: refracted light webs dancing on the submerged pipe wall — strongest
  // on the pipe floor (light focused through the water above it)
  float floorFac = clamp(-0.5-0.9*(vY-vBottom)/max(vDiam,0.001)+1.0, 0.35, 1.0);
  col += vec3(0.45,0.68,0.80)*caustic*0.34*floorFac*(1.0-depth*0.35);
  float sparkle = pow(clamp(1.0-abs(fbm(fuv*3.1+7.3)-fbm(fuv*2.6-2.1)),0.0,1.0),8.0);
  col += vec3(0.85,0.95,1.0)*sparkle*0.18*(1.0-vNet*0.5);
  // FLOW CHEVRONS: crisp arrowheads marching downstream — the V apex leads, the
  // spacing-to-speed ratio makes fast trunks visibly race past slow laterals.
  // (Replaces soft "packets" that read as decoration rather than direction.)
  float chPhase = vU/uSpacing - uTime*(0.10 + vVel*0.30) - abs(vAround-0.5)*0.55;
  float chF = fract(chPhase);
  float chev = (smoothstep(0.14,0.10,chF)*smoothstep(0.02,0.06,chF)) * step(0.06, vVel);
  vec3 chevCol = mix(vec3(0.92,1.0,1.0), vec3(0.90,0.84,0.60), vNet);
  col = mix(col, chevCol, chev*(0.35+0.35*clamp(vVel*0.5,0.0,1.0)));
  // soft surface sheen + a little Fresnel-ish brightening at grazing top
  float surf = smoothstep(edge*2.2, 0.0, abs(vY - waterY));
  col += vec3(0.80,0.92,1.0)*surf*0.30;
  // turbulent leading edge: foam + bubbles in a zone just behind the advancing front
  float frontDist = frontU - vU;                              // >0 behind, <0 ahead
  float foam = smoothstep(fsoft*2.5, 0.0, frontDist) * behind * step(0.02, vFront) * (1.0 - step(0.999, vFront));
  float bub  = step(0.72, fbm(vec2(vU*0.5 - uTime*1.1, vAround*9.0)));
  vec3 foamCol = mix(vec3(0.93,0.97,1.0), vec3(0.84,0.79,0.62), vNet);   // sewage foam is dingy
  col = mix(col, foamCol, foam*(0.35+0.65*bub)*0.6);
  float alpha = mix(0.40,0.82,depth) + surf*0.12 + foam*0.25;  // deeper = more opaque (absorption)
  // AT CAPACITY: as the section approaches full (surcharge), the water reads as
  // pressurized — hot red with a pulse — so overloaded reaches jump out at a glance.
  float presur = smoothstep(0.90,0.99,fill);
  col = mix(col, vec3(0.96,0.32,0.18), presur*(0.45+0.15*sin(uTime*5.0)));
  alpha += presur*0.10;
  gl_FragColor = vec4(col, clamp(alpha,0.0,0.92));
}`;
function getDrainFlowMat(){
  if(!drainFlowMat){
    drainFlowMat=new THREE.ShaderMaterial({
      uniforms:{ uTime:{value:0}, uSpeed:{value:18.0}, uSpacing:{value:45.0},
        uTierVis:{value:drainTierVis.slice()},
        uTierCol:{value:DRAIN_TIERS.map(t=>new THREE.Color(t.color))} },
      vertexShader:PIPE_VERT, fragmentShader:PIPE_FRAG,
      transparent:true, depthWrite:false, side:THREE.DoubleSide
    });
  }
  return drainFlowMat;
}
// Flat WATER SURFACE ribbon: a strip that follows the pipe at the current water
// level (aBottom + aFill·aDiam) with the correct chord width, so you see the
// air–water interface — a real surface, not paint on the shell.
const SURF_VERT=`
attribute vec3 aPerp; attribute float aSide; attribute float aBottom; attribute float aDiam; attribute float aFill; attribute float aU; attribute float aNet; attribute float aTier; attribute float aVel;
uniform float uTierVis[6];   // dynamic uniform-array indexing is vertex-stage only in ES 1.0
varying float vU; varying float vFill; varying vec3 vW; varying float vNet; varying float vVis; varying float vVel;
void main(){
  float r=aDiam*0.5; float centerY=aBottom+r;
  float waterY=aBottom+clamp(aFill,0.0,1.0)*aDiam;
  float dy=waterY-centerY; float halfW=sqrt(max(0.0,r*r-dy*dy))*0.70;   // narrow — a hint of surface, not a highway
  vec3 wp=vec3(position.x + aPerp.x*aSide*halfW, waterY, position.z + aPerp.z*aSide*halfW);
  vU=aU; vFill=aFill; vW=wp; vNet=aNet; vVel=aVel;
  vVis=uTierVis[int(aTier+0.5)];
  gl_Position=projectionMatrix*modelViewMatrix*vec4(wp,1.0);
}`;
const SURF_FRAG=`
precision highp float;
uniform float uTime;
varying float vU; varying float vFill; varying vec3 vW; varying float vNet; varying float vVis; varying float vVel;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.1+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
  if(vFill<0.12) discard;                                  // no surface until there is real water
  if(vVis<0.5) discard;                                    // tier toggled off in the legend
  vec2 uv=vec2(vU*0.06 - uTime*(0.15+vVel*0.30), (vW.x+vW.z)*0.12);   // ripples race at the SOLVED velocity
  float e=0.06;
  float hx=fbm(uv+vec2(e,0.))-fbm(uv-vec2(e,0.));
  float hz=fbm(uv+vec2(0.,e))-fbm(uv-vec2(0.,e));
  vec3 N=normalize(vec3(-hx*2.2,1.0,-hz*2.2));
  vec3 L=normalize(vec3(0.4,0.9,0.35));
  float glint=pow(max(dot(N,L),0.0),50.0);
  float sky=clamp(N.y,0.0,1.0);
  vec3 baseLo=mix(vec3(0.28,0.55,0.74), vec3(0.40,0.36,0.18), vNet);   // sewer surface = murky olive
  vec3 baseHi=mix(vec3(0.55,0.78,0.90), vec3(0.58,0.54,0.32), vNet);
  vec3 base=mix(baseLo, baseHi, sky);
  float gl2=glint*mix(0.7,0.35,vNet);                      // sewage glints less than clear water
  vec3 col=base + mix(vec3(0.85,0.95,1.0), vec3(0.80,0.76,0.58), vNet)*gl2;
  // AT CAPACITY: the exposed surface flashes hot as the section surcharges
  float presur=smoothstep(0.90,0.99,clamp(vFill,0.0,1.0));
  col=mix(col, vec3(0.96,0.36,0.20), presur*(0.5+0.15*sin(uTime*5.0)));
  gl_FragColor=vec4(col, 0.48+0.22*presur);               // translucent — the tube water carries the read
}`;
// Low-poly PIPE CASING (the Sketchfab pipe-pack look): faceted solid shell in
// the tier colour. The bottom half is opaque — water visibly sits IN a pipe —
// while the top half stays glassy so the level, caustics and packets read
// through it. Facets come free from screen-space derivatives (flat normal per
// triangle); the top/bottom rule uses the tube's own smooth normal.
const CASE_VERT=`
attribute float aTier;
attribute float aFill;     // live section fill — waterline through the shell + utilization ramp
attribute float aNet;      // 0 storm / 1 sewer — water tint through the shell
attribute float aBottom; attribute float aDiam;
uniform float uTierVis[6];
uniform vec3  uTierCol[6];
varying vec3 vN; varying vec3 vP; varying vec3 vWall; varying float vVis; varying float vFill;
varying float vNet; varying float vBot; varying float vDia;
void main(){
  vN=normal; vP=position; vFill=aFill; vNet=aNet; vBot=aBottom; vDia=aDiam;
  int t=int(aTier+0.5);
  vVis=uTierVis[t]; vWall=uTierCol[t];
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}`;
const CASE_FRAG=`
precision highp float;
uniform float uUtilMode;   // 0 = water view casing, 1 = capacity-utilization choropleth
uniform float uTime;
varying vec3 vN; varying vec3 vP; varying vec3 vWall; varying float vVis; varying float vFill;
varying float vNet; varying float vBot; varying float vDia;
void main(){
  if(vVis<0.5) discard;
  vec3 fn=normalize(cross(dFdx(vP),dFdy(vP)));             // flat facet normal → low-poly shading
  float diff=max(dot(fn,normalize(vec3(0.35,0.85,0.40))),0.0);
  if(uUtilMode>0.5){
    // CAPACITY VIEW: solid pipe painted by current demand/capacity —
    // green <50%, amber 50–75%, orange 75–90%, red ≥90% (surcharged, pulsing)
    float f=clamp(vFill,0.0,1.0);
    vec3 c = f<0.50 ? mix(vec3(0.13,0.55,0.28),vec3(0.42,0.66,0.20),f/0.50)
           : f<0.75 ? mix(vec3(0.42,0.66,0.20),vec3(0.92,0.72,0.20),(f-0.50)/0.25)
           : f<0.90 ? mix(vec3(0.92,0.72,0.20),vec3(0.90,0.42,0.12),(f-0.75)/0.15)
                    : vec3(0.86,0.16,0.10)*(0.85+0.15*sin(uTime*5.0));
    gl_FragColor=vec4(c*(0.55+0.45*diff),0.94); return;
  }
  // WATER VIEW: the shell shows the water STANDING BEHIND it — the pipe visibly
  // "fills up" (blue for storm water, olive for sewage) from any angle, even
  // when the level is below the opaque half. The dry shell stays neutral.
  float waterY=vBot+clamp(vFill,0.0,1.0)*vDia;
  float wet=1.0-smoothstep(waterY-0.05*vDia, waterY+0.05*vDia, vP.y);
  vec3 waterCol=mix(vec3(0.16,0.52,0.82), vec3(0.42,0.36,0.14), vNet);
  float bottom=smoothstep(0.20,-0.45,vN.y);                // 1 under the springline, 0 on the crown
  vec3 shell=vWall*(0.35+0.55*diff)+vec3(0.06);
  vec3 glass=mix(vec3(0.72,0.78,0.84),vWall,0.45)*(0.5+0.4*diff);
  vec3 col=mix(glass,shell,bottom);
  col=mix(col, waterCol*(0.55+0.45*diff), wet*0.80);       // water level read through the wall
  float alpha=mix(0.13,0.88,max(bottom,wet*0.9));
  // surcharge stays alarming in the water view too
  float presur=smoothstep(0.92,1.0,vFill);
  col=mix(col, vec3(0.90,0.30,0.16), presur*(0.35+0.15*sin(uTime*5.0)));
  gl_FragColor=vec4(col,alpha);
}`;
let drainCaseMat=null;
function getDrainCasingMat(){
  if(!drainCaseMat){
    drainCaseMat=new THREE.ShaderMaterial({
      uniforms:{ uTierVis:{value:drainTierVis.slice()}, uTierCol:{value:DRAIN_TIERS.map(t=>new THREE.Color(t.color))},
        uUtilMode:{value:0}, uTime:{value:0} },
      vertexShader:CASE_VERT, fragmentShader:CASE_FRAG,
      transparent:true, depthWrite:false, side:THREE.DoubleSide,
      extensions:{derivatives:true}
    });
  }
  return drainCaseMat;
}
function getDrainSurfMat(){
  if(!drainSurfMat){
    drainSurfMat=new THREE.ShaderMaterial({
      uniforms:{ uTime:{value:0}, uTierVis:{value:drainTierVis.slice()} },
      vertexShader:SURF_VERT, fragmentShader:SURF_FRAG,
      transparent:true, depthWrite:false, side:THREE.DoubleSide
    });
  }
  return drainSurfMat;
}

// Manhole water-column shader: caustic shimmer on the rising column + a bright
// water surface at the top — same flood-water look as the pipes.
const MHW_VERT=`
varying vec2 vUv; varying float vTop;
void main(){ vUv=uv; vTop=position.y;   // cylinder local y: -0.5 bottom … +0.5 top (surface)
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const MHW_FRAG=`
precision highp float;
uniform float uTime; varying vec2 vUv; varying float vTop;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.1+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
  vec2 uvc=vec2(vUv.x*4.0, vUv.y*5.0); float t=uTime*0.09;
  float nA=fbm(uvc+vec2(t,t*0.6)); float nB=fbm(uvc*1.5+vec2(-t*0.7,t));
  float caustic=pow(clamp(1.0-abs(nA-nB),0.0,1.0),3.0);
  float surf=smoothstep(0.42,0.5,vTop);                     // soft water surface at the top of the column
  vec3 col=vec3(0.30,0.55,0.74)+vec3(0.45,0.65,0.78)*caustic*0.16+vec3(0.78,0.90,0.97)*surf*0.30;
  gl_FragColor=vec4(col, 0.80);                             // translucent
}`;
function getManholeWaterMat(){
  if(!mhWaterMat){
    mhWaterMat=new THREE.ShaderMaterial({
      uniforms:{ uTime:{value:0} }, vertexShader:MHW_VERT, fragmentShader:MHW_FRAG,
      transparent:true, depthWrite:false
    });
  }
  return mhWaterMat;
}
// Overflow ripple: concentric rings expanding outward from a surcharging manhole,
// flood-blue, merging with the street flood. (CircleGeometry uv centred at 0.5.)
const RIPPLE_VERT=`varying vec2 vUv; void main(){ vUv=uv;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const RIPPLE_FRAG=`
precision highp float;
uniform float uTime; varying vec2 vUv;
void main(){
  vec2 p=vUv-0.5; float r=length(p)*2.0;
  if(r>1.0) discard;
  float rings=0.5+0.5*sin(r*15.0 - uTime*4.5);          // outward-travelling rings
  float ring=pow(rings,3.0);
  float fade=smoothstep(1.0,0.12,r)*smoothstep(0.04,0.14,r);   // soft outer fade + small centre hole
  vec3 col=mix(vec3(0.29,0.58,0.78), vec3(0.82,0.94,1.0), ring);  // flood-blue → white crest
  gl_FragColor=vec4(col, ring*fade*0.75);
}`;
function getOverflowRippleMat(){
  if(!overflowRippleMat){
    overflowRippleMat=new THREE.ShaderMaterial({
      uniforms:{ uTime:{value:0} }, vertexShader:RIPPLE_VERT, fragmentShader:RIPPLE_FRAG,
      transparent:true, depthWrite:false, side:THREE.DoubleSide
    });
  }
  return overflowRippleMat;
}

// Build one merged tube mesh for the whole network (single draw call). Each
// conduit spans its invert→crown depth, and we record its vertex range so the
// timeline can recolour it by fill. Lazy — first enable only.
async function buildDrainageNetwork(){
  if(drainLoaded||!scene||!window.THREE||!modelTransform)return;
  drainLoaded=true;
  try{
    if(!drainLight){                                   // shade tubes; water shader ignores scene lights
      drainLight=new THREE.DirectionalLight(0xffffff,0.85);
      drainLight.position.set(0.4,1.0,0.3);
      scene.add(drainLight);
      scene.add(new THREE.AmbientLight(0x9fb2c4,0.45)); // soft fill so Lambert collars aren't pitch-black
    }
    // REAL-DATA ONLY. Everything synthetic/derived (the old SWMM link_dynamics,
    // catchments, recharge candidates, inferred pump-discharge routing, inlet
    // drop-pipe snapping, the MCG util_pk proxy chains) has been removed. We load
    // the coupled 1D-2D run's own network + a small set of REAL point assets.
    const [pumpsGeo,outfallsGeo,inletsGeo]=await Promise.all([
      fetch('/drainage/pumps.geojson').then(r=>r.ok?r.json():null).catch(()=>null),
      fetch('/drainage/outfalls.geojson').then(r=>r.ok?r.json():null).catch(()=>null),
      fetch('/drainage/inlets_rim.geojson').then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    useSimNetwork=await buildSimNetwork();
    if(useSimNetwork){
      if(pumpsGeo)addPumpsLayer(pumpsGeo);             // real GMDA/MCG pumps
      if(outfallsGeo)addOutfallsLayer(outfallsGeo);    // real outfall inventory
      if(inletsGeo){
        connectInletsToNetwork(inletsGeo);             // MCG inlets → run nodes (drop + lateral)
        addInletsLayer(inletsGeo);                     // the gully grates themselves
      }
      renderDrainLegend();
      if(glMap)glMap.triggerRepaint();
      return;
    }
    // ── legacy fallback (only if the sim run is unavailable) ──
    const [net,sewer,trunk,man,inlets]=await Promise.all([
      fetch('/drainage/storm_network.geojson').then(r=>r.json()).catch(()=>({features:[]})),
      fetch('/drainage/sewer_network.geojson').then(r=>r.json()).catch(()=>({features:[]})),
      fetch('/drainage/trunk_legs.geojson').then(r=>r.json()).catch(()=>({features:[]})),
      fetch('/drainage/manholes_progression.geojson').then(r=>r.json()).catch(()=>({features:[]})),
      fetch('/drainage/inlets_rim.geojson').then(r=>r.json()).catch(()=>({features:[]})),
    ]);
    await getEventHydro();
    addDrainFlow(net,trunk,inlets);   // laterals (inlet→main) + flowing dashes into the STORM network only
    // All conduits sit BELOW ground (y<0); manholes will rise to the rim at y=0.
    const pos=[],nrm=[],uvs=[],aLen=[],aFill=[],aBot=[],aDia=[],aFrnt=[],aNetA=[],aTierA=[],aVelA=[],idx=[];let vbase=0;
    const ringPos=[],ringNrm=[];   // low-poly collar rings at joints (trunk/mains/channels)
    const ringProto=new THREE.CylinderGeometry(1,1,1,8,1,false).toNonIndexed();
    ringProto.computeVertexNormals();                        // per-face normals → faceted low-poly look
    const sPos=[],sPerp=[],sSide=[],sBot=[],sDia=[],sFill=[],sU=[],sNet=[],sTier=[],sVel=[],sIdx=[];let svbase=0;   // water-surface ribbon
    let mnX=Infinity,mxX=-Infinity,mnZ=Infinity,mxZ=-Infinity;
    drainTierStats=DRAIN_TIERS.map(()=>({count:0,km:0}));
    // storm (+trunk legs) render at full radial detail; the sewer network is ~5×
    // bigger, so its tubes use a coarser ring to keep the merged mesh tractable.
    const groups=[
      {feats:[...(net.features||[]),...(trunk.features||[])], netF:0, radial:8},
      {feats:(sewer.features||[]),                            netF:1, radial:6},
    ];
    for(const grp of groups)for(const ft of grp.feats){
      const p=ft.properties||{};
      const tier=drainTierFor(p,grp.netF);
      let lenM=p.len_m;
      if(!lenM){                        // legacy files (trunk legs) carry no length — measure the line
        lenM=0;
        for(const part of drainLineParts(ft.geometry))for(let i=1;i<part.length;i++){
          const dx=(part[i][0]-part[i-1][0])*111320*Math.cos(part[i][1]*Math.PI/180);
          const dy=(part[i][1]-part[i-1][1])*110540;
          lenM+=Math.hypot(dx,dy);
        }
      }
      drainTierStats[tier].count++; drainTierStats[tier].km+=lenM/1000;
      // RADIUS reflects the REAL cross-section (sec_h) — decoupled from the vertical depth
      // exaggeration — so a 0.4 m pipe reads smaller than a 1.5 m trunk (proportional, not floored flat).
      const secH=(p.sec_h_m??0.6);
      const radius=Math.min(DRAIN_RADIUS_MAX,Math.max(DRAIN_RADIUS_MIN, secH*0.5*PIPE_RADIUS_SCALE));
      const crownY=(p.depth_crown_m??-1.05)*PERF_VEXAG;      // crown depth (exaggerated for readability)
      const diam=2*radius;
      // SLOPE-TRUE geometry: the pipe follows its real invert profile instead of
      // hanging flat. inv_u_m/inv_d_m are absolute bed elevations from the source
      // data; we tilt around the chain's MEAN invert so the average cover still
      // matches depth_crown_m, and clamp the deviation so a long steep trunk
      // can't dive off-screen at PERF_VEXAG exaggeration.
      const invU=Number(p.inv_u_m), invD=Number(p.inv_d_m);
      const hasInv=Number.isFinite(invU)&&Number.isFinite(invD);
      const invMid=hasInv?(invU+invD)/2:0;
      const midYAt=(t)=>{
        let dev=hasInv?((invU+(invD-invU)*t)-invMid)*PERF_VEXAG:0;
        dev=Math.max(-SLOPE_DEV_MAX,Math.min(SLOPE_DEV_MAX,dev));
        return Math.min(-radius, crownY-radius+dev);
      };
      for(const part of drainLineParts(ft.geometry)){
        // pass 1: planar points; pass 2: cumulative length → per-point sloped Y
        const raw=[];let prev=null,sumLng=0,sumLat=0,n=0;
        for(const c of part){
          const {x,z}=toLocal(c[0],c[1]);
          if(prev&&Math.abs(x-prev.x)<1e-6&&Math.abs(z-prev.z)<1e-6)continue;  // drop dup pts (CatmullRom NaN)
          prev={x,z};raw.push({x,z});sumLng+=c[0];sumLat+=c[1];n++;
          if(x<mnX)mnX=x;if(x>mxX)mxX=x;if(z<mnZ)mnZ=z;if(z>mxZ)mxZ=z;
        }
        if(raw.length<2)continue;
        const cum=[0];
        for(let i=1;i<raw.length;i++)cum.push(cum[i-1]+Math.hypot(raw[i].x-raw[i-1].x,raw[i].z-raw[i-1].z));
        const total=cum[cum.length-1]||1;
        const pts=raw.map((r,i)=>new THREE.Vector3(r.x,midYAt(cum[i]/total),r.z));
        const curve=new THREE.CatmullRomCurve3(pts);
        const len=Math.max(curve.getLength(),1);
        const tube=new THREE.TubeGeometry(curve,Math.max(1,(pts.length-1)*2),radius,grp.radial,false);
        const tp=tube.attributes.position.array,tn=tube.attributes.normal.array,tu=tube.attributes.uv.array,ti=tube.index.array;
        const vStart=vbase, vCount=tp.length/3;
        for(let i=0;i<tp.length;i+=3){pos.push(tp[i],tp[i+1],tp[i+2]);nrm.push(tn[i],tn[i+1],tn[i+2]);}
        // aBottom must now follow the SLOPED invert: TubeGeometry lays out
        // (tubularSegments+1) rings × (radialSegments+1) verts in order, so the
        // ring index gives t along the pipe.
        const tubSeg=Math.max(1,(pts.length-1)*2), ringN=grp.radial+1;
        for(let i=0,vi=0;i<tu.length;i+=2,vi++){
          const t=Math.min(1,Math.floor(vi/ringN)/tubSeg);
          uvs.push(tu[i],tu[i+1]);aLen.push(len);aFill.push(0);
          aBot.push(midYAt(t)-radius);aDia.push(diam);
          aFrnt.push(0);aNetA.push(grp.netF);aTierA.push(tier);aVelA.push(0);
        }
        for(let i=0;i<ti.length;i++)idx.push(ti[i]+vbase);
        vbase+=vCount; tube.dispose();
        // ── flat water-surface ribbon along this pipe (correct chord width via shader) ──
        const sStart=svbase; const uArr=[0];
        for(let i=1;i<pts.length;i++)uArr.push(uArr[i-1]+Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
        for(let i=0;i<pts.length-1;i++){
          const p0=pts[i],p1=pts[i+1], dx=p1.x-p0.x,dz=p1.z-p0.z, L2=Math.hypot(dx,dz);
          if(L2<1e-4)continue;
          const px=dz/L2, pz=-dx/L2, base=svbase;
          // ribbon invert follows the sloped pipe too (P.y is the sloped centre)
          const addv=(P,side,u)=>{sPos.push(P.x,0,P.z);sPerp.push(px,0,pz);sSide.push(side);sBot.push(P.y-radius);sDia.push(diam);sFill.push(0);sU.push(u);sNet.push(grp.netF);sTier.push(tier);sVel.push(0);svbase++;};
          addv(p0,1,uArr[i]); addv(p0,-1,uArr[i]); addv(p1,1,uArr[i+1]); addv(p1,-1,uArr[i+1]);
          sIdx.push(base,base+1,base+2, base+1,base+3,base+2);
        }
        // COLLAR RINGS at part ends (the low-poly-pipe-pack signature): a wider,
        // faceted band at each joint on the visually dominant tiers.
        if(tier===0||tier===1||tier===3){
          const mkRing=(P,Q)=>{                              // collar at P, axis toward Q
            const dir=new THREE.Vector3(Q.x-P.x,0,Q.z-P.z);
            if(dir.lengthSq()<1e-6)return;
            dir.normalize();
            const m=new THREE.Matrix4().compose(
              new THREE.Vector3(P.x,P.y,P.z),          // sit on the sloped pipe centre
              new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),dir),
              new THREE.Vector3(radius*1.16,Math.max(radius*0.55,1.0),radius*1.16));
            const g=ringProto.clone();g.applyMatrix4(m);
            const gp=g.attributes.position.array,gn=g.attributes.normal.array;
            for(let i=0;i<gp.length;i+=3){ringPos.push(gp[i],gp[i+1],gp[i+2]);ringNrm.push(gn[i],gn[i+1],gn[i+2]);}
            g.dispose();
          };
          mkRing(pts[0],pts[1]); mkRing(pts[pts.length-1],pts[pts.length-2]);
        }
        // propagation hydraulics from the extract (Manning velocity, wave arrival,
        // calibrated peak utilisation); legacy trunk-leg features get defaults —
        // trunks are the collectors and historically ran surcharged at peak.
        drainConduits.push({vStart,vCount,sStart,sCount:svbase-sStart,net:grp.netF,tier,
          cLng:sumLng/n,cLat:sumLat/n,len,aid:p.asset_id||null,
          v:Number(p.v_ms)||1.2, tArr:Number(p.t_arr_min)||0,
          util:Number(p.util_pk)||(tier===0?0.95:0.55),
          frontD:0,fillD:0,frontT:0,fillT:0,velD:0,velT:0});
      }
    }
    if(sPos.length){
      const sg=new THREE.BufferGeometry();
      sg.setAttribute('position',new THREE.Float32BufferAttribute(sPos,3));
      sg.setAttribute('aPerp',new THREE.Float32BufferAttribute(sPerp,3));
      sg.setAttribute('aSide',new THREE.Float32BufferAttribute(sSide,1));
      sg.setAttribute('aBottom',new THREE.Float32BufferAttribute(sBot,1));
      sg.setAttribute('aDiam',new THREE.Float32BufferAttribute(sDia,1));
      drainSurfAFill=new THREE.Float32BufferAttribute(sFill,1);
      sg.setAttribute('aFill',drainSurfAFill);
      sg.setAttribute('aU',new THREE.Float32BufferAttribute(sU,1));
      sg.setAttribute('aNet',new THREE.Float32BufferAttribute(sNet,1));
      sg.setAttribute('aTier',new THREE.Float32BufferAttribute(sTier,1));
      drainSurfAVel=new THREE.Float32BufferAttribute(sVel,1);
      sg.setAttribute('aVel',drainSurfAVel);
      sg.setIndex(new THREE.Uint32BufferAttribute(sIdx,1));
      const sm=new THREE.Mesh(sg,getDrainSurfMat());
      sm.frustumCulled=false;sm.visible=drainEnabled;sm.renderOrder=3;
      scene.add(sm);drainMeshes.push(sm);drainSurfMesh=sm;
    }
    if(pos.length){
      const geo=new THREE.BufferGeometry();
      geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
      geo.setAttribute('normal',new THREE.Float32BufferAttribute(nrm,3));
      geo.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
      geo.setAttribute('aLen',new THREE.Float32BufferAttribute(aLen,1));
      geo.setAttribute('aBottom',new THREE.Float32BufferAttribute(aBot,1));
      geo.setAttribute('aDiam',new THREE.Float32BufferAttribute(aDia,1));
      drainAFill=new THREE.Float32BufferAttribute(aFill,1);
      geo.setAttribute('aFill',drainAFill);
      drainAFront=new THREE.Float32BufferAttribute(aFrnt,1);
      geo.setAttribute('aFront',drainAFront);
      geo.setAttribute('aNet',new THREE.Float32BufferAttribute(aNetA,1));
      geo.setAttribute('aTier',new THREE.Float32BufferAttribute(aTierA,1));
      drainAVel=new THREE.Float32BufferAttribute(aVelA,1);
      geo.setAttribute('aVel',drainAVel);
      geo.setIndex(new THREE.Uint32BufferAttribute(idx,1));
      // solid low-poly casing first (renderOrder 1), then the water inside it (2)
      const casing=new THREE.Mesh(geo,getDrainCasingMat());   // shares the tube geometry
      casing.frustumCulled=false;casing.visible=drainEnabled;casing.renderOrder=1;
      scene.add(casing);drainMeshes.push(casing);
      const mesh=new THREE.Mesh(geo,getDrainFlowMat());
      mesh.frustumCulled=false;mesh.visible=drainEnabled;mesh.renderOrder=2;
      scene.add(mesh);drainMeshes.push(mesh);drainWaterMesh=mesh;
      if(ringPos.length){                                     // collar rings at joints
        const rg=new THREE.BufferGeometry();
        rg.setAttribute('position',new THREE.Float32BufferAttribute(ringPos,3));
        rg.setAttribute('normal',new THREE.Float32BufferAttribute(ringNrm,3));
        const rm=new THREE.Mesh(rg,new THREE.MeshLambertMaterial({color:0x59646f}));
        rm.frustumCulled=false;rm.visible=drainEnabled;rm.renderOrder=1;
        scene.add(rm);drainMeshes.push(rm);drainRingMesh=rm;
      }
      // (the x-ray dim is a full-viewport basemap layer — see updateBasemapDim —
      // NOT an in-scene quad: a bbox-sized dark sheet reads as a giant floating
      // diamond over the city at low zoom)
    }
    // (outfalls are drawn as a proper clickable map layer via the performance overlay, not 3D cones)
    renderDrainLegend();               // structured component hierarchy w/ live counts
    addDrainPick(net,sewer,trunk);     // click-to-identify any pipe
    setEngineeringView(drainEngMode);  // capacity choropleth is the default skin
    updateDrainFill(currentStep);
    if(glMap)glMap.triggerRepaint();
  }catch(err){
    console.warn('drainage build failed',err);drainLoaded=false;   // allow retry
    throw err;
  }
}
// Set each conduit's fill at this step: global network-storage fraction, gated
// by local onset (nearest manhole) so the network lights up where backflow
// began. Drives the flow shader (vFill) — bright water packets travel only
// through pipes that carry water. (Screening fill from real onset + storage;
// true per-pipe link flow awaits the geometry rebuild.)
// Set each conduit's TARGET front + level for this step; the render loop eases the
// displayed values toward them so the water front visibly travels and the level
// rises smoothly (the data is only hourly).
// Physically-driven propagation. Per conduit, from the extract's graph pass:
//   FRONT (where water has reached): a wetting wave leaves the network heads at
//     rain start, arrives at this pipe t_arr_min later (min Σ L/v upstream), and
//     traverses it at its own Manning full-flow velocity v_ms. A small
//     rain-ingestion trickle wets storm pipes locally once rain is falling.
//   LEVEL (how full the section is): util_pk × storage-curve — util_pk is the
//     calibrated demand/capacity ratio, so an undersized reach hits 1.0 (red,
//     surcharged) at peak while an oversized trunk section never does.
function updateDrainFill(step){
  if(useSimNetwork){ updateSimHour(step); updateDrainPhase(step); updateCatchments(step); updatePerfMarkers(step); return; }
  if(!drainConduits.length)return;
  const em=step*60, frac=storageFracAt(step), t0=rainStartMin();
  const dynF=drainLinkDyn&&drainLinkDyn.fill, dynV=drainLinkDyn&&drainLinkDyn.vel;
  for(const cd of drainConduits){
    // SWMM-SOLVED level + velocity when the series exists for this conduit;
    // the wetting wave stays as the longitudinal front so water still visibly
    // travels INTO each pipe (the solver treats a conduit as one element).
    const sf=dynF&&cd.aid?dynF[cd.aid]:null;
    const dt=(em-t0)/WAVE_TIME_SCALE-cd.tArr;              // hydraulic min since the wave reached this pipe's head
    const wave=dt<=0?0:Math.min(1,(dt*60*cd.v)/Math.max(cd.len,1));
    if(sf){
      const i=Math.max(0,Math.min(step,sf.length-1));
      cd.fillT=sf[i]/100;
      cd.velT=(dynV&&dynV[cd.aid]?dynV[cd.aid][i]:0)/100;
      cd.frontT=cd.net===1?1:Math.max(wave, cd.fillT>0.02?0.12:0);
      // sewers are NEVER empty: dry-weather sewage flows at design d/D ≈ 0.3
      // around the clock; the storm only raises the level from there.
      if(cd.net===1)cd.fillT=Math.max(cd.fillT,SEWER_BASE_FILL);
    }else if(cd.net===1){
      // proxy fallback — sewers ride dry-weather flow, storm raises the level
      cd.frontT=1;
      cd.fillT=Math.min(1, SEWER_BASE_FILL + cd.util*frac*(1-SEWER_BASE_FILL));
      cd.velT=cd.v*(0.3+0.7*frac);
    }else{
      const local=(frac>0.04&&em>t0)?0.12:0;               // street inflow wets the pipe thinly everywhere
      cd.frontT=Math.max(wave,local);
      cd.fillT=Math.min(1, cd.util*frac);                  // level tracks utilisation, ebbs with the storm
      cd.velT=cd.v*frac;
    }
  }
  if(drainFlowMat)drainFlowMat.uniforms.uSpeed.value=14.0+34.0*frac;
  updateDrainPhase(step);                                  // causal-phase readout + outfall pulse
  updateCatchments(step);                                  // catchment inundation shading
  updatePerfMarkers(step);                                 // pump running-state (flood-depth driven)
  tickDrainFill(false);                                    // let the render loop ease front/level toward target
}
function tickDrainFill(snap){
  if(!drainAFill||!drainConduits.length)return;
  const k=snap?1:0.05, fillArr=drainAFill.array, frontArr=drainAFront.array;
  const velArr=drainAVel&&drainAVel.array;
  const sArr=drainSurfAFill&&drainSurfAFill.array;
  let changed=false;
  for(const cd of drainConduits){
    // ~41k conduits now — skip the (vast) majority that have already settled at
    // their target so the per-frame CPU walk + GPU re-upload stay cheap.
    if(!snap&&Math.abs(cd.frontT-cd.frontD)<0.002&&Math.abs(cd.fillT-cd.fillD)<0.002
      &&Math.abs((cd.velT||0)-(cd.velD||0))<0.01)continue;
    changed=true;
    cd.frontD+=(cd.frontT-cd.frontD)*k; cd.fillD+=(cd.fillT-cd.fillD)*k;
    cd.velD+=((cd.velT||0)-(cd.velD||0))*k;
    for(let v=cd.vStart;v<cd.vStart+cd.vCount;v++){fillArr[v]=cd.fillD;frontArr[v]=cd.frontD;if(velArr)velArr[v]=cd.velD;}
    const svArr=drainSurfAVel&&drainSurfAVel.array;
    if(sArr&&cd.sCount)for(let v=cd.sStart;v<cd.sStart+cd.sCount;v++){sArr[v]=cd.fillD*cd.frontD;if(svArr)svArr[v]=cd.velD;}   // surface only where water has arrived
  }
  if(!changed)return;
  drainAFill.needsUpdate=true; drainAFront.needsUpdate=true;
  if(drainAVel)drainAVel.needsUpdate=true;
  if(drainSurfAFill)drainSurfAFill.needsUpdate=true;
  if(drainSurfAVel)drainSurfAVel.needsUpdate=true;
}
// Fade the opaque basemap to a faint ground reference while the underground network
// is shown, so the bright pipes/manholes read as being BENEATH the surface (the map
// can't occlude them — no shared depth buffer — so we dim the ground instead).
// X-RAY MODE: the Three.js layer normally sits ~mid-stack, so the basemap's own
// buildings/roads/labels paint OVER the pipes and the network reads faint. While
// an underground overlay is on we keep the layer hoisted to the top of the stack
// — asserted idempotently on every styledata, because the style pipeline can
// restore the original order right after a one-shot moveLayer.
let xrayHooked=false;
function assertXray(){
  if(!map)return;
  const on=drainEnabled||perfEnabled;
  try{
    // World-covering FILL polygon (NOT a `background` layer — the Mappls
    // renderer ignores mid-stack backgrounds) → the whole viewport dims evenly
    // at any zoom, with no bbox-quad "diamond" over the city.
    if(!map.getLayer('xray-dim')){
      map.addSource('xray-dim-src',{type:'geojson',data:{type:'Feature',properties:{},
        geometry:{type:'Polygon',coordinates:[[[-179,-85],[179,-85],[179,85],[-179,85],[-179,-85]]]}}});
      map.addLayer({ id:'xray-dim', type:'fill', source:'xray-dim-src',
        paint:{ 'fill-color':'#0a1420', 'fill-opacity':0 } });
    }
    const ord=map.style&&map.style._order;
    if(!ord||ord.indexOf('water-surface')<0)return;
    if(on){
      // Dim the FLAT basemap only, not the 3D buildings: slot xray-dim just
      // BELOW the first BUILDING fill-extrusion, so roads/land/labels darken while
      // the extruded buildings render on top at full brightness. NB the Mappls
      // style has 'sea' fill-extrusions near the BOTTOM of the stack — skip those
      // or the dim ends up below the whole basemap and does nothing.
      let bld=null;
      for(const id of ord){ const l=map.getLayer(id);
        if(l&&l.type==='fill-extrusion'&&!/sea/i.test(id)){bld=id;break;} }
      try{ if(bld)map.moveLayer('xray-dim',bld); else map.moveLayer('xray-dim'); }catch(e){}
      if(ord[ord.length-1]!=='water-surface')map.moveLayer('water-surface');
    }
    else if(ord[ord.length-1]==='water-surface'&&map.getLayer('flooded-roads-fill'))
      map.moveLayer('water-surface','flooded-roads-fill');
    // clearly dark basemap so the 3D drainage reads as an x-ray beneath the
    // street — but slotted below the buildings (above) so THEY stay bright
    map.setPaintProperty('xray-dim','fill-opacity', on ? 0.6 : 0);
  }catch(e){ console.warn('x-ray layers:',e); }
}
function updateBasemapDim(){
  if(!map)return;
  if(!xrayHooked){ xrayHooked=true;
    map.on('styledata',()=>{ if(drainEnabled||perfEnabled)assertXray(); });
  }
  assertXray();
  setTimeout(assertXray,250);   // catch a style batch that lands right after the toggle
}
// Engineering view: the pipes become a capacity-utilization choropleth (solid
// green→red by live demand/capacity); the cinematic water/ripples get out of
// the way so authorities read utilization, surcharge and backflow at a glance.
function setEngineeringView(on){
  drainEngMode=on;
  // real-run pipes: the module owns both skins (same geometry, one uniform)
  if(simState.viz){ DrainageViz.setMode(on?'capacity':'water'); if(glMap)glMap.triggerRepaint(); return; }
  // legacy chain path
  if(drainCaseMat)drainCaseMat.uniforms.uUtilMode.value=on?1:0;
  if(drainWaterMesh)drainWaterMesh.visible=drainEnabled&&!on;
  if(drainSurfMesh)drainSurfMesh.visible=drainEnabled&&!on;
  if(map&&map.getLayer('drain-flow'))map.setLayoutProperty('drain-flow','visibility',(drainEnabled&&!on)?'visible':'none');
  if(glMap)glMap.triggerRepaint();
}
function setDrainageVisible(on){
  drainEnabled=on;
  drainMeshes.forEach(m=>{m.visible=on;});
  if(simState.viz)simState.viz.setVisible(on);              // water mesh follows the mode
  if(dropPipesMesh)dropPipesMesh.visible=on&&dropPipesOn;   // inlet→SWD connectors
  if(drainEngMode){ if(drainWaterMesh)drainWaterMesh.visible=false; if(drainSurfMesh)drainSurfMesh.visible=false; }
  ['drain-flow','drain-pick','catch-outlets','catch-outlets-t','inlets-grates',
   'pump-discharge','pump-discharge-arrow'].forEach(id=>{
    if(map&&map.getLayer(id))map.setLayoutProperty(id,'visibility',on?'visible':'none');
  });
  if(!on)setRechargeVisible(false);   // recharge is opt-in; always hide with the overlay
  ['pumps-circles','pumps-labels'].forEach(id=>{           // pumps belong to both overlays
    if(map&&map.getLayer(id))map.setLayoutProperty(id,'visibility',(on||perfEnabled)?'visible':'none');
  });
  if(drainEngMode&&map&&map.getLayer('drain-flow'))map.setLayoutProperty('drain-flow','visibility','none');
  updateBasemapDim();
  if(on)updateDrainFill(currentStep);
  applyDrainLayerToggles();     // per-layer choices survive the master toggle
  if(glMap)glMap.triggerRepaint();
}
function setDrainTierVisible(tier,on){
  drainTierVis[tier]=on?1:0;
  if(drainFlowMat)drainFlowMat.uniforms.uTierVis.value[tier]=drainTierVis[tier];
  if(drainSurfMat)drainSurfMat.uniforms.uTierVis.value[tier]=drainTierVis[tier];
  if(drainCaseMat)drainCaseMat.uniforms.uTierVis.value[tier]=drainTierVis[tier];
  if(map&&map.getLayer('drain-pick'))                       // keep click-picking in sync
    map.setFilter('drain-pick',['in',['get','_tier'],['literal',DRAIN_TIERS.map((t,i)=>i).filter(i=>drainTierVis[i])]]);
  if(glMap)glMap.triggerRepaint();
}
// ── Drainage layer toggles ───────────────────────────────────────────────────
// Every element in the drainage legend is independently show/hide-able, using
// the same tap-to-toggle model as the Critical Assets rows. A dense combined
// network is unreadable; letting a reader isolate (say) trunk mains + water is
// what makes it interpretable.
function _mapLayersVisible(ids,on){
  ids.forEach(id=>{ if(map&&map.getLayer(id))map.setLayoutProperty(id,'visibility',on?'visible':'none'); });
}
const DRAIN_LAYERS=[
  {key:'trunk',   label:'Trunk main pipe',        mk:'dl-line', c:'#f57d33',
   set:v=>DrainageViz.setTier&&DrainageViz.setTier(0,v)},
  {key:'main',    label:'Branch main pipe',       mk:'dl-line', c:'#298cdb',
   set:v=>DrainageViz.setTier&&DrainageViz.setTier(1,v)},
  {key:'lateral', label:'Lateral pipe',           mk:'dl-line', c:'#47bcd1',
   set:v=>DrainageViz.setTier&&DrainageViz.setTier(2,v)},
  {key:'water',   label:'Water inside pipes',     mk:'dl-bar',  c:'linear-gradient(90deg,#6bbef5,#0a4f9e)',
   set:v=>DrainageViz.setLayer&&DrainageViz.setLayer('water',v)},
  {key:'shafts',  label:'Manhole shafts',         mk:'dl-shaft',
   set:v=>DrainageViz.setLayer&&DrainageViz.setLayer('shafts',v)},
  {key:'surch',   label:'Surcharging nodes',      mk:'dl-dot',  c:'#ff5a3c',
   set:v=>{ if(simState.surchMesh)simState.surchMesh.visible=drainEnabled&&v; }},
  {key:'drops',   label:'Inlet connectors',       mk:'dl-line', c:'#7bd8ff',
   set:v=>{ dropPipesOn=v; setDropPipesVisible(v); }},
  {key:'flow',    label:'Flow direction dashes',  mk:'dl-line', c:'#4bb8ee',
   set:v=>_mapLayersVisible(['drain-flow'],v)},
  {key:'inlets',  label:'Side-entry pit / gully', mk:'dl-grate',
   set:v=>_mapLayersVisible(['inlets-grates'],v)},
  {key:'outfalls',label:'Outfall (discharge)',    mk:'dl-tri',  c:'#12b39a',
   set:v=>_mapLayersVisible(['outfalls-circles'],v)},
  {key:'pumps',   label:'Storm pump',             mk:'dl-sq',   c:'#34c759',
   set:v=>_mapLayersVisible(['pumps-circles','pumps-labels'],v)},
  {key:'soil',    label:'Ground cutaway',         mk:'dl-sq',   c:'#8a6b4a',
   set:v=>DrainageViz.setLayer&&DrainageViz.setLayer('soil',v)},
];
const drainLayerOn={};
DRAIN_LAYERS.forEach(l=>{ drainLayerOn[l.key]=true; });

// Re-assert every toggle. setDrainageVisible() rewrites layer visibility wholesale
// when the overlay is switched on, which would otherwise resurrect hidden layers.
function applyDrainLayerToggles(){
  if(!drainEnabled)return;
  DRAIN_LAYERS.forEach(l=>{ try{ l.set(drainLayerOn[l.key]); }catch(e){} });
}

function renderDrainLegend(){
  const host=document.getElementById('drainLayers');
  if(!host)return;
  const swatch=l=>l.mk==='dl-line'?`<span class="dl-mk dl-line" style="--c:${l.c}"></span>`
    :l.mk==='dl-bar'?`<span class="dl-mk dl-bar" style="background:${l.c}"></span>`
    :l.mk==='dl-tri'?`<span class="dl-mk dl-tri" style="border-bottom-color:${l.c}"></span>`
    :l.mk==='dl-dot'||l.mk==='dl-sq'?`<span class="dl-mk ${l.mk}" style="background:${l.c}"></span>`
    :`<span class="dl-mk ${l.mk}"></span>`;
  // Live per-tier conduit counts: trunk is only ~1k of 140k links, so isolating
  // it empties the screen. Showing the count up front makes that read as "few
  // trunk mains here" rather than "the toggle is broken".
  const tc=[0,0,0];
  if(simState.linkPeak&&simState.drawn&&window.DrainageViz&&DrainageViz.tierOf){
    for(const i of simState.drawn)tc[DrainageViz.tierOf(simState.linkPeak[i])]++;
  }
  const tierIdx={trunk:0,main:1,lateral:2};
  host.innerHTML=DRAIN_LAYERS.map(l=>{
    const ti=tierIdx[l.key];
    const badge=(ti!==undefined&&tc[ti])?`<span class="drain-layer-count">${tc[ti].toLocaleString()}</span>`:'';
    return `<div class="drain-layer-row${drainLayerOn[l.key]?'':' drain-layer-row--off'}" data-key="${l.key}">`+
      `${swatch(l)}<span class="drain-layer-label">${l.label}</span>${badge}</div>`;
  }).join('');
  host.onclick=e=>{
    const row=e.target.closest('.drain-layer-row'); if(!row)return;
    const l=DRAIN_LAYERS.find(x=>x.key===row.dataset.key); if(!l)return;
    drainLayerOn[l.key]=!drainLayerOn[l.key];
    row.classList.toggle('drain-layer-row--off',!drainLayerOn[l.key]);
    try{ l.set(drainLayerOn[l.key]); }catch(err){ console.warn('drain layer',l.key,err); }
    if(glMap)glMap.triggerRepaint();
  };
  const allBtn=document.getElementById('drainLayersAll');
  if(allBtn)allBtn.onclick=()=>{
    const anyOff=DRAIN_LAYERS.some(l=>!drainLayerOn[l.key]);
    DRAIN_LAYERS.forEach(l=>{ drainLayerOn[l.key]=anyOff; });
    renderDrainLegend(); applyDrainLayerToggles();
    if(glMap)glMap.triggerRepaint();
  };
}
// Invisible fat line layer over BOTH networks → any pipe is clickable, answering
// "what is this?" with the component name + engineering specs (like the labelled
// cutaway reference: Side Entry Pit / Lateral Pipe / Stormwater Main …).
function addDrainPick(net,sewer,trunk){
  if(drainPickAdded||!map)return; drainPickAdded=true;
  const feats=[];
  const push=(fc,netF)=>{for(const f of (fc&&fc.features||[])){
    const p=f.properties||{};
    feats.push({type:'Feature',geometry:f.geometry,properties:{
      _tier:drainTierFor(p,netF), net:netF?'sewer':'storm',
      sec_h:p.sec_h_m??null, sec_w:p.sec_w_m??null, depth:p.depth_crown_m??null,
      cap:p.cap_m3s??p.best_guess_capacity_m3s??null, slope:p.slope??null,
      op:p.op_frac??null, len:p.len_m??null, id:p.asset_id||p.trunk_name||'',
      util:p.util_pk??null, up:p.up_km??null, v:p.v_ms??null,
    }});
  }};
  push(net,0); push(sewer,1); push(trunk,0);
  map.addSource('drain-pick-src',{type:'geojson',data:{type:'FeatureCollection',features:feats}});
  map.addLayer({ id:'drain-pick', type:'line', source:'drain-pick-src', minzoom:13.5,
    layout:{ visibility:drainEnabled?'visible':'none','line-cap':'round' },
    paint:{ 'line-color':'#fff','line-opacity':0.01,'line-width':9 }});   // invisible, click-target only
  map.on('click','drain-pick',e=>{
    const p=e.features[0].properties, tier=DRAIN_TIERS[+p._tier]||DRAIN_TIERS[2];
    const cd=nearestAnyConduit(e.lngLat.lng,e.lngLat.lat);
    const util=cd?Math.round(Math.min(1,cd.fillD)*100):null;
    const size=(+p._tier===3)?`${(+p.sec_w||0).toFixed(1)} × ${(+p.sec_h||0).toFixed(1)} m box`:`Ø ${Math.round((+p.sec_h||0)*1000)} mm`;
    new maplibregl.Popup({offset:8}).setLngLat(e.lngLat)
      .setHTML(`<div class="dpop"><b style="color:${tier.hex}">▮</b> <b>${tier.label}</b>`
        +`<div>${p.net==='sewer'?'Sewerage':'Storm-water'} network · ${p.id||''}</div>`
        +`<div>${size} · crown ${Math.abs(+p.depth||0).toFixed(1)} m below ground</div>`
        +(p.cap?`<div>capacity <b>${(+p.cap).toFixed(2)} m³/s</b>${p.op?` · operating at ${Math.round(p.op*100)}% condition`:''}</div>`:'')
        +(p.v?`<div>flow velocity ${(+p.v).toFixed(1)} m/s${p.up?` · drains ${(+p.up).toFixed(1)} km of network`:''}</div>`:'')
        +(p.util?`<div>peak demand/capacity: <b style="color:${+p.util>=1?'#e64c30':(+p.util>=0.75?'#e6a23c':'#2f8fd6')}">${Math.round(+p.util*100)}%</b>${+p.util>=1?' — UNDERSIZED, surcharges at peak':''}</div>`:'')
        +(util!==null?`<div>fill now: <b style="color:${util>=90?'#e64c30':'#2f8fd6'}">${util}%</b>${util>=90?' — AT CAPACITY':''}</div>`:'')
        +`</div>`)
      .addTo(map);
  });
  map.on('mouseenter','drain-pick',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','drain-pick',()=>{map.getCanvas().style.cursor='';});
}
// ── REAL coupled 1D-2D simulation network ────────────────────────────────────
// Source: full_12h_run — fused CUDA full shallow-water + Horton infiltration,
// driven by the REPORTED july-2025 133 mm/12 h rainfall, with tailwater priors
// and surface recharge already in the physics. 118,768 nodes / 139,798 links,
// 13 hourly snapshots. Geometry is fetched once; each hour is a small quantised
// binary chunk (same pattern as coordinates.bin + chunks/*.bin).
//
// Endpoint Y comes from each node's own burial depth, so the network is
// slope-true by construction.
const SIM_VEXAG=8.0;               // exaggerate burial depth so ground→crown→invert reads in 3D
                                  // (pipes sit clearly BELOW the street; manhole shafts are tall)
// NO FLOW FILTER. Filtering links by peak flow (the old LOD) deleted the
// connective tissue between high-flow reaches and the network rendered as
// disconnected floating fragments. The whole point of a network view is that it
// is CONNECTED, so every one of the run's 139,798 links is drawn; the radial
// segment count is what's traded down instead (cost lives in SIM_RADIAL).
const SIM_MIN_PEAK_Q=0;            // 0 = draw every link (connectivity preserved)
const SIM_MAX_LINKS=Infinity;
const SIM_RADIAL=6;                // radial segments per pipe (round enough, cheap)
const SIM_R_MIN=0.9, SIM_R_MAX=4.2;// pipe radius range in scene metres
const simState={
  ready:false, loading:false, man:null,
  nodeLon:null,nodeLat:null,nodeInv:null,nodeMax:null,nodeArea:null,
  linkFrom:null,linkTo:null,
  mesh:null, viz:null, linkPeak:null, drawn:null,   // viz = DrainageViz module handle
  hour:-1, hourCache:new Map(),   // h → {depth:Uint16Array, sur:Uint8Array, flow:Int16Array}
  surchMesh:null, surchGeo:null,
  linkPeak:null, drawn:null,
  // ── 2D SWE flood surface (same run) ──
  floodMesh:null, floodMat:null, floodTex:null, floodGrid:null, floodHour:-1, floodCache:new Map(),
};
// The REAL 2D flood surface from the SAME run: each hour is a small rasterised
// depth grid (768², ~330 KB gz). Rendered on a plane over the run bbox with the
// SAME optimised water shader, so the 2D flood and the 1D drains are one event
// on one timeline.
async function fetchSimGrid(h){
  if(simState.floodCache.has(h))return simState.floodCache.get(h);
  const buf=await fetch(`${SIM_BASE}/surface_grid_${String(h).padStart(2,'0')}.bin`).then(r=>{
    if(!r.ok)throw new Error('grid '+h); return r.arrayBuffer();
  });
  const u16=new Uint16Array(buf);
  simState.floodCache.set(h,u16);
  if(simState.floodCache.size>6)simState.floodCache.delete(simState.floodCache.keys().next().value);
  return u16;
}
function buildSimFlood(){
  if(simState.floodMesh||!simState.man||!simState.man.grid_n)return;
  const N=simState.man.grid_n, bb=simState.man.grid_bbox;   // [lonMin,latMin,lonMax,latMax]
  // plane over the run bbox, uv 0..1 → the depth grid
  const seg=PLANE_SEG, n=(seg+1)*(seg+1);
  const pos=new Float32Array(n*3), uv=new Float32Array(n*2);
  let vi=0,ui=0;
  for(let j=0;j<=seg;j++)for(let i=0;i<=seg;i++){
    const lon=bb[0]+(i/seg)*(bb[2]-bb[0]), lat=bb[1]+(j/seg)*(bb[3]-bb[1]);
    const p=toLocal(lon,lat);
    pos[vi++]=p.x; pos[vi++]=0; pos[vi++]=p.z;
    uv[ui++]=i/seg; uv[ui++]=j/seg;
  }
  const idx=new Uint32Array(seg*seg*6); let k=0;
  for(let j=0;j<seg;j++)for(let i=0;i<seg;i++){
    const a=j*(seg+1)+i,b=a+1,c=a+(seg+1),d=c+1;
    idx[k++]=a;idx[k++]=c;idx[k++]=b; idx[k++]=b;idx[k++]=c;idx[k++]=d;
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  geo.setAttribute('uv',new THREE.BufferAttribute(uv,2));
  geo.setIndex(new THREE.BufferAttribute(idx,1));
  simState.floodGrid=new Float32Array(N*N);
  simState.floodTex=new THREE.DataTexture(simState.floodGrid,N,N,THREE.LuminanceFormat,THREE.FloatType);
  simState.floodTex.minFilter=THREE.LinearFilter; simState.floodTex.magFilter=THREE.LinearFilter;
  simState.floodTex.needsUpdate=true;
  simState.floodMat=new THREE.ShaderMaterial({
    uniforms:{ uTime:{value:animClock}, uOpacity:{value:floodOpacity}, uMaxDepth:{value:DEPTH_MAX},
      uDepthTex:{value:simState.floodTex}, uTexelSize:{value:new THREE.Vector2(1/N,1/N)},
      uWaveAmp:{value:0.18}, uDepthHeight:{value:0.45},
      uRipple0:{value:new THREE.Vector3(0,0,-1)}, uRipple1:{value:new THREE.Vector3(0,0,-1)},
      uRipple2:{value:new THREE.Vector3(0,0,-1)}, uRipple3:{value:new THREE.Vector3(0,0,-1)} },
    vertexShader:VERT_SRC, fragmentShader:FRAG_SRC,
    transparent:true, side:THREE.DoubleSide, depthWrite:false, extensions:{derivatives:true} });
  simState.floodMesh=new THREE.Mesh(geo,simState.floodMat);
  simState.floodMesh.frustumCulled=false; simState.floodMesh.renderOrder=0;
  scene.add(simState.floodMesh);
}
async function updateSimFloodHour(step){
  if(!simState.floodMesh)return;
  const man=simState.man, h=Math.max(0,Math.min(step,man.n_hours-1));
  let u16; try{ u16=await fetchSimGrid(h); }catch(e){ return; }
  const g=simState.floodGrid, ds=man.depth_scale||1000;
  let mx=0;
  for(let i=0;i<g.length;i++){ const v=u16[i]/ds; g[i]=v; if(v>mx)mx=v; }   // mm → m
  if(mx>depthScaleObserved){ depthScaleObserved=mx; recomputeDepthScale(); }
  simState.floodTex.needsUpdate=true;
  simState.floodHour=h;
  // prefetch next hour
  if(h+1<man.n_hours)fetchSimGrid(h+1).catch(()=>{});
  if(glMap)glMap.triggerRepaint();
}
// O(1) depth-at-point from the SWE grid — replaces the polygon scan so popups,
// pumps and asset queries read the SAME run as the flood + drains.
function simDepthAt(lng,lat){
  if(!simState.floodGrid||!simState.man||!simState.man.grid_bbox)return null;
  const N=simState.man.grid_n, bb=simState.man.grid_bbox;
  if(lng<bb[0]||lng>bb[2]||lat<bb[1]||lat>bb[3])return 0;
  const x=Math.min(N-1,Math.max(0,Math.round((lng-bb[0])/(bb[2]-bb[0])*(N-1))));
  const y=Math.min(N-1,Math.max(0,Math.round((lat-bb[1])/(bb[3]-bb[1])*(N-1))));
  return simState.floodGrid[y*N+x];
}
let dropPipesOn=true;    // inlet→SWD connectors are shown with the network
async function fetchSimHour(h){
  if(simState.hourCache.has(h))return simState.hourCache.get(h);
  const man=simState.man; if(!man)return null;
  const nn=man.n_nodes, nl=man.n_links, maskB=(nn+7)>>3;
  const buf=await fetch(`${SIM_BASE}/drain_dyn_${String(h).padStart(2,'0')}.bin`).then(r=>{
    if(!r.ok)throw new Error('sim hour '+h); return r.arrayBuffer();
  });
  const rec={
    depth:new Uint16Array(buf,0,nn),                       // mm
    sur:new Uint8Array(buf,nn*2,maskB),                    // surcharge bitmask
    flow:new Int16Array(buf,nn*2+maskB,nl),                // m³/s × flow_scale
  };
  simState.hourCache.set(h,rec);
  if(simState.hourCache.size>6)simState.hourCache.delete(simState.hourCache.keys().next().value);
  return rec;
}
async function buildSimNetwork(){
  if(simState.ready||simState.loading)return simState.ready;
  simState.loading=true;
  try{
    const man=await fetch(`${SIM_BASE}/manifest.json`).then(r=>r.ok?r.json():null);
    if(!man)throw new Error('no sim manifest');
    simState.man=man;
    applyDatasetTimeline(man);
    const nn=man.n_nodes, nl=man.n_links;
    // Geometry is shared by both datasets and never changes — always from /sim.
    const [geo,stat,lstat]=await Promise.all([
      fetch('/sim/drain_geom.bin').then(r=>r.arrayBuffer()),
      fetch('/sim/drain_node_static.bin').then(r=>r.arrayBuffer()),
      fetch('/sim/drain_link_static.bin').then(r=>r.arrayBuffer()),
    ]);
    simState.linkPeak=new Float32Array(lstat);        // peak |flow| per link (LOD ranking)
    const ll=new Float32Array(geo,0,nn*2);                 // node lon/lat pairs
    const li=new Uint32Array(geo,nn*8,nl*2);               // link from/to pairs
    const st=new Float32Array(stat);                       // invert, maxdepth, area ×nn
    simState.nodeLon=new Float32Array(nn); simState.nodeLat=new Float32Array(nn);
    simState.nodeInv=new Float32Array(nn); simState.nodeMax=new Float32Array(nn);
    simState.nodeArea=new Float32Array(nn);
    for(let i=0;i<nn;i++){
      simState.nodeLon[i]=ll[i*2]; simState.nodeLat[i]=ll[i*2+1];
      simState.nodeInv[i]=st[i*3]; simState.nodeMax[i]=st[i*3+1]; simState.nodeArea[i]=st[i*3+2];
    }
    simState.linkFrom=new Uint32Array(nl); simState.linkTo=new Uint32Array(nl);
    for(let i=0;i<nl;i++){simState.linkFrom[i]=li[i*2];simState.linkTo[i]=li[i*2+1];}
    // ── node world positions; Y = that node's own burial depth (slope-true) ──
    const nx=new Float32Array(nn), nz=new Float32Array(nn), ny=new Float32Array(nn);
    for(let i=0;i<nn;i++){
      const p=toLocal(simState.nodeLon[i],simState.nodeLat[i]);
      nx[i]=p.x; nz[i]=p.z;
      ny[i]=-Math.min(Math.max(simState.nodeMax[i],0.3),12)*SIM_VEXAG;
    }
    // ── LOD: keep the hydraulic skeleton (peak flow ≥ threshold), capped ──
    const peak=simState.linkPeak;
    let keep=[];
    for(let i=0;i<nl;i++)if(peak[i]>=SIM_MIN_PEAK_Q)keep.push(i);
    if(keep.length>SIM_MAX_LINKS){
      keep.sort((a,b)=>peak[b]-peak[a]);
      keep=keep.slice(0,SIM_MAX_LINKS);
    }
    simState.drawn=keep;
    // ── rich pipe visuals live in the DrainageViz MODULE (drainage_viz.js) ──
    // It builds the tube geometry + the casing/water/caustic/flow shader from the
    // same real data; app.js just hands it the arrays and drives it per hour.
    if(!window.DrainageViz){ console.warn('DrainageViz module missing'); return false; }
    simState.viz=DrainageViz.build({
      THREE, scene, toLocal, VEXAG:SIM_VEXAG,
      repaint:()=>{ if(glMap)glMap.triggerRepaint(); },
    },{
      nodeLon:simState.nodeLon, nodeLat:simState.nodeLat, nodeMax:simState.nodeMax,
      linkFrom:simState.linkFrom, linkTo:simState.linkTo, linkPeak:peak, keep,
    });
    simState.viz.setVisible(drainEnabled);
    for(const m of simState.viz.meshes)drainMeshes.push(m);
    if(drainEngMode)DrainageViz.setMode('capacity');
    console.log(`sim pipes: ${keep.length} of ${nl} links drawn (peak≥${SIM_MIN_PEAK_Q} m³/s) — DrainageViz module`);
    // surcharged-node markers (instanced-ish: one merged points cloud)
    const sp=new Float32Array(nn*3);
    for(let i=0;i<nn;i++){sp[i*3]=nx[i];sp[i*3+1]=0.6;sp[i*3+2]=nz[i];}
    const sg=new THREE.BufferGeometry();
    sg.setAttribute('position',new THREE.BufferAttribute(sp,3));
    simState.surchGeo=sg;
    // world-space sizing (sizeAttenuation) — at 12.5k surcharged nodes a fixed
    // SCREEN size turns the whole city into a red blanket at low zoom; in world
    // units they shrink away when zoomed out and only resolve when you go in.
    // surcharge dots: FIXED screen size (no zoom scaling) so they read as
    // consistent markers; the pipes already flash red at capacity so these are
    // subtle annotations of WHICH nodes overflow
    simState.surchMesh=new THREE.Points(sg,new THREE.PointsMaterial({
      color:0xff5a3c,size:7,sizeAttenuation:false,transparent:true,opacity:0.55,depthWrite:false}));
    simState.surchMesh.frustumCulled=false; simState.surchMesh.renderOrder=5;
    simState.surchMesh.visible=drainEnabled;
    sg.setDrawRange(0,0);
    scene.add(simState.surchMesh); drainMeshes.push(simState.surchMesh);
    simState.ready=true;
    console.log(`sim network: ${nn} nodes / ${nl} links (real 133 mm 12 h coupled run)`);
    await updateSimHour(currentStep);
    return true;
  }catch(e){ console.warn('sim network unavailable:',e); return false; }
  finally{ simState.loading=false; }
}
// Paint the network from the hour's REAL solved state and place surcharge pins.
async function updateSimHour(step){
  if(!simState.ready)return;
  const man=simState.man;
  const h=Math.max(0,Math.min(step,man.n_hours-1));
  let rec; try{ rec=await fetchSimHour(h); }catch(e){ return; }
  if(!rec)return;
  simState.hour=h;
  simState.rec=rec;              // real solved state for this step (manholes read it)
  const nn=man.n_nodes;
  const {sur}=rec;
  // rich pipe fill/flow are computed inside the module from the same rec
  if(simState.viz)simState.viz.updateHour(rec,simState.nodeMax,man.depth_scale,man.flow_scale);
  // surcharged node pins — compact the positions of set bits to the front
  const sp=simState.surchGeo.attributes.position.array;
  let n=0;
  for(let i=0;i<nn;i++){
    if(sur[i>>3]&(1<<(i&7))){
      const p=toLocal(simState.nodeLon[i],simState.nodeLat[i]);
      sp[n*3]=p.x; sp[n*3+1]=0.6; sp[n*3+2]=p.z; n++;
    }
  }
  simState.surchGeo.attributes.position.needsUpdate=true;
  simState.surchGeo.setDrawRange(0,n);
  simSurchargedCount=n;
  // Now that simState.rec is this hour's, repaint the manholes from it.
  if(perfEnabled)updateManholePerformance(h);
  if(glMap)glMap.triggerRepaint();
  // prefetch the neighbouring hour so scrubbing stays smooth
  if(h+1<man.n_hours)fetchSimHour(h+1).catch(()=>{});
}
let simSurchargedCount=0;

// Drainage catchments: the shaded polygons were removed (they read as "blackened
// Gurugram"). We keep only the OUTLET markers carrying the time of concentration
// — how long runoff takes to reach that outlet from the farthest head, at Manning
// velocities — plus a small click popup with the catchment's live status.
function addCatchmentsLayer(geo){
  if(drainCatchAdded||!map)return; drainCatchAdded=true;
  drainCatch=geo;
  const pts={type:'FeatureCollection',features:(geo.features||[]).map(f=>({
    type:'Feature',geometry:{type:'Point',coordinates:[f.properties.outlet_lon,f.properties.outlet_lat]},
    properties:{t:Math.round(f.properties.t_outlet_min),cid:f.properties.cid,idx:f.id}}))};
  map.addSource('catch-outlets-src',{type:'geojson',data:pts});
  map.addLayer({ id:'catch-outlets', type:'circle', source:'catch-outlets-src', minzoom:12,
    layout:{visibility:drainEnabled?'visible':'none'},
    paint:{'circle-radius':5,'circle-color':'#12b39a','circle-stroke-color':'#dffcf5','circle-stroke-width':1.3,'circle-opacity':0.9}});
  map.addLayer({ id:'catch-outlets-t', type:'symbol', source:'catch-outlets-src', minzoom:12.5,
    layout:{visibility:drainEnabled?'visible':'none',
      'text-field':['concat','⏱ ',['to-string',['get','t']],' min'],'text-size':11,
      'text-offset':[0,-1.2],'text-allow-overlap':false},
    paint:{'text-color':'#0c6f5c','text-halo-color':'#eafff9','text-halo-width':1.6}});
  map.on('click','catch-outlets',e=>{
    const p=e.features[0].properties, ft=(drainCatch.features||[])[p.idx], pr=ft&&ft.properties;
    const step=currentStep, f=pr?pr.fill[Math.min(step,pr.fill.length-1)]:0, h=pr?pr.hot[Math.min(step,pr.hot.length-1)]:0;
    new maplibregl.Popup({offset:8}).setLngLat(e.lngLat)
      .setHTML(`<div class="dpop"><b>Outlet · ${p.cid}</b>`
        +`<div>${pr?pr.len_km:'?'} km of drains · ${pr?pr.n_links:'?'} reaches upstream</div>`
        +`<div>runoff reaches this outlet in <b>~${Math.round(p.t)} min</b></div>`
        +`<div>now (hour ${step}): <b style="color:${f>=55?'#e64c30':'#2f8fd6'}">${f}% full</b>`
        +`${h>0?` · <b style="color:#e64c30">${h}% surcharged</b>`:''}</div></div>`)
      .addTo(map);
  });
  map.on('mouseenter','catch-outlets',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','catch-outlets',()=>{map.getCanvas().style.cursor='';});
}
function updateCatchments(step){ /* patches removed; outlet markers are static */ }

// STP (sewage-treatment-plant) inlet/outlet connections — the sewer chains
// flagged stp:true in the extract (micro-STP network). Shown as labelled nodes
// at their downstream ends so sewage treatment is visible on the network.
let stpAdded=false;
function addStpNodes(sewerGeo){
  if(stpAdded||!map||!sewerGeo)return; stpAdded=true;
  const feats=[];
  for(const f of (sewerGeo.features||[])){
    if(!f.properties||!f.properties.stp)continue;
    const c=f.geometry&&f.geometry.coordinates;
    if(!c||!c.length)continue;
    const end=c[c.length-1];
    feats.push({type:'Feature',geometry:{type:'Point',coordinates:end},
      properties:{id:f.properties.asset_id}});
  }
  if(!feats.length)return;
  map.addSource('stp-src',{type:'geojson',data:{type:'FeatureCollection',features:feats}});
  map.addLayer({ id:'stp-nodes', type:'circle', source:'stp-src', minzoom:12,
    layout:{visibility:drainEnabled?'visible':'none'},
    paint:{'circle-radius':6,'circle-color':'#8b5cf6','circle-stroke-color':'#ede9fe','circle-stroke-width':1.6,'circle-opacity':0.92}});
  map.addLayer({ id:'stp-label', type:'symbol', source:'stp-src', minzoom:13,
    layout:{visibility:drainEnabled?'visible':'none','text-field':'STP','text-size':9,'text-offset':[0,-1.1],'text-allow-overlap':false},
    paint:{'text-color':'#5b21b6','text-halo-color':'#fff','text-halo-width':1.4}});
  map.on('click','stp-nodes',e=>{
    new maplibregl.Popup({offset:8}).setLngLat(e.lngLat)
      .setHTML(`<div class="dpop"><b style="color:#8b5cf6">STP connection</b>`
        +`<div>sewage-treatment inlet/outlet node</div>`
        +`<div>${e.features[0].properties.id||''}</div></div>`).addTo(map);
  });
  map.on('mouseenter','stp-nodes',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','stp-nodes',()=>{map.getCanvas().style.cursor='';});
}

// Groundwater-recharge CANDIDATE zones — DERIVED from SWMM node ponding (where
// storm water accumulates on the surface), NOT an official CGWB/GMDA layer.
// Circle area ∝ ponded volume; the biggest basins are the best recharge sites.
let rechargeAdded=false;
function addRechargeLayer(geo){
  if(rechargeAdded||!map||!geo)return; rechargeAdded=true;
  map.addSource('recharge-src',{type:'geojson',data:geo});
  map.addLayer({ id:'recharge-zones', type:'circle', source:'recharge-src', minzoom:10,
    layout:{visibility:'none'},   // opt-in via the legend checkbox
    paint:{
      'circle-radius':['interpolate',['linear'],['get','pond_volume_ML'],0.5,5,10,16,36,30],
      'circle-color':'rgba(20,140,120,0.35)','circle-stroke-color':'#0c6f5c','circle-stroke-width':1.4}});
  map.addLayer({ id:'recharge-label', type:'symbol', source:'recharge-src', minzoom:12.5,
    layout:{visibility:'none','text-field':['concat',['to-string',['get','pond_volume_ML']],' ML'],
      'text-size':10,'text-allow-overlap':false},
    paint:{'text-color':'#0c6f5c','text-halo-color':'#eafff9','text-halo-width':1.5}});
  map.on('click','recharge-zones',e=>{
    const p=e.features[0].properties;
    new maplibregl.Popup({offset:8}).setLngLat(e.lngLat)
      .setHTML(`<div class="dpop"><b style="color:#0c6f5c">Recharge candidate #${p.rank}</b>`
        +`<div><b>${p.pond_volume_ML} ML</b> ponds here during the event</div>`
        +`<div>ponded ~${p.pond_hours} h</div>`
        +`<div style="color:#8a97a8;font-size:10px;margin-top:3px">Derived from SWMM ponding — candidate site, not an official recharge structure</div></div>`)
      .addTo(map);
  });
  map.on('mouseenter','recharge-zones',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','recharge-zones',()=>{map.getCanvas().style.cursor='';});
}
function setRechargeVisible(on){
  ['recharge-zones','recharge-label'].forEach(id=>{
    if(map&&map.getLayer(id))map.setLayoutProperty(id,'visibility',on?'visible':'none');
  });
}
// INLET → SWD CONNECTION. Both datasets are PROVIDED: the MCG inlet inventory
// (inlets_rim.geojson, 5,922 real side-entry pits with rim levels) and the
// coupled run's own drainage nodes. The shared data carries no explicit
// inlet→node table, so each inlet is joined to its NEAREST run node (a spatial
// join of the two provided layers — no invented geometry or attributes). The
// connection is drawn as the physical drop: street level → down the shaft →
// into the buried node it discharges to.
let dropPipesMesh=null;
function connectInletsToNetwork(inletsGeo){
  if(dropPipesMesh||!scene||!window.THREE||!inletsGeo||!simState.ready)return 0;
  const nn=simState.man.n_nodes, CELL=0.004;
  const grid=new Map();                                   // spatial index of run nodes
  for(let i=0;i<nn;i++){
    const k=Math.floor(simState.nodeLon[i]/CELL)+','+Math.floor(simState.nodeLat[i]/CELL);
    let a=grid.get(k); if(!a){a=[];grid.set(k,a);} a.push(i);
  }
  const v=[]; let joined=0;
  for(const f of (inletsGeo.features||[])){
    const c=f.geometry&&f.geometry.coordinates; if(!c)continue;
    const gx=Math.floor(c[0]/CELL), gy=Math.floor(c[1]/CELL);
    let best=-1,bd=1e18;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      const a=grid.get((gx+dx)+','+(gy+dy)); if(!a)continue;
      for(const i of a){
        const ddx=c[0]-simState.nodeLon[i], ddy=c[1]-simState.nodeLat[i];
        const d=ddx*ddx+ddy*ddy; if(d<bd){bd=d;best=i;}
      }
    }
    if(best<0)continue;
    joined++;
    const s=toLocal(c[0],c[1]);                           // gully at street level
    const t=toLocal(simState.nodeLon[best],simState.nodeLat[best]);
    const ny=-Math.min(Math.max(simState.nodeMax[best],0.3),12)*SIM_VEXAG;   // node pipe depth
    v.push(s.x,0,s.z, s.x,ny,s.z);                        // vertical drop from the road
    v.push(s.x,ny,s.z, t.x,ny,t.z);                       // lateral into the drain node
  }
  if(!v.length)return 0;
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(v,3));
  dropPipesMesh=new THREE.LineSegments(g,new THREE.LineBasicMaterial({
    color:0x7bd8ff,transparent:true,opacity:0.5,depthWrite:false}));
  dropPipesMesh.frustumCulled=false;dropPipesMesh.visible=drainEnabled;dropPipesMesh.renderOrder=2;
  scene.add(dropPipesMesh);drainMeshes.push(dropPipesMesh);
  console.log(`inlets: ${joined} of ${(inletsGeo.features||[]).length} MCG inlets connected to run nodes`);
  return joined;
}

// PUMP DISCHARGE: where each pump throws the flood water. Arrow from the pump to
// its recorded outlet (named trunk leg where the record gives one, else the
// nearest mapped drain), animated while the pump is running.
let pumpDischargeAdded=false;
function addPumpDischargeLayer(geo){
  if(pumpDischargeAdded||!map||!geo)return; pumpDischargeAdded=true;
  map.addSource('pump-disch-src',{type:'geojson',data:geo});
  map.addLayer({ id:'pump-discharge', type:'line', source:'pump-disch-src', minzoom:11,
    layout:{visibility:drainEnabled?'visible':'none','line-cap':'round'},
    paint:{'line-color':'#1d8fff','line-width':['interpolate',['linear'],['zoom'],11,1.6,17,4.5],
      'line-opacity':0.9,'line-dasharray':[0,2,3]}});
  map.addLayer({ id:'pump-discharge-arrow', type:'symbol', source:'pump-disch-src', minzoom:12.5,
    layout:{visibility:drainEnabled?'visible':'none','symbol-placement':'line',
      'text-field':'▶','text-size':13,'symbol-spacing':46,'text-keep-upright':false,'text-allow-overlap':true},
    paint:{'text-color':'#1d8fff','text-halo-color':'#e8f4ff','text-halo-width':1.4}});
  map.on('click','pump-discharge',e=>{
    const p=e.features[0].properties;
    new maplibregl.Popup({offset:8}).setLngLat(e.lngLat)
      .setHTML(`<div class="dpop"><b style="color:#1d8fff">Pump discharge</b>`
        +`<div>${p.pump_name||p.pump_id||''}</div>`
        +`<div>pumps <b>${p.capacity_lps} L/s</b> → <b>${p.discharge_to}</b></div>`
        +`<div>outlet ${p.dist_m} m away · ${p.target_asset||''}</div>`
        +`<div style="color:#8a97a8;font-size:10px;margin-top:3px">${p.basis||''}</div></div>`)
      .addTo(map);
  });
  map.on('mouseenter','pump-discharge',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','pump-discharge',()=>{map.getCanvas().style.cursor='';});
}
// Silt / desilting status: highlight the drains with a real MCG desilting record
// (machine type + date). Only the desilted reaches are drawn (a focused, cheap
// overlay) — green = recently desilted/maintained, so gaps read as "no record".
let siltAdded=false;
function addSiltOverlay(net,sewer){
  if(siltAdded||!map)return; siltAdded=true;
  const feats=[];
  for(const fc of [net,sewer])for(const f of (fc&&fc.features||[])){
    if(f.properties&&f.properties.desilted)
      feats.push({type:'Feature',geometry:f.geometry,
        properties:{t:f.properties.desilt_type||'',d:f.properties.desilt_date||''}});
  }
  if(!feats.length)return;
  map.addSource('silt-src',{type:'geojson',data:{type:'FeatureCollection',features:feats}});
  map.addLayer({ id:'silt-overlay', type:'line', source:'silt-src', minzoom:12,
    layout:{visibility:'none','line-cap':'round'},
    paint:{'line-color':'#22c55e','line-width':['interpolate',['linear'],['zoom'],12,1.5,17,4],'line-opacity':0.85}});
  map.on('click','silt-overlay',e=>{
    const p=e.features[0].properties;
    new maplibregl.Popup({offset:6}).setLngLat(e.lngLat)
      .setHTML(`<div class="dpop"><b style="color:#16a34a">Recently desilted</b>`
        +`<div>${p.t||'method n/a'}</div>`+(p.d?`<div>date: ${p.d}</div>`:'')+`</div>`).addTo(map);
  });
  map.on('mouseenter','silt-overlay',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','silt-overlay',()=>{map.getCanvas().style.cursor='';});
}
function setSiltVisible(on){
  if(map&&map.getLayer('silt-overlay'))map.setLayoutProperty('silt-overlay','visibility',on?'visible':'none');
}
function setStpVisible(on){
  ['stp-nodes','stp-label'].forEach(id=>{
    if(map&&map.getLayer(id))map.setLayoutProperty(id,'visibility',on?'visible':'none');
  });
}
function setDropPipesVisible(on){
  if(dropPipesMesh)dropPipesMesh.visible=on&&drainEnabled;
  if(glMap)glMap.triggerRepaint();
}
function nearestAnyConduit(lng,lat){
  let best=1e9,cd=null;
  for(const c of drainConduits){ if(c.cLng===undefined)continue;
    const dx=lng-c.cLng,dy=lat-c.cLat,d=dx*dx+dy*dy; if(d<best){best=d;cd=c;} }
  return cd;
}

// ── Manhole-performance overlay: fill over the event + backflow plumes ────────
// Water column rises 0→full between onset_min and peak_min, recedes over the
// node's persistence, then settles. Colour = cumulative-backflow severity.
function perfFillFrac(d, em){
  const on=d.onset, pk=Math.max(d.peak, on+1);
  if(em<=on) return 0;
  if(em<pk)  return Math.min(1,(em-on)/(pk-on));
  const declineEnd = pk + Math.max(d.pers,30)*1.5;
  if(em<declineEnd) return Math.max(0.45, 1 - 0.55*(em-pk)/(declineEnd-pk));
  return 0.45;
}
function perfSevColor(back){
  const t=Math.min(1, Math.log10(back+1)/Math.log10(PERF_BACKFLOW_FULL_M3+1));
  return new THREE.Color().setHSL((1-t)*0.14, 0.95, 0.52);   // amber (low) → red (high)
}
async function buildManholePerformance(){
  if(perfLoaded||!scene||!window.THREE||!modelTransform)return;
  perfLoaded=true;
  try{
    if(!drainLight){ drainLight=new THREE.DirectionalLight(0xffffff,0.85); drainLight.position.set(0.4,1,0.3); scene.add(drainLight); }
    const [man,bf,pumps,inlets,outfalls]=await Promise.all([
      fetch('/drainage/manholes_progression.geojson').then(r=>r.json()),
      fetch('/drainage/backflow_nodes.geojson').then(r=>r.json()).catch(()=>null),
      fetch('/drainage/pumps.geojson').then(r=>r.json()).catch(()=>null),
      fetch('/drainage/inlets_rim.geojson').then(r=>r.json()).catch(()=>null),
      fetch('/drainage/outfalls.geojson').then(r=>r.json()).catch(()=>null),
    ]);
    perfHydro=await getEventHydro();
    if(bf)addBackflowLayer(bf);
    if(pumps)addPumpsLayer(pumps);
    if(outfalls)addOutfallsLayer(outfalls);
    if(inlets){
      // give each inlet the onset of its nearest manhole so it switches on in sync
      const mo=(man.features||[]).map(f=>({x:f.geometry.coordinates[0],y:f.geometry.coordinates[1],on:Number(f.properties.onset_min)||0}));
      for(const ft of (inlets.features||[])){ const c=ft.geometry.coordinates; let b=1e9,o=0;
        for(const m of mo){ const d=(c[0]-m.x)**2+(c[1]-m.y)**2; if(d<b){b=d;o=m.on;} } ft.properties._onset=o; }
      addInletsLayer(inlets);
    }
    // Shaft from invert (deep, below ground) up to the rim at street level (y=0).
    const casingGeo=new THREE.CylinderGeometry(MANHOLE_R_M,MANHOLE_R_M,1,14,1,true);
    const waterGeo =new THREE.CylinderGeometry(MANHOLE_R_M*0.82,MANHOLE_R_M*0.82,1,14,1,false);
    const rimGeo   =new THREE.TorusGeometry(MANHOLE_R_M*1.05,MANHOLE_R_M*0.18,8,18);
    const puddleGeo=new THREE.CircleGeometry(1,28);
    const domeGeo  =new THREE.SphereGeometry(1,16,8,0,Math.PI*2,0,Math.PI*0.5);   // upwelling water (top hemisphere)
    const casingMat=new THREE.MeshBasicMaterial({color:0x9fb3c8,transparent:true,opacity:0.20,side:THREE.DoubleSide,depthWrite:false});
    const rimMat   =new THREE.MeshBasicMaterial({color:0x32404e});
    for(const ft of (man.features||[])){
      const c=ft.geometry&&ft.geometry.coordinates; if(!c)continue;
      const p=ft.properties||{};
      const {x,z}=toLocal(c[0],c[1]);
      const H=Math.max(Number(p.peak_storage_depth_m)||0.8,0.8)*PERF_VEXAG;   // shaft depth below ground
      const back=Number(p.peak_cumulative_backflow_m3)||0;
      const g=new THREE.Group(); g.position.set(x,0,z);
      const casing=new THREE.Mesh(casingGeo,casingMat);
      casing.scale.y=H; casing.position.y=-H/2; g.add(casing);       // invert at -H, rim at 0
      const water=new THREE.Mesh(waterGeo,getManholeWaterMat());     // caustic flood-water column
      water.scale.y=0.001; water.position.y=-H; g.add(water);        // water rises from invert toward rim
      const rim=new THREE.Mesh(rimGeo,rimMat);
      rim.rotation.x=Math.PI/2; rim.position.y=0; g.add(rim);        // ring marks the street-level rim
      // opaque cover disc exactly at street level → anchors the manhole to the ground
      const cover=new THREE.Mesh(new THREE.CircleGeometry(MANHOLE_R_M*0.95,16),new THREE.MeshLambertMaterial({color:0x3a4654}));
      cover.rotation.x=-Math.PI/2; cover.position.y=0.05; g.add(cover);
      const puddle=new THREE.Mesh(puddleGeo,getOverflowRippleMat());     // expanding ripple rings on the street
      puddle.rotation.x=-Math.PI/2; puddle.position.y=0.3; puddle.visible=false; g.add(puddle);
      const dome=new THREE.Mesh(domeGeo,new THREE.MeshLambertMaterial({color:0x4b93c8,transparent:true,opacity:0.78,depthWrite:false}));
      dome.position.y=0.1; dome.visible=false; g.add(dome);              // water boiling up out of the manhole
      g.visible=perfEnabled; g.frustumCulled=false; scene.add(g);
      perfManholes.push({g,water,puddle,dome,H,back,lng:c[0],lat:c[1],cd:undefined,fT:0,fillDisp:0,
        onset:Number(p.onset_min)||0, peak:Number(p.peak_min)||0,
        pers:Number(p.receiver_persistence_min)||30});
    }
    updateManholePerformance(currentStep);
    if(glMap)glMap.triggerRepaint();
  }catch(err){ console.warn('manhole perf build failed',err); perfLoaded=false; throw err; }
}
function nearestConduit(lng,lat){
  // storm conduits only — the manhole progression data is storm-event backflow,
  // so a shaft must not be capped by an unrelated (always-wet) sewer lateral.
  let best=1e9,cd=null;
  for(const c of drainConduits){ if(c.cLng===undefined||c.net===1)continue;
    const dx=lng-c.cLng,dy=lat-c.cLat,d=dx*dx+dy*dy; if(d<best){best=d;cd=c;} }
  return cd;
}
// Per-frame: raise each shaft toward its target, but CAP it at the pipe-below's fill
// until that pipe is (near) full — the shaft only climbs above the pipe once it surcharges.
// Bind each performance manhole to the nearest node of the solved network, once.
// A coarse lon/lat bucket grid keeps this ~O(n) instead of 152 × 118,768.
let _mhBound=false;
function bindManholeNodes(){
  if(_mhBound||!simState.nodeLon)return;
  _mhBound=true;
  const CELL=0.002;                                     // ≈200 m buckets
  const grid=new Map();
  const key=(a,b)=>a+':'+b;
  for(let i=0;i<simState.nodeLon.length;i++){
    const k=key(Math.floor(simState.nodeLon[i]/CELL),Math.floor(simState.nodeLat[i]/CELL));
    let a=grid.get(k); if(!a){a=[];grid.set(k,a);} a.push(i);
  }
  for(const m of perfManholes){
    const gx=Math.floor(m.lng/CELL), gy=Math.floor(m.lat/CELL);
    let best=-1,bd=Infinity;
    for(let r=0;r<=2&&best<0;r++){                      // widen the ring until something is found
      for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++){
        if(r>0&&Math.abs(dx)<r&&Math.abs(dy)<r)continue; // only the new ring
        const a=grid.get(key(gx+dx,gy+dy)); if(!a)continue;
        for(const i of a){
          const d=(simState.nodeLon[i]-m.lng)**2+(simState.nodeLat[i]-m.lat)**2;
          if(d<bd){bd=d;best=i;}
        }
      }
    }
    m.simNode=best;
  }
  console.log(`manholes bound to solver nodes: ${perfManholes.filter(m=>m.simNode>=0).length}/${perfManholes.length}`);
}
function tickManholes(snap){
  if(!perfManholes.length)return;
  const k=snap?1:0.1; let sc=0;
  for(const m of perfManholes){
    if(m.cd===undefined) m.cd = drainConduits.length ? nearestConduit(m.lng,m.lat) : null;
    // HYDRAULIC-GRADE COUPLING: a shaft is an open column on the pipe below, so
    // its water level MIRRORS the pipe's level while the pipe has headroom —
    // water in the shaft drains INTO the pipe, it can't stack above the crown.
    // Only once the pipe runs ~full (surcharge: energy grade above the crown)
    // can the shaft rise past it toward the rim and overflow.
    // Only the legacy network needs this coupling imposed by hand — on the solved
    // network the node depth already IS the hydraulic grade at the shaft.
    const pf = (!useSimNetwork && m.cd && m.cd.fillD!==undefined) ? m.cd.fillD : 1;
    let f = m.fT;
    if(pf < 0.95) f = Math.min(f, pf);                              // shaft level = pipe level until the pipe surcharges
    m.fillDisp += (f - m.fillDisp)*k;
    const fh=Math.max(m.fillDisp*m.H,0.001);
    m.water.scale.y=fh; m.water.position.y=-m.H+fh/2;
    // On the solved network the overflow state is the solver's own surcharge
    // flag, not a threshold guessed off the displayed level.
    const erupt=(m.simSur!==undefined)?m.simSur:(m.fillDisp>=0.96);
    m.puddle.visible=erupt; m.dome.visible=erupt;
    if(erupt){
      const sev=Math.min(1,m.back/PERF_BACKFLOW_FULL_M3);
      m.puddle.scale.setScalar(MANHOLE_R_M*(1.6+4.0*sev));
      const dr=MANHOLE_R_M*(0.7+0.8*sev); m.dome.scale.set(dr,dr*0.85,dr);
      sc++;
    }
  }
  perfSurcharging=sc;
}
function updateManholePerformance(step){
  if(useSimNetwork&&simState.rec&&simState.nodeLon){
    // REAL per-manhole level: bind each shaft to its nearest solver node and read
    // that node's solved water depth / its max depth. The previous path multiplied
    // a NETWORK-WIDE storage curve by an onset ramp, which is a plausible-looking
    // animation rather than this manhole's actual hydraulics.
    bindManholeNodes();
    const ds=simState.man.depth_scale||1000, dep=simState.rec.depth, sur=simState.rec.sur;
    for(const m of perfManholes){
      if(m.simNode===undefined||m.simNode<0){ m.fT=0; m.simSur=false; continue; }
      const n=m.simNode;
      m.fT=Math.min(1,(dep[n]/ds)/Math.max(simState.nodeMax[n],0.1));
      m.simSur=!!(sur[n>>3]&(1<<(n&7)));     // solver's own surcharge flag
    }
  }else{
    const em=step*60, frac=storageFracAt(step);  // legacy network: no per-node solution exists
    for(const m of perfManholes){
      m.fT=frac*Math.min(1,Math.max(0,(em-(m.onset-MH_FILL_WIN_MIN))/MH_FILL_WIN_MIN));
    }
  }
  tickManholes(false);
  updateInletsActive(step);
  updatePerfMarkers(step);
  const el=document.getElementById('perfReadout');
  if(el){
    const fr=perfHydro&&perfHydro.frames&&perfHydro.frames.find(f=>Math.round(f.t_h)===step);
    let s=`Hour ${step} · ${perfSurcharging} manhole${perfSurcharging===1?'':'s'} surcharging`;
    if(fr)s+=` · ${Math.round(fr.node_storage_m3).toLocaleString()} m³ in network · ${fr.links_active} conduits flowing`;
    el.textContent=s;
  }
}
function setPerformanceVisible(on){
  perfEnabled=on;
  perfManholes.forEach(m=>{m.g.visible=on;});
  ['backflow-nodes','inlets-grates','outfalls-circles','outfalls-labels'].forEach(id=>{
    if(map&&map.getLayer(id))map.setLayoutProperty(id,'visibility',on?'visible':'none');
  });
  ['pumps-circles','pumps-labels'].forEach(id=>{           // pumps stay while EITHER overlay is on
    if(map&&map.getLayer(id))map.setLayoutProperty(id,'visibility',(on||drainEnabled)?'visible':'none');
  });
  updateBasemapDim();
  if(on)updateManholePerformance(currentStep);
  if(glMap)glMap.triggerRepaint();
}

// ── Backflow + pump map layers (native MapLibre, clickable popups) ────────────
// Flood depth (metres) at a point for the current step, from the loaded polygons.
function depthAtPoint(lng,lat){
  if(simState.floodGrid){const s=simDepthAt(lng,lat);if(s!==null)return s;}  // real run, O(1)
  if(!polygonRings||!lastDepths)return 0;
  let d=0;
  for(let p=0;p<polygonRings.length;p++){
    const dp=lastDepths[p];
    if(dp<=d)continue;
    if(pointInPolygon(lng,lat,polygonRings[p]))d=dp;
  }
  return d;
}
function addBackflowLayer(geo){
  if(perfBackflowAdded||!map)return; perfBackflowAdded=true;
  map.addSource('backflow-src',{type:'geojson',data:geo});
  map.addLayer({ id:'backflow-nodes', type:'circle', source:'backflow-src',
    layout:{visibility:perfEnabled?'visible':'none'},
    paint:{
      'circle-radius':['interpolate',['linear'],['coalesce',['get','back_m3'],0],0,4,5000,9,20000,16],
      'circle-color':'#ff3b30','circle-opacity':0.78,
      'circle-stroke-color':'#7a0d08','circle-stroke-width':1
    }});
  map.on('click','backflow-nodes',e=>{
    const p=e.features[0].properties, c=e.lngLat;
    new maplibregl.Popup({offset:10}).setLngLat(c)
      .setHTML(`<div class="dpop"><b>#${p.rank??'?'} · ${p.landmark||('Ward '+(p.ward||'?'))}</b>`
        +`<div>backflow node · <b>${Math.round(+p.back_m3||0).toLocaleString()} m³</b> cumulative backflow</div>`
        +(p.onset_min?`<div>surcharge onset: hour ${Math.round(p.onset_min/60)}</div>`:'')+`</div>`)
      .addTo(map);
  });
  map.on('mouseenter','backflow-nodes',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','backflow-nodes',()=>{map.getCanvas().style.cursor='';});
}
// Surface inlets / gully grates — where street runoff enters the network. 5,922
// points, so only shown from zoom 14+ to avoid clutter at city scale.
// Draw a storm-drain gully grate (frame + parallel bars) as an SDF image so it
// can be tinted per state (grey = dry, cyan = capturing).
// Build the CONNECTED network + flowing water:
//   • laterals: a short pipe from each inlet (side-entry pit) to the nearest main
//   • flowing dashes that travel FROM the inlets INTO the mains (water entering & populating)
let drainFlowStarted=false, dashStep=-1;
const DASH_SEQ=[[0,4,3],[0.5,4,2.5],[1,4,2],[1.5,4,1.5],[2,4,1],[2.5,4,0.5],[3,4,0],
                [0,0.5,3,3.5],[0,1,3,3],[0,1.5,3,2.5],[0,2,3,2],[0,2.5,3,1.5],[0,3,3,1],[0,3.5,3,0.5]];
function addDrainFlow(net,trunk,inlets){
  if(!map||map.getLayer('drain-flow'))return;
  const drains=[...(net.features||[]),...(trunk.features||[])];
  // spatial grid of drain vertices → fast nearest-point lookup for the laterals
  const CELL=0.0025, grid=new Map();
  const key=(x,y)=>Math.floor(x/CELL)+','+Math.floor(y/CELL);
  const parts=g=>g.type==='LineString'?[g.coordinates]:(g.type==='MultiLineString'?g.coordinates:[]);
  for(const f of drains)for(const pr of parts(f.geometry))for(const c of pr){const k=key(c[0],c[1]);let a=grid.get(k);if(!a){a=[];grid.set(k,a);}a.push(c);}
  const nearest=(x,y)=>{const gx=Math.floor(x/CELL),gy=Math.floor(y/CELL);let b=1e9,bp=null;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const a=grid.get((gx+dx)+','+(gy+dy));if(!a)continue;
      for(const p of a){const d=(x-p[0])**2+(y-p[1])**2;if(d<b){b=d;bp=p;}}}return{bp,b};};
  const feats=drains.map(f=>({type:'Feature',geometry:f.geometry,properties:{k:'main'}}));
  const MAXD=(CELL*1.6)**2;                               // only connect inlets reasonably near a main
  for(const it of (inlets&&inlets.features||[])){ const c=it.geometry&&it.geometry.coordinates; if(!c)continue;
    const {bp,b}=nearest(c[0],c[1]); if(bp&&b<MAXD) feats.push({type:'Feature',geometry:{type:'LineString',coordinates:[c,bp]},properties:{k:'lateral'}}); }
  map.addSource('drainflow-src',{type:'geojson',data:{type:'FeatureCollection',features:feats}});
  map.addLayer({ id:'drain-flow', type:'line', source:'drainflow-src', minzoom:13,
    layout:{ visibility:drainEnabled?'visible':'none','line-cap':'round','line-join':'round' },
    paint:{ 'line-color':['case',['==',['get','k'],'lateral'],'#8ee7ff','#4bb8ee'],
      'line-width':['interpolate',['linear'],['zoom'],13,['case',['==',['get','k'],'lateral'],0.5,1.4],18,['case',['==',['get','k'],'lateral'],1.6,3.6]],
      'line-opacity':0.9, 'line-dasharray':[0,4,3] }});
  if(!drainFlowStarted){ drainFlowStarted=true;
    const tick=ts=>{ if(map&&map.getLayer('drain-flow')&&drainEnabled){ const ns=Math.floor((ts/70)%DASH_SEQ.length);
      if(ns!==dashStep){ dashStep=ns; try{ map.setPaintProperty('drain-flow','line-dasharray',DASH_SEQ[ns]); }catch(e){} } }
      requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}
function makeGrateImage(){
  const s=40, cv=document.createElement('canvas'); cv.width=s; cv.height=s;
  const ctx=cv.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(3,3,s-6,s-6);          // grate frame block
  ctx.globalCompositeOperation='destination-out';           // cut the slot openings
  for(let i=0;i<4;i++) ctx.fillRect(7, 8+i*7.5, s-14, 4);
  ctx.globalCompositeOperation='source-over';
  return ctx.getImageData(0,0,s,s);
}
function addInletsLayer(geo){
  if(perfInletsAdded||!map)return; perfInletsAdded=true;
  map.addSource('inlets-src',{type:'geojson',data:geo});
  if(!map.hasImage('inlet-grate')) map.addImage('inlet-grate', makeGrateImage(), {sdf:true});
  map.addLayer({ id:'inlets-grates', type:'symbol', source:'inlets-src', minzoom:13.5,
    layout:{ visibility:(perfEnabled||drainEnabled)?'visible':'none', 'icon-image':'inlet-grate',
      'icon-size':0.55, 'icon-allow-overlap':true,
      'icon-pitch-alignment':'map', 'icon-rotation-alignment':'map' },   // lie FLAT on the street, not a billboard
    paint:{ 'icon-color':'#c4cfda', 'icon-opacity':0.95, 'icon-halo-color':'#0b2233', 'icon-halo-width':0.8 }});
  map.on('click','inlets-grates',e=>{
    const p=e.features[0].properties;
    new maplibregl.Popup({offset:8}).setLngLat(e.lngLat)
      .setHTML(`<div class="dpop"><b>Inlet ${p.inlet_id||''}</b>`
        +`<div>rim level <b>${(+p.rim_level_m||0).toFixed(2)} m</b></div>`
        +`<div>capture ${(+p.best_guess_capacity_m3s||0).toFixed(2)} m³/s · ${p.asset_class||''}</div></div>`)
      .addTo(map);
  });
  map.on('mouseenter','inlets-grates',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','inlets-grates',()=>{map.getCanvas().style.cursor='';});
}
// Inlets light up (white → cyan) once their local onset has passed and the
// network is actively carrying water — synced with the pipe/manhole filling.
function updateInletsActive(step){
  if(!map||!map.getLayer('inlets-grates'))return;
  const em=step*60, gf=storageFracAt(step);
  if(gf<0.05){ map.setPaintProperty('inlets-grates','icon-color','#c4cfda'); }   // dry grate = grey
  else { map.setPaintProperty('inlets-grates','icon-color',                       // capturing (before the pipe fills)
    ['case',['<=',['coalesce',['get','_onset'],0], em+INLET_LEAD_MIN],'#2fd0ff','#c4cfda']); }
}
// Outfalls — where the network discharges to a nala/river/pond. Distinct teal
// markers (not backflow-red), visible from city zoom (only ~67), with a ⤓ glyph.
function addOutfallsLayer(geo){
  if(perfOutfallsAdded||!map)return; perfOutfallsAdded=true;
  map.addSource('outfalls-src',{type:'geojson',data:geo});
  // Outfall = teal ▼ TRIANGLE glyph only (no circle), fixed size — matches legend
  map.addLayer({ id:'outfalls-circles', type:'symbol', source:'outfalls-src', minzoom:11,
    layout:{visibility:(perfEnabled||drainEnabled)?'visible':'none',
      'text-field':'▼','text-size':17,'text-allow-overlap':true,'text-anchor':'center'},
    paint:{'text-color':'#12b39a','text-halo-color':'#eafff9','text-halo-width':1.6}});
  map.on('click','outfalls-circles',e=>{
    const p=e.features[0].properties;
    new maplibregl.Popup({offset:10}).setLngLat(e.lngLat)
      .setHTML(`<div class="dpop"><b>Outfall ${p.outfall_id||''}</b>`
        +`<div>${p.outfall_class||''}${p.city_side?(' · '+p.city_side+' side'):''}</div>`
        +`<div>terrain <b>${(+p.terrain_elev_m||0).toFixed(1)} m</b></div>`
        +(p.basis?`<div>${p.basis}</div>`:'')+`</div>`)
      .addTo(map);
  });
  map.on('mouseenter','outfalls-circles',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','outfalls-circles',()=>{map.getCanvas().style.cursor='';});
}
function addPumpsLayer(geo){
  if(perfPumpsAdded||!map)return; perfPumpsAdded=true; perfPumpsData=geo;
  map.addSource('pumps-src',{type:'geojson',data:geo});
  // Pump = ■ SQUARE glyph, fixed size, green idle / blue running — matches legend
  map.addLayer({ id:'pumps-circles', type:'symbol', source:'pumps-src',
    layout:{visibility:(perfEnabled||drainEnabled)?'visible':'none',
      'text-field':'■','text-size':14,'text-allow-overlap':true},
    paint:{'text-color':['case',['==',['get','_on'],true],'#1d8fff','#34c759'],
      'text-halo-color':'#08240f','text-halo-width':1.2}});
  map.on('click','pumps-circles',e=>{
    const p=e.features[0].properties, c=e.lngLat;
    const dep=depthAtPoint(c.lng,c.lat), act=+p.activation_depth_m||0;
    const on=dep>=act&&act>0;
    new maplibregl.Popup({offset:10})
      .setLngLat(c)
      .setHTML(`<div class="dpop"><b>${p.pump_id||'Pump'}</b>`
        +`<div>${p.pump_location_name||p.ward_source||''}</div>`
        +`<div>capacity <b>${(+p.assigned_capacity_lps||0).toFixed(0)} L/s</b> · ${p.pump_type||''}</div>`
        +`<div>activate ≥ <b>${act.toFixed(2)} m</b> · stop ≤ ${(+p.stop_depth_m||0).toFixed(2)} m</div>`
        +`<div>local flood now: <b>${dep.toFixed(2)} m</b> → <b style="color:${on?'#1d8fff':'#34c759'}">${on?'RUNNING':'idle'}</b></div></div>`)
      .addTo(map);
  });
  map.on('mouseenter','pumps-circles',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','pumps-circles',()=>{map.getCanvas().style.cursor='';});
}
// Per-step: reveal backflow nodes once their onset has passed; flag running pumps.
function updatePerfMarkers(step){
  const em=step*60;
  if(map&&map.getLayer('backflow-nodes'))
    map.setFilter('backflow-nodes',['<=',['coalesce',['get','onset_min'],0],em]);
  const src=map&&map.getSource('pumps-src');
  if(src&&perfPumpsData){
    for(const ft of perfPumpsData.features){
      const c=ft.geometry.coordinates, act=+ft.properties.activation_depth_m||0;
      ft.properties._on = act>0 && depthAtPoint(c[0],c[1])>=act;
    }
    src.setData(perfPumpsData);
  }
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
  const allBands=activeBands.size===DEPTH_BANDS.length;
  for(let p=0;p<polygonCount;p++){
    const d=depths[p];
    // Skip polygons whose depth band is filtered out — leaving their texels at
    // 0 makes the shader discard them, so those areas render transparent.
    if(d>0&&(allBands||activeBands.has(bandKeyForDepth(d)))){
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
    setStatus('30% – Loading coordinates…');
    prefetchData();                       // no-op if boot already started it
    coordinatesBuffer=await _coordsPromise;
    buildPolygonRings();                  // also derives polygonCount

    // When the real coupled run is present, the per-step DEPTHS come from the
    // SWE grids (tiny), so the 21 MB flood chunks are never needed — skip them.
    if(!(simState.man&&simState.man.grid_n)){
      try{ simState.man=simState.man||await fetch('/sim/manifest.json').then(r=>r.ok?r.json():null); }catch(e){}
    }
    if(!(simState.man&&simState.man.grid_n)){
      setStatus('60% – Preloading chunks…');
      await loadChunk(0);                  // legacy flood path (no sim run available)
      loadChunk(1);
    }

    setStatus('100% – Ready!');
    setTimeout(()=>{
      document.getElementById('loadingOverlay').classList.add('hidden');
      updateStep(0);
      // Critical-asset markers are off by default, so fetch them off the
      // critical path (after the map is interactive) to keep landing fast.
      bootAssetsDeferred();
    },400);
  }catch(err){
    console.error(err);
    setStatus('❌ '+err.message);
    document.querySelector('#loadingOverlay .loader h2').textContent='Load Failed';
    document.querySelector('#loadingOverlay .spinner').style.display='none';
  }
}

// Raw chunk byte-fetches can start before polygonCount is known (i.e. before
// the map / three.js are ready). The slicing into per-timestep arrays — which
// needs polygonCount — happens later, in loadChunk.
const _rawChunkFetch=new Map();
let _coordsPromise=null;
function fetchChunkRaw(idx){
  if(!_rawChunkFetch.has(idx)){
    _rawChunkFetch.set(idx, fetch(`${CFG.dataUrls.chunksBase}chunk_${String(idx).padStart(3,'0')}.bin`)
      .then(r=>{if(!r.ok)throw new Error(`chunk_${idx}`);return r.arrayBuffer();}));
  }
  return _rawChunkFetch.get(idx);
}
// Kick off the heavy data downloads (coordinates + the first two chunks) as
// early as possible so they overlap with the map / three.js SDK loads instead
// of waiting for the map 'load' event. Idempotent.
function prefetchData(){
  if(_coordsPromise)return;
  _coordsPromise=fetch(CFG.dataUrls.coordinates).then(r=>{
    if(!r.ok)throw new Error(`coordinates.bin → HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  // NOTE: flood chunks are no longer prefetched here — when the real coupled run
  // is present, initializeVisualization() skips them entirely (depths come from
  // the SWE grids). loadChunk() still fetches on demand for the legacy fallback.
}
async function loadChunk(idx){
  if(chunkCache.has(idx))return;
  if(chunkQueue.has(idx)){while(chunkQueue.has(idx))await sleep(50);return;}
  chunkQueue.add(idx);
  try{
    const v=new Float32Array(await fetchChunkRaw(idx));
    const d={},s=idx*CHUNK_SIZE,e=Math.min(s+CHUNK_SIZE,TOTAL_STEPS+1);
    for(let ts=s,i=0;ts<e;ts++,i++)d[ts]=v.slice(i*polygonCount,(i+1)*polygonCount);
    chunkCache.set(idx,d);
    if(chunkCache.size>MAX_CACHED)chunkCache.delete(chunkCache.keys().next().value);
  }catch(e){console.error(e);}finally{chunkQueue.delete(idx);_rawChunkFetch.delete(idx);}
}
async function getDepth(step){
  const ci=Math.floor(step/CHUNK_SIZE);
  if(!chunkCache.has(ci)){
    document.getElementById('chunkLoadingIndicator').style.display='flex';
    await loadChunk(ci);
    document.getElementById('chunkLoadingIndicator').style.display='none';
  }
  // Guard against a short/stale chunk (e.g. an old cached file with fewer steps
  // or columns than the current build): only hand back a full-width depth row.
  const arr=chunkCache.get(ci)?.[step];
  return (arr&&arr.length===polygonCount)?arr:null;
}

let simFloodTried=false;
async function ensureSimFlood(){
  if(simState.floodMesh||simFloodTried||!scene||!modelTransform||!window.THREE)return;
  simFloodTried=true;
  try{
    if(!simState.man){
      simState.man=await fetch(`${SIM_BASE}/manifest.json`).then(r=>r.ok?r.json():null);
      if(simState.man)applyDatasetTimeline(simState.man);
    }
    if(!simState.man||!simState.man.grid_n)return;
    buildSimFlood();
    await updateSimFloodHour(currentStep);
    if(waterMeshes[0])waterMeshes[0].visible=false;   // retire the old (wrong-event) procedural flood
    console.log('2D flood now driven by the real coupled run (synced with drains)');
  }catch(e){ console.warn('sim flood init failed:',e); }
}
// Per-polygon depth sampled from the SWE grid → hotspots / popups / road
// analysis all read the SAME run as the flood + drains.
let _polyCentroids=null;
function simDepthsForPolygons(){
  if(!polygonRings)return null;
  if(!_polyCentroids){
    _polyCentroids=new Float64Array(polygonCount*2);
    for(let p=0;p<polygonCount;p++){
      const r=polygonRings[p]; let sx=0,sy=0;
      for(const v of r){sx+=v.lng;sy+=v.lat;}
      _polyCentroids[p*2]=sx/r.length; _polyCentroids[p*2+1]=sy/r.length;
    }
  }
  const out=new Float32Array(polygonCount);
  for(let p=0;p<polygonCount;p++)out[p]=simDepthAt(_polyCentroids[p*2],_polyCentroids[p*2+1])||0;
  return out;
}

async function updateStep(step){
  step=Math.max(0,Math.min(TOTAL_STEPS,step));
  currentStep=step;
  await ensureSimFlood();
  if(simState.floodMesh){
    // ── REAL coupled run drives the 2D flood; polygons inherit its depths ──
    await updateSimFloodHour(step);
    lastDepths=simDepthsForPolygons()||lastDepths;
  }else{
    const depths=await getDepth(step);if(!depths)return;
    lastDepths=depths;
    updateDepthTexture(depths);
    const nc=Math.floor(step/CHUNK_SIZE)+1;
    if(nc<TOTAL_CHUNKS&&!chunkCache.has(nc)&&!chunkQueue.has(nc))loadChunk(nc).catch(()=>{});
  }
  updateBeacons();                                   // pulsing beacons on the top-N deepest hotspots
  fpPopup.style.display='none';fpLat=fpLng=null;
  // 13 hourly steps: hour_0 (dry, time_s=0) … hour_12. EVENT_START is the rain
  // start (1:00 AM); step N is N hours later, so step 0 = 1 AM … step 12 = 1 PM.
  // Only the date is shown — the time-of-day clock is intentionally omitted.
  const z=n=>String(n).padStart(2,'0');
  if(simDataset==='live'&&simState.man){
    // Forecast frames carry real valid times — show the clock, and flag how far
    // the shown frame sits from now so a forecast is never mistaken for nowcast.
    const fr=(simState.man.frames||[])[step];
    const t=fr&&(fr.valid_at||fr.valid_time)?new Date(fr.valid_at):null;
    const dsp=document.getElementById('timeDisplay');
    const sub=document.getElementById('timeSub');
    if(t&&!isNaN(t)){
      // Lead time into the forecast window (T+) is the primary reading; the wall
      // clock and the offset from now sit underneath it.
      const base=new Date(simState.man.base_valid_time||fr.valid_at);
      const tp=fmtDur(t.getTime()-base.getTime());
      dsp.textContent=`T+${tp}`;
      const dms=t.getTime()-Date.now();
      const rel=Math.abs(dms)<=5*60000?'now':`${fmtDur(Math.abs(dms))} ${dms<0?'ago':'ahead'}`;
      if(sub)sub.textContent=`${z(t.getDate())}-${MONTHS[t.getMonth()].slice(0,3)} ${z(t.getHours())}:${z(t.getMinutes())} · ${rel}`;
    }else{
      dsp.textContent=`Frame ${step}`;
      if(sub)sub.textContent='';
    }
  }else{
    // 13 hourly steps: hour_0 (dry, time_s=0) … hour_12. EVENT_START is the rain
    // start (1:00 AM); step N is N hours later, so step 0 = 1 AM … step 12 = 1 PM.
    // Only the date is shown — the time-of-day clock is intentionally omitted.
    const EVENT_START='2025-07-09T01:00:00';
    const b=new Date(EVENT_START);b.setHours(b.getHours()+step);
    document.getElementById('timeDisplay').textContent=`${z(b.getDate())}-${MONTHS[b.getMonth()]}-${b.getFullYear()}`;
    const sub=document.getElementById('timeSub'); if(sub)sub.textContent='';
  }
  const lbl=document.getElementById('timeBoxLabel');
  if(lbl)lbl.textContent=(simDataset==='live')?'Lead Time':'Current Time';
  const sl=document.getElementById('timeSlider');sl.value=step;
  sl.style.background=`linear-gradient(to right,#5298A9 ${(step/TOTAL_STEPS*100)}%,#e2e8f0 ${(step/TOTAL_STEPS*100)}%)`;
  scheduleRoadAnalysis(true);
  // Refresh flood hotspots for the new step (skip during continuous playback to
  // avoid re-geocoding every 500ms; they update on pause/step/filter/move).
  if(!isPlaying)scheduleFloodSpots();
  if(drainEnabled)updateDrainFill(step);            // drains fill over the event
  else if(perfEnabled&&useSimNetwork)updateSimHour(step);   // perf also needs the solved record
  // On the solved network the manholes are refreshed from INSIDE updateSimHour,
  // once the hour's record has actually arrived — fetchSimHour is async, so
  // calling here would paint the previous hour's levels and surcharge count.
  if(perfEnabled&&!useSimNetwork)updateManholePerformance(step);
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

  const allBands = activeBands.size === DEPTH_BANDS.length;
  const active = [];
  for (let p = 0; p < polygonCount; p++) {
    const d = lastDepths[p];
    if (d < ROAD_CAUTION_M) continue;
    // Respect the legend filter so the road overlay only reflects flood in the
    // same depth bands the flood layer is currently showing.
    if (!allBands && !activeBands.has(bandKeyForDepth(d))) continue;
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

// ── Drainage network toggle (lazy-build on first enable) ─────────────────────
document.getElementById('drainToggle')?.addEventListener('click',async()=>{
  const btn=document.getElementById('drainToggle');
  const legend=document.getElementById('drainLegend');
  if(!drainLoaded){
    btn.textContent='Loading…';btn.disabled=true;
    try{await buildDrainageNetwork();}
    catch(e){btn.textContent='Failed — retry';btn.disabled=false;return;}
    btn.disabled=false;
  }
  const on=!drainEnabled;
  setDrainageVisible(on);
  btn.classList.toggle('active',on);
  btn.textContent=on?'Hide Drainage (3D)':'Show Drainage (3D)';
  if(legend)legend.hidden=!on;
  const eb=document.getElementById('engToggle'); if(eb)eb.hidden=!on;
  const bk=document.getElementById('drainBookmarks'); if(bk)bk.hidden=!on;
  // one water story at a time: dim the surface-flood layer while reading the
  // network; restore the user's opacity when the overlay goes off
  const fo=document.getElementById('floodOpSlider');
  if(fo){
    if(on){ fo.dataset.prev=fo.value; fo.value=15; }
    else if(fo.dataset.prev!==undefined){ fo.value=fo.dataset.prev; delete fo.dataset.prev; }
    fo.dispatchEvent(new Event('input',{bubbles:true}));
  }
});
document.getElementById('siltChk')?.addEventListener('change',e=>setSiltVisible(e.target.checked));
document.getElementById('stpChk')?.addEventListener('change',e=>setStpVisible(e.target.checked));
document.getElementById('dropChk')?.addEventListener('change',e=>{dropPipesOn=e.target.checked;setDropPipesVisible(dropPipesOn);});
document.getElementById('rechargeChk')?.addEventListener('change',e=>setRechargeVisible(e.target.checked));
// Capacity (choropleth) ↔ water (same solved data, rendered as water) switch
document.getElementById('engToggle')?.addEventListener('click',()=>{
  const btn=document.getElementById('engToggle');
  const on=!drainEngMode;
  setEngineeringView(on);
  btn.classList.toggle('active',on);
  btn.textContent=on?'Switch to water view':'Switch to capacity view';
});
// Event bookmarks: one click = hour + camera + the phase story. Peak spots are
// data-picked (the catchment with the worst surcharge share).
document.getElementById('drainBookmarks')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-bk]'); if(!b)return;
  const worst=(drainCatch&&drainCatch.features||[]).slice()
    .sort((a,c)=>c.properties.peak_hot-a.properties.peak_hot)[0];
  const wx=worst?worst.properties.outlet_lon:77.043, wy=worst?worst.properties.outlet_lat:28.444;
  const views={
    rain:  {h:2, cam:{center:[77.03,28.44],zoom:12.6,pitch:35,bearing:0}},
    load:  {h:6, cam:{center:[wx,wy],zoom:14.2,pitch:50,bearing:20}},
    peak:  {h:9, cam:{center:[wx,wy],zoom:15.6,pitch:62,bearing:20}},
    reced: {h:12,cam:{center:[77.03,28.44],zoom:12.6,pitch:35,bearing:0}},
  };
  const v=views[b.dataset.bk]; if(!v)return;
  const s=document.getElementById('timeSlider');
  if(s){ s.value=v.h; s.dispatchEvent(new Event('input',{bubbles:true})); }
  if(map)map.flyTo({...v.cam,duration:1400});
});

// ── Manhole-performance toggle (lazy-build, then scrub with the timeline) ─────
document.getElementById('perfToggle')?.addEventListener('click',async()=>{
  const btn=document.getElementById('perfToggle');
  const body=document.getElementById('perfBody');
  if(!perfLoaded){
    btn.textContent='Loading…';btn.disabled=true;
    try{
      // The manhole levels come from the solved network, which until now was only
      // ever built by the drainage toggle — so opening this overlay on its own
      // fell back to the legacy path and reported 0 surcharging at every hour.
      if(!useSimNetwork)useSimNetwork=await buildSimNetwork();
      await buildManholePerformance();
    }
    catch(e){btn.textContent='Failed — retry';btn.disabled=false;return;}
    btn.disabled=false;
  }
  const on=!perfEnabled;
  setPerformanceVisible(on);
  if(on)updateStep(currentStep);      // paint from the solved record straight away
  btn.classList.toggle('active',on);
  btn.textContent=on?'Hide Drainage Performance':'Show Drainage Performance';
  if(body)body.hidden=!on;
});

// ── Dataset switch: 09-July-2025 event ↔ daily live forecast ─────────────────
// Both datasets share the same network geometry, flood-plane grid and bbox, so
// switching only swaps the per-frame dynamics + timeline length. Everything
// downstream of updateStep() (flood texture, depth-at-point, roads, hotspots,
// drain fill, manhole performance) follows automatically.
function applyDatasetTimeline(man){
  TOTAL_STEPS=Math.max(0,(man.n_hours||1)-1);
  const sl=document.getElementById('timeSlider');
  if(sl){ sl.max=String(TOTAL_STEPS); if(+sl.value>TOTAL_STEPS)sl.value=String(TOTAL_STEPS); }
}

// Frame index closest to wall-clock now (live dataset only).
function liveNowStep(){
  const man=simState.man;
  if(!man||!man.base_valid_time)return 0;
  const step=Math.round((Date.now()-new Date(man.base_valid_time).getTime())
                        /((man.time_step_min||10)*60000));
  return Math.max(0,Math.min(TOTAL_STEPS,step));
}

async function switchDataset(kind){
  if(kind===simDataset)return;
  const prevBase=SIM_BASE, prevKind=simDataset;
  SIM_BASE=(kind==='live')?'/live':'/sim';
  simDataset=kind;
  const man=await fetch(`${SIM_BASE}/manifest.json`).then(r=>r.ok?r.json():null)
    .catch(()=>null);
  if(!man){                                    // not built yet → roll back cleanly
    SIM_BASE=prevBase; simDataset=prevKind;
    throw new Error('dataset_unavailable');
  }
  simState.man=man;
  simState.hourCache.clear();
  simState.floodCache.clear();
  simState.hour=-1; simState.floodHour=-1;
  depthScaleObserved=0; recomputeDepthScale();   // rescale to the new day's range
  applyDatasetTimeline(man);
  document.querySelectorAll('[data-dataset]').forEach(b=>
    b.classList.toggle('active',b.dataset.dataset===kind));
  const badge=document.getElementById('datasetBadge');
  if(badge)badge.textContent=(kind==='live')?'Live · today':'Event · 09 Jul 2025';
  const nowBtn=document.getElementById('liveNowBtn');
  if(nowBtn)nowBtn.hidden=(kind!=='live');   // only meaningful on a live timeline
  await updateStep(kind==='live'?liveNowStep():0);
  if(kind==='live')startRunStatusWatch(); else renderRunStatus();
}

document.getElementById('datasetSwitch')?.addEventListener('click',async e=>{
  const b=e.target.closest('[data-dataset]'); if(!b)return;
  const kind=b.dataset.dataset; if(kind===simDataset)return;
  const badge=document.getElementById('datasetBadge');
  const prev=badge?badge.textContent:'';
  if(badge)badge.textContent='Loading…';
  try{ await switchDataset(kind); }
  catch(err){
    console.error('dataset switch',err);
    if(badge)badge.textContent=(err.message==='dataset_unavailable')?'Not built':prev;
  }
});
document.getElementById('liveNowBtn')?.addEventListener('click',()=>{
  if(simDataset==='live')updateStep(liveNowStep());
});

// ── Forecast-run freshness timer + auto-resync ───────────────────────────────
// Anchored on the forecast WINDOW start (base_valid_time), not the run's
// generation time: what matters to a reader is which 24 h window they're looking
// at and when the next one begins. Polls /api/live-forecast/status; when the
// BUILT run_id changes underneath us (the scheduled rebuild landed) the dataset
// is reloaded in place so the visuals follow without a page refresh.
const RUN_POLL_MS=2*60*1000;     // check for a newer run
const RUN_TICK_MS=30*1000;       // re-render the countdown
let runStatus=null, runPollTimer=null, runTickTimer=null;

function fmtDur(ms){
  const s=Math.max(0,Math.round(ms/1000)), h=Math.floor(s/3600), m=Math.floor(s%3600/60);
  return h?`${h}h ${String(m).padStart(2,'0')}m`:`${m}m`;
}

function renderRunStatus(){
  const box=document.getElementById('runStatus');
  if(!box)return;
  box.hidden=(simDataset!=='live');
  if(box.hidden||!runStatus)return;
  const b=runStatus.built, dot=document.getElementById('runDot');
  const state=document.getElementById('runState');
  const win=document.getElementById('runWindow'), nxt=document.getElementById('runNext');
  if(!b||!b.base_valid_time){
    dot.className='run-dot err'; state.textContent='Live forecast not built';
    win.textContent='Run build_live_forecast.py to populate /live'; nxt.textContent='';
    return;
  }
  const start=new Date(b.base_valid_time);
  const spanMs=(b.n_hours-1)*(b.time_step_min||10)*60000;
  const end=new Date(start.getTime()+spanMs);
  const now=Date.now();
  const z=n=>String(n).padStart(2,'0');
  const hm=d=>`${z(d.getDate())}-${MONTHS[d.getMonth()].slice(0,3)} ${z(d.getHours())}:${z(d.getMinutes())}`;

  if(runStatus.building){
    dot.className='run-dot syncing'; state.textContent='Syncing new run…';
  }else if(runStatus.stale){
    dot.className='run-dot stale'; state.textContent='Newer run available';
  }else if(runStatus.upstream_error){
    dot.className='run-dot err'; state.textContent='Partner feed unreachable';
  }else if(now>end.getTime()){
    dot.className='run-dot stale'; state.textContent='Forecast window ended';
  }else{
    dot.className='run-dot'; state.textContent='Forecast window active';
  }
  win.textContent=`Window ${hm(start)} → ${hm(end)} · ${b.n_hours} frames`;
  nxt.textContent=(now<start.getTime())
    ? `Window opens in ${fmtDur(start.getTime()-now)}`
    : (now<=end.getTime()
        ? `Elapsed ${fmtDur(now-start.getTime())} · next window in ${fmtDur(end.getTime()-now)}`
        : `Ended ${fmtDur(now-end.getTime())} ago — awaiting the next run`);
}

async function pollRunStatus(){
  try{
    const s=await fetch('/api/live-forecast/status').then(r=>r.ok?r.json():null);
    if(!s)return;
    const prevRun=runStatus&&runStatus.built&&runStatus.built.run_id;
    runStatus=s;
    // The scheduled rebuild swapped in a new run — follow it live.
    if(simDataset==='live'&&prevRun&&s.built&&s.built.run_id!==prevRun){
      await resyncLiveDataset();
    }
    renderRunStatus();
  }catch(e){ /* transient — keep the last known status on screen */ }
}

// Reload the live manifest + frames in place, holding the reader's position in
// the window (relative offset) rather than snapping them somewhere arbitrary.
async function resyncLiveDataset(){
  const man=await fetch('/live/manifest.json').then(r=>r.ok?r.json():null).catch(()=>null);
  if(!man)return;
  const wasAtNow=Math.abs(currentStep-liveNowStep())<=1;
  simState.man=man;
  simState.hourCache.clear(); simState.floodCache.clear();
  simState.hour=-1; simState.floodHour=-1;
  applyDatasetTimeline(man);
  await updateStep(wasAtNow?liveNowStep():Math.min(currentStep,TOTAL_STEPS));
  console.log('live forecast resynced →',man.run_id);
}

function startRunStatusWatch(){
  renderRunStatus();
  if(!runPollTimer){ pollRunStatus(); runPollTimer=setInterval(pollRunStatus,RUN_POLL_MS); }
  if(!runTickTimer)runTickTimer=setInterval(renderRunStatus,RUN_TICK_MS);
}


// ── UI controls ───────────────────────────────────────────────────────────────
function removeAttribution(){
  ['.mappls-copyright','.mappls-logo','.mappls-watermark','.maplibregl-ctrl-attrib','.mappls-ctrl-attrib','[class*="mappls-logo"]','[class*="mappls-watermark"]','[class*="maplibregl-ctrl-logo"]','.maplibregl-ctrl-bottom-left','.maplibregl-ctrl-bottom-right','.mappls-ctrl-bottom-left','.mappls-ctrl-bottom-right','a[href*="mappls"]','a[href*="mapmyindia"]','img[src*="mappls"]','img[src*="mapmyindia"]',
   // The SDK's default fullscreen control sits top-right — remove it; we provide
   // our own fullscreen button in the bottom-right map controls.
   '.maplibregl-ctrl-top-right','.mapboxgl-ctrl-top-right','.mappls-ctrl-top-right','.maplibregl-ctrl-fullscreen','.mapboxgl-ctrl-fullscreen','[class*="ctrl-fullscreen"]'
  ].forEach(sel=>document.querySelectorAll(sel).forEach(el=>{el.style.cssText='display:none!important';}));
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
document.addEventListener('webkitfullscreenchange',syncFullscreenState);
document.getElementById('fullscreenBtn').addEventListener('click',toggleFullscreen);

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
  if(simState.floodMat)simState.floodMat.uniforms.uOpacity.value=floodOpacity;   // real SWE flood too
});

// ── Legend-as-filter: each band toggles whether its depth range is drawn ──────
function refreshLegendFilterUI(){
  document.querySelectorAll('#legend .legend-row').forEach(row=>{
    const on=activeBands.has(row.dataset.band);
    row.classList.toggle('legend-row-off',!on);
    row.setAttribute('aria-pressed',on?'true':'false');
  });
  const reset=document.getElementById('legendReset');
  if(reset)reset.hidden=(activeBands.size===DEPTH_BANDS.length);
}
function applyLegendFilter(){
  if(lastDepths)updateDepthTexture(lastDepths);   // re-rasterise current step
  if(glMap)glMap.triggerRepaint();
  scheduleRoadAnalysis(true);                      // keep road overlay in sync (no-op if disabled)
  refreshLegendFilterUI();
  scheduleFloodSpots();                            // hotspots reflect the active bands
}

// ── Flood Hotspots (related spots for the active legend filter) ───────────────
// Bins flooded polygons (in the active depth bands and current viewport) into
// ~600 m cells, ranks the worst by average depth × extent, and lists each spot's
// locality (reverse-geocoded via OSM/Nominatim, cached) with its average
// inundation. Updates on filter change, timestep (when paused), and map move.
const FS_CELL=0.006, FS_MAX_SPOTS=8, FS_MIN_DEPTH=0.05;
let _fsTimer=null, _fsToken=0;

function scheduleFloodSpots(){
  clearTimeout(_fsTimer);
  _fsTimer=setTimeout(()=>renderFloodSpots(computeFloodSpots()),400);
}

function computeFloodSpots(){
  if(!polygonRings||!lastDepths||!map)return[];
  ensurePolyBboxCache();
  const b=map.getBounds();
  const vW=b.getWest(),vE=b.getEast(),vS=b.getSouth(),vN=b.getNorth();
  const allBands=activeBands.size===DEPTH_BANDS.length;
  const cells=new Map();
  for(let p=0;p<polygonCount;p++){
    const d=lastDepths[p];
    if(!(d>=FS_MIN_DEPTH))continue;   // also rejects NaN/undefined from a short/stale depths array
    if(!allBands&&!activeBands.has(bandKeyForDepth(d)))continue;
    const i=p*4;
    const lng=(_polyBboxCache[i]+_polyBboxCache[i+1])/2;
    const lat=(_polyBboxCache[i+2]+_polyBboxCache[i+3])/2;
    if(lng<vW||lng>vE||lat<vS||lat>vN)continue;
    const key=Math.round(lat/FS_CELL)+'_'+Math.round(lng/FS_CELL);
    let c=cells.get(key);
    if(!c){c={n:0,sLat:0,sLng:0,sD:0,mx:0};cells.set(key,c);}
    c.n++;c.sLat+=lat;c.sLng+=lng;c.sD+=d;if(d>c.mx)c.mx=d;
  }
  const spots=[];
  cells.forEach(c=>spots.push({lat:c.sLat/c.n,lng:c.sLng/c.n,avg:c.sD/c.n,max:c.mx,count:c.n}));
  spots.sort((a,b)=>(b.avg*b.count)-(a.avg*a.count));   // deepest × largest first
  return spots.slice(0,FS_MAX_SPOTS);
}

// ── Pulsing beacons on the top-N deepest hotspots (citywide, not just in view) ─
let _beacons=[];
function clearBeacons(){ _beacons.forEach(b=>b.el.remove()); _beacons=[]; }
function computeTopHotspots(N){
  if(!polygonRings||!lastDepths)return[];
  ensurePolyBboxCache();
  const cells=new Map();
  for(let p=0;p<polygonCount;p++){
    const d=lastDepths[p]; if(!(d>=FS_MIN_DEPTH))continue;
    const i=p*4, lng=(_polyBboxCache[i]+_polyBboxCache[i+1])/2, lat=(_polyBboxCache[i+2]+_polyBboxCache[i+3])/2;
    const key=Math.round(lat/FS_CELL)+'_'+Math.round(lng/FS_CELL);
    let c=cells.get(key); if(!c){c={n:0,sLat:0,sLng:0,mx:0};cells.set(key,c);}
    c.n++;c.sLat+=lat;c.sLng+=lng;if(d>c.mx)c.mx=d;
  }
  const spots=[]; cells.forEach(c=>spots.push({lat:c.sLat/c.n,lng:c.sLng/c.n,max:c.mx,count:c.n}));
  spots.sort((a,b)=>b.max-a.max);                 // the deepest points first
  // greedy min-separation → N DISTINCT hotspots (not 8 markers in one pool)
  const MINSEP=0.009, picked=[];                  // ~900 m apart
  for(const s of spots){
    if(picked.every(p=>(p.lat-s.lat)**2+(p.lng-s.lng)**2 > MINSEP*MINSEP)){ picked.push(s); if(picked.length>=N)break; }
  }
  return picked;
}
function updateBeacons(){
  if(!map)return;
  clearBeacons();
  const mapEl=document.getElementById('map'); if(!mapEl)return;
  computeTopHotspots(8).forEach((s,idx)=>{
    const sev=SEV.find(x=>s.max<x.max)||SEV[SEV.length-1];
    const el=document.createElement('div');
    el.className='flood-beacon';
    el.style.setProperty('--beacon-color', sev.dot);
    el.innerHTML=`<span class="beacon-ring"></span><span class="beacon-ring beacon-ring--2"></span>`
      +`<span class="beacon-core">${idx+1}</span>`;
    mapEl.appendChild(el);
    const posUpdate=()=>{ try{ const pt=map.project({lat:s.lat,lng:s.lng});
      el.style.transform=`translate3d(${pt.x}px,${pt.y}px,0) translate(-50%,-50%)`; }catch(e){} };
    posUpdate();
    el.addEventListener('click',ev=>{ ev.stopPropagation();
      try{ const pt=map.project({lat:s.lat,lng:s.lng}); showFloodPopup(pt.x,pt.y,s.lng,s.lat,s.max); }catch(e){} });
    _beacons.push({el,lat:s.lat,lng:s.lng,posUpdate});
  });
}
function syncBeacons(){ _beacons.forEach(b=>b.posUpdate()); }

// Client-side locality cache (cell → name). Populated from /api/locality
// responses so re-renders (filter toggles, replays) show names with zero delay
// instead of an empty "Locating…" flash.
const _localityClient=new Map();
const _locKey=(lat,lng)=>lat.toFixed(3)+','+lng.toFixed(3);

function renderFloodSpots(spots){
  const panel=document.getElementById('floodSpots');
  const list=document.getElementById('fsList');
  const badge=document.getElementById('fsBadge');
  if(!panel||!list)return;
  if(!spots.length){panel.classList.add('hidden');return;}
  panel.classList.remove('hidden');
  if(badge)badge.textContent=spots.length;
  list.innerHTML=spots.map((s,i)=>{
    const sev=SEV.find(x=>s.avg<x.max)||SEV[SEV.length-1];
    const cached=_localityClient.get(_locKey(s.lat,s.lng));
    return `<button class="fs-row" type="button" data-lat="${s.lat}" data-lng="${s.lng}">
      <span class="fs-dot" style="background:${sev.dot}"></span>
      <span class="fs-row-main">
        <span class="fs-loc" id="fs-loc-${i}">${cached?esc(cached):'Locating…'}</span>
        <span class="fs-sub">avg ${s.avg.toFixed(2)} m · ${s.count} cell${s.count>1?'s':''}</span>
      </span>
      <span class="fs-sev" style="color:${sev.color};background:${sev.bg}">${sev.label}</span>
    </button>`;
  }).join('');
  list.querySelectorAll('.fs-row').forEach(row=>row.addEventListener('click',()=>{
    const lat=+row.dataset.lat,lng=+row.dataset.lng;
    try{map.flyTo({center:{lat,lng},zoom:16,pitch:map.getPitch()});}catch(e){}
  }));
  fillLocalities(spots,++_fsToken);
}

// Resolve every spot's locality in ONE batched, server-cached, parallel request
// (the proxy caches process-wide and fetches misses concurrently) — so names
// land in a single round trip, near-instant after the cache is warm.
function fillLocalities(spots,token){
  const need=spots.filter(s=>!_localityClient.has(_locKey(s.lat,s.lng)));
  if(!need.length)return;   // all cached → already rendered, nothing to fetch
  const pts=need.map(s=>`${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join(';');
  fetch('/api/locality?pts='+encodeURIComponent(pts))
    .then(r=>r.ok?r.json():{results:[]})
    .then(({results})=>{
      (results||[]).forEach(res=>{ if(res&&res.name)_localityClient.set(_locKey(res.lat,res.lng),res.name); });
      if(token!==_fsToken)return;   // a newer render superseded this one
      spots.forEach((s,i)=>{
        const el=document.getElementById('fs-loc-'+i);
        if(el)el.textContent=_localityClient.get(_locKey(s.lat,s.lng))||`${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`;
      });
    }).catch(()=>{});
}
document.querySelectorAll('#legend .legend-row').forEach(row=>{
  row.addEventListener('click',()=>{
    const band=row.dataset.band;
    if(activeBands.has(band))activeBands.delete(band);else activeBands.add(band);
    applyLegendFilter();
  });
});
const _legendReset=document.getElementById('legendReset');
if(_legendReset)_legendReset.addEventListener('click',()=>{
  DEPTH_BANDS.forEach(b=>activeBands.add(b.key));
  applyLegendFilter();
});
document.getElementById('zoomInBtn').addEventListener('click',()=>{try{map.setZoom(map.getZoom()+1);}catch(e){}});
document.getElementById('zoomOutBtn').addEventListener('click',()=>{try{map.setZoom(map.getZoom()-1);}catch(e){}});
// Fly to the deepest flooded cell at the current step (the red critical zone).
function jumpToDeepest(){
  if(!map||!polygonRings||!lastDepths)return;
  let maxD=0,maxI=-1;
  for(let p=0;p<lastDepths.length;p++){ if(lastDepths[p]>maxD){ maxD=lastDepths[p]; maxI=p; } }
  if(maxI<0||maxD<=0){ return; }
  const ring=polygonRings[maxI]; let sx=0,sy=0;
  for(const c of ring){ sx+=c.lng; sy+=c.lat; }   // ring is [{lng,lat}]
  const lng=sx/ring.length, lat=sy/ring.length;
  map.flyTo({center:[lng,lat], zoom:17.5, pitch:45, duration:1600});
  map.once('moveend',()=>{ try{ const pt=map.project({lng,lat}); showFloodPopup(pt.x,pt.y,lng,lat,maxD); }catch(e){} });
}
document.getElementById('jumpDeepestBtn')?.addEventListener('click',jumpToDeepest);

// ── Ward boundaries ──────────────────────────────────────────────────────────
// Ward boundaries — a permanent base layer, loaded at boot and always visible.
let wardsLoaded=false;
function _swapLL(g){ return (typeof g[0]==='number') ? [g[1],g[0]] : g.map(_swapLL); }   // [lat,lng]→[lng,lat]
function addWardsLayer(geo){
  const fixed={type:'FeatureCollection',features:(geo.features||[]).map(f=>({type:'Feature',
    properties:f.properties, geometry:{type:f.geometry.type, coordinates:_swapLL(f.geometry.coordinates)}}))};
  map.addSource('wards-src',{type:'geojson',data:fixed});
  map.addLayer({ id:'wards-line', type:'line', source:'wards-src',
    paint:{'line-color':'#475569','line-width':1.6,'line-opacity':0.8,'line-dasharray':[4,2]} });
  map.addLayer({ id:'wards-label', type:'symbol', source:'wards-src', minzoom:12,
    layout:{'text-field':['coalesce',['get','ward_lgd_name'],['to-string',['get','ward_lgd_code']]],'text-size':11},
    paint:{'text-color':'#1e293b','text-halo-color':'#fff','text-halo-width':1.6} });
}
async function initWards(){
  if(wardsLoaded||!map)return;
  try{ addWardsLayer(await fetch('/wards_gurugram.geojson').then(r=>r.json())); wardsLoaded=true; }
  catch(e){ console.warn('ward boundaries unavailable:',e); setTimeout(initWards,4000); }
}

document.getElementById('toggle3DBtn').addEventListener('click',()=>{
  is3DMode=!is3DMode;
  document.getElementById('toggle3DBtn').classList.toggle('active',!is3DMode);
  try{map.setPitch(is3DMode?60:0);}catch(e){}
});

// ── Building texture ──────────────────────────────────────────────────────────

// ── BOOT ──────────────────────────────────────────────────────────────────────
setStatus('Loading map SDK…');

// Start the heavy flood-data download right away so it overlaps with the SDK
// loads below instead of waiting for the map 'load' event.
prefetchData();

// Load three.js and the Mappls SDK in parallel rather than chaining them.
// boot3() (the water-surface build) needs three.js; if three.js finishes after
// the map's 'load' already fired, _lateThreeBoot retries the build.
let _lateThreeBoot=null;
loadThreeJS(()=>{ if(_lateThreeBoot)_lateThreeBoot(); });
loadMapplsSDK(()=>{
    setStatus('Initialising map…');

    try{
      map = new mappls.Map('map', {
        center: {lat:28.4595, lng:77.0266},
        zoom: 13, pitch: 0, bearing: 0,
        zoomControl: false, attributionControl: false,
        fullscreenControl: false   // we use our own bottom-right fullscreen button
      });
    }catch(e){
      setStatus('❌ Map init failed: ' + e.message);
      console.error(e);
      return;
    }

    document.getElementById('toggle3DBtn').classList.add('active');

    // Keep the GL canvas matched to its container. Entering/leaving fullscreen
    // (or toggling the sidebar) changes #map's size; without a resize the canvas
    // stays at the old width and the uncovered area shows as a black strip.
    if (window.ResizeObserver) {
      const _ro = new ResizeObserver(() => { try { map.resize(); } catch(e) {} });
      _ro.observe(document.getElementById('map'));
    }

    // Expose map for ES module features
    window._floodtwinMap = map;
    window.dispatchEvent(new CustomEvent('floodtwin:mapready', { detail: { map } }));

    let threeReady = false;
    function boot3(){
      if(threeReady||!window.THREE)return;threeReady=true;
      glMap=map;modelTransform=buildTransform();
      window.__map=map;window.__setStep=updateStep;   // debug hooks (camera/step control for headless verify)
      // Insert the water surface beneath the flood-road overlay so road
      // markings draw on top of the water.
      try{
        const beforeWater = map.getLayer('flooded-roads-fill') ? 'flooded-roads-fill' : undefined;
        map.addLayer(customLayer, beforeWater);
      }catch(e){console.warn('Layer add:',e);}
      initWards();                        // ward boundaries are a default base layer
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

          // Keep animating while flood water OR the drainage flow/manhole overlay is on.
          if(waterMeshes.length===0 && !drainEnabled && !perfEnabled)return;

          animClock+=dt;
          waterMeshes.forEach(m=>{if(m.material?.uniforms?.uTime)m.material.uniforms.uTime.value=animClock;});
          if(drainFlowMat)drainFlowMat.uniforms.uTime.value=animClock;   // water flowing along pipes
          if(mhWaterMat)mhWaterMat.uniforms.uTime.value=animClock;        // manhole water columns shimmer
          if(overflowRippleMat)overflowRippleMat.uniforms.uTime.value=animClock;   // overflow ripple rings expand
          if(drainSurfMat)drainSurfMat.uniforms.uTime.value=animClock;              // water-surface ripples
          if(drainCaseMat)drainCaseMat.uniforms.uTime.value=animClock;              // surcharge pulse in engineering view
          if(simState.viz)simState.viz.tick(animClock);                             // rich pipe module (casing/water/flow scroll)
          if(simState.floodMat)simState.floodMat.uniforms.uTime.value=animClock;    // SWE flood surface ripples
          if(drainEnabled)tickDrainFill(false);                           // ease the advancing water front
          if(perfEnabled)tickManholes(false);                             // shaft tracks the pipe below (capped until full)

          if(glMap)glMap.triggerRepaint();
        };
        rafId=requestAnimationFrame(loop);
      }
    }
    _lateThreeBoot=boot3;   // let a late-arriving three.js trigger the build
    map.on('load', boot3);
    map.on('style.load', ()=>{ boot3(); });
    setTimeout(()=>{if(!threeReady)boot3();}, 6000);

    let syncRaf=null;
    const scheduleMapSync=()=>{
      if(syncRaf)return;
      syncRaf=requestAnimationFrame(()=>{
        syncRaf=null;
        syncAllMarkers();
        syncBeacons();
        updateScaleBars();
      });
    };
    ['move','zoom','pitch','rotate','resize'].forEach(ev=>map.on(ev,scheduleMapSync));
    // Recompute flood hotspots after the viewport settles (new area in view).
    map.on('moveend',scheduleFloodSpots);

    map.on('load', ()=>{
      initSearch();
      removeAttribution();
      initializeVisualization();   // hides the overlay, then defers the asset fetch
      updateScaleBars();
      syncFullscreenState();
            initRoadOverlay();
    });

    setTimeout(()=>{
      if(document.getElementById('loadingProgress').textContent==='Initialising map…'){
        initSearch();removeAttribution();
        initializeVisualization();
        updateScaleBars();
        syncFullscreenState();
                initRoadOverlay();
      }
    }, 8000);
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

// Read-only debug handle: the IIFE hides all state, so headless verification
// (and console poking) needs an explicit window into it.
window.__floodtwin_debug={
  get map(){return map;},
  get drainConduits(){return drainConduits;},
  get drainMeshes(){return drainMeshes;},
  get drainAFill(){return drainAFill;},
  get drainTierVis(){return drainTierVis;},
  get drainTierStats(){return drainTierStats;},
  get drainLinkDyn(){return drainLinkDyn;},
  get simState(){return simState;},
  get useSimNetwork(){return useSimNetwork;},
  get simSurcharged(){return simSurchargedCount;},
  get drainEnabled(){return drainEnabled;},
  setDrainTierVisible,
  updateBasemapDim,
};

})();
