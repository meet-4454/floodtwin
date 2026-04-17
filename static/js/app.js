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

function loadHtml2Canvas(cb) {
  if (window.html2canvas) { cb(); return; }
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.async = true;
  s.onload = cb;
  s.onerror = function() { console.warn('html2canvas failed'); cb(); };
  document.head.appendChild(s);
}

const CHUNK_SIZE=10,TOTAL_CHUNKS=34,MAX_CACHED=3,TOTAL_STEPS=336;
const REF_LAT=28.4595,REF_LNG=77.0266;
const NOM_UA='FloodTwin/1.0';
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];

let map,glMap,scene,camera,renderer,modelTransform;
let currentStep=0,isPlaying=false,playInterval=null,playSpeed=500;
let floodOpacity=0.70,depthScale=1.0;
let waterMeshes=[],polygonCount=0,coordinatesBuffer=null;
let is3DMode=false;
const chunkCache=new Map(),chunkQueue=new Set();
let polygonRings=null;
let lastDepths=null;

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
  {max:0.5,label:'Low',bg:'#e6f7f9',color:'#0e7490',dot:'#6BC3D2'},
  {max:1.0,label:'Moderate',bg:'#cceef5',color:'#0369a1',dot:'#5298A9'},
  {max:2.0,label:'High',bg:'#b3dde8',color:'#155e75',dot:'#49879A'},
  {max:Infinity,label:'Severe',bg:'#264351',color:'#fff',dot:'#264351'}
];
const fpPopup=document.getElementById('floodPopup');
let fpLat=null,fpLng=null;
document.getElementById('fpClose').addEventListener('click',()=>{fpPopup.style.display='none';fpLat=fpLng=null;});

function repositionFloodPopup(){
  if(fpPopup.style.display==='none'||fpLat===null)return;
  try{const pt=map.project({lat:fpLat,lng:fpLng});fpPopup.style.left=pt.x+'px';fpPopup.style.top=(pt.y-14)+'px';}catch(e){}
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
  if(!document.body.contains(fpPopup))document.body.appendChild(fpPopup);
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
    const posUpdate=()=>{try{const pt=map.project({lat,lng});el.style.left=pt.x+'px';el.style.top=pt.y+'px';}catch(e){}};
    posUpdate();
    el.addEventListener('click',e=>{
      e.stopPropagation();document.querySelectorAll('.osm-popup').forEach(p=>p.remove());
      const pop=document.createElement('div');pop.className='osm-popup';
      pop.innerHTML=`<button class="popup-close">✕</button><div class="popup-name">${esc(name)}</div><div class="popup-type">${esc(cat.label)}</div>${addrLine?`<div class="popup-addr">${esc(addrLine)}</div>`:''}`;
      const pt=map.project({lat,lng});pop.style.left=pt.x+'px';pop.style.top=(pt.y-44)+'px';
      mapEl.appendChild(pop);
      const mv=()=>{try{const pt2=map.project({lat,lng});pop.style.left=pt2.x+'px';pop.style.top=(pt2.y-44)+'px';}catch(e){}};
      map.on('move',mv);
      pop.querySelector('.popup-close').addEventListener('click',()=>{pop.remove();try{map.off('move',mv);}catch(e){}});
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
  const upd=()=>{try{const p=map.project({lat,lng});el.style.left=p.x+'px';el.style.top=p.y+'px';}catch(e){}};
  upd();map.on('move',upd);
  const rm=()=>{el.remove();try{map.off('move',upd);}catch(e){}};
  currentPin=rm;setTimeout(()=>{if(currentPin===rm){rm();currentPin=null;}},10000);
}

// ── THREE.JS custom layer ─────────────────────────────────────────────────────
const VERT_SRC=`
uniform float uTime;attribute float aDepth;varying float vDepth;varying vec3 vWP;
void main(){vDepth=aDepth;vWP=position;
float r=sin(position.x*22000.+uTime*1.3)*.0000014+cos(position.z*28000.+uTime*.95)*.0000011;
vec3 p=position;p.y+=r*clamp(aDepth*.5,0.,2.);
gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`;

const FRAG_SRC=`
uniform float uTime;uniform float uOpacity;varying float vDepth;varying vec3 vWP;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.1+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
if(vDepth<=0.)discard;
vec2 uv=vWP.xz*26000.;float t=uTime*.16;
float wA=fbm(uv*1.05+vec2(t*.85,t*.60));
float wB=fbm(uv*.80+vec2(-t*.65,t*.75)+vec2(4.1,2.3));
float caustic=pow(1.-pow(abs(wA-wB),.5),3.5);
float d=clamp(vDepth/3.,0.,1.);
vec3 cS=vec3(.40,.87,.95),cM=vec3(.10,.52,.72),cD=vec3(.04,.22,.34);
vec3 base=d<.5?mix(cS,cM,d*2.):mix(cM,cD,(d-.5)*2.);
vec3 col=base+vec3(.8,.97,1.)*caustic*(.6-d*.4)+vec3(.9,.98,1.)*pow(clamp(sin(uv.x*.12-t*.28)*.5+.5,0.,1.),14.)*.18*(1.-d*.6);
gl_FragColor=vec4(col,uOpacity*smoothstep(0.,.06,vDepth));}`;

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
function startAnimLoop(){
  if(rafId)return;
  const loop=()=>{
    animClock+=0.016;
    waterMeshes.forEach(mesh=>{if(mesh.material?.uniforms?.uTime)mesh.material.uniforms.uTime.value=animClock;});
    if(glMap)glMap.triggerRepaint();
    rafId=requestAnimationFrame(loop);
  };
  rafId=requestAnimationFrame(loop);
}

function buildMesh(depths){
  if(!scene||!depths||!modelTransform||!window.THREE)return;
  waterMeshes.forEach(m=>{scene.remove(m);m.geometry?.dispose();m.material?.dispose();});
  waterMeshes=[];

  const dv=new DataView(coordinatesBuffer);
  const posArr=new Float32Array(polygonCount*6*3);
  const dptArr=new Float32Array(polygonCount*6);
  let vi=0,off=0;

  for(let p=0;p<polygonCount;p++){
    const pc=dv.getUint32(off,true);off+=4;
    const depth=depths[p];
    if(depth>0){
      let mnX=Infinity,mxX=-Infinity,mnZ=Infinity,mxZ=-Infinity;
      let ro=off;
      for(let i=0;i<pc;i++){
        const loc=toLocal(dv.getFloat64(ro,true),dv.getFloat64(ro+8,true));ro+=16;
        if(loc.x<mnX)mnX=loc.x;if(loc.x>mxX)mxX=loc.x;
        if(loc.z<mnZ)mnZ=loc.z;if(loc.z>mxZ)mxZ=loc.z;
      }
      posArr[vi*3]=mnX;posArr[vi*3+1]=0;posArr[vi*3+2]=mnZ;dptArr[vi]=depth;vi++;
      posArr[vi*3]=mxX;posArr[vi*3+1]=0;posArr[vi*3+2]=mnZ;dptArr[vi]=depth;vi++;
      posArr[vi*3]=mxX;posArr[vi*3+1]=0;posArr[vi*3+2]=mxZ;dptArr[vi]=depth;vi++;
      posArr[vi*3]=mnX;posArr[vi*3+1]=0;posArr[vi*3+2]=mnZ;dptArr[vi]=depth;vi++;
      posArr[vi*3]=mxX;posArr[vi*3+1]=0;posArr[vi*3+2]=mxZ;dptArr[vi]=depth;vi++;
      posArr[vi*3]=mnX;posArr[vi*3+1]=0;posArr[vi*3+2]=mxZ;dptArr[vi]=depth;vi++;
    }
    off+=pc*16;
  }
  if(vi===0)return;

  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(posArr.slice(0,vi*3),3));
  geo.setAttribute('aDepth',  new THREE.BufferAttribute(dptArr.slice(0,vi),1));

  const mat=new THREE.ShaderMaterial({
    uniforms:{uTime:{value:animClock},uOpacity:{value:floodOpacity}},
    vertexShader:VERT_SRC,fragmentShader:FRAG_SRC,
    transparent:true,side:THREE.DoubleSide,depthWrite:false
  });
  const mesh=new THREE.Mesh(geo,mat);
  scene.add(mesh);waterMeshes.push(mesh);
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
  currentStep=step;buildMesh(depths);
  fpPopup.style.display='none';fpLat=fpLng=null;
  const nc=Math.floor(step/CHUNK_SIZE)+1;
  if(nc<TOTAL_CHUNKS&&!chunkCache.has(nc)&&!chunkQueue.has(nc))loadChunk(nc).catch(()=>{});
  const b=new Date('2025-07-09T01:55:00');b.setMinutes(b.getMinutes()+step*5);
  const z=n=>String(n).padStart(2,'0');
  document.getElementById('timeDisplay').textContent=`${z(b.getDate())}-${MONTHS[b.getMonth()]}-${b.getFullYear()} ${z(b.getHours())}:${z(b.getMinutes())}:${z(b.getSeconds())}`;
  const sl=document.getElementById('timeSlider');sl.value=step;
  sl.style.background=`linear-gradient(to right,#5298A9 ${(step/TOTAL_STEPS*100)}%,#e2e8f0 ${(step/TOTAL_STEPS*100)}%)`;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── SCREENSHOT / EXPORT FEATURE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

let exportFormat = 'png';
let lastDataUrl = null;

document.querySelectorAll('.fmt-pill').forEach(p => {
  p.addEventListener('click', () => {
    document.querySelectorAll('.fmt-pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    exportFormat = p.dataset.fmt;
    document.getElementById('exportFormatBadge').textContent = exportFormat.toUpperCase();
  });
});

document.getElementById('previewWrap').addEventListener('click', () => {
  if(lastDataUrl) triggerDownload(lastDataUrl, exportFormat);
});

function setCaptureStatus(msg, color='#5298A9') {
  const el = document.getElementById('captureStatus');
  el.textContent = msg;
  el.style.color = color;
}

function triggerDownload(dataUrl, fmt) {
  const a = document.createElement('a');
  const ts = document.getElementById('timeDisplay').textContent.replace(/[\s:]/g,'-');
  a.download = `floodtwin_${ts}.${fmt}`;
  a.href = dataUrl;
  a.click();
}

function flashScreen() {
  const fl = document.getElementById('captureFlash');
  fl.classList.remove('flash');
  void fl.offsetWidth;
  fl.classList.add('flash');
}

function computeFloodStats(depths) {
  if (!depths) return { low:0, mod:0, high:0, severe:0, total:0, wetPct:'0' };
  let low=0, mod=0, high=0, severe=0, wet=0;
  for (let i=0; i<depths.length; i++) {
    const d = depths[i];
    if (d <= 0) continue;
    wet++;
    if (d < 0.5) low++;
    else if (d < 1.0) mod++;
    else if (d < 2.0) high++;
    else severe++;
  }
  const total = depths.length;
  return { low, mod, high, severe, total, wet, wetPct: total ? (wet/total*100).toFixed(1) : '0' };
}

function populateStatsCard(stats) {
  document.getElementById('scTime').textContent = '⏱ ' + document.getElementById('timeDisplay').textContent;
  const fmt = n => n.toLocaleString();
  document.getElementById('scLow').textContent    = fmt(stats.low)    + ' zones';
  document.getElementById('scMod').textContent    = fmt(stats.mod)    + ' zones';
  document.getElementById('scHigh').textContent   = fmt(stats.high)   + ' zones';
  document.getElementById('scSevere').textContent = fmt(stats.severe) + ' zones';
}

async function captureMap() {
  const btn = document.getElementById('captureBtn');
  const icon = document.getElementById('captureBtnIcon');
  const txt  = document.getElementById('captureBtnText');
  btn.disabled = true;
  icon.textContent = '⏳';
  txt.textContent = 'Capturing…';
  setCaptureStatus('Preparing export…');

  const optStats     = document.getElementById('optStats').checked;
  const optTimestamp = document.getElementById('optTimestamp').checked;
  const optLegend    = document.getElementById('optLegend').checked;
  const optWatermark = document.getElementById('optWatermark').checked;
  const fmt          = exportFormat;
  const quality      = fmt === 'jpg' ? 0.92 : 1.0;
  const mimeType     = fmt === 'jpg' ? 'image/jpeg' : 'image/png';

  try {
    setCaptureStatus('Reading map canvas…');
    const mapCanvas = document.querySelector('#map canvas');
    if (!mapCanvas) throw new Error('Map canvas not found');

    if (glMap) try { glMap.triggerRepaint(); } catch(e) {}
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const W = mapCanvas.width  || window.innerWidth;
    const H = mapCanvas.height || window.innerHeight;

    const canvas = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(mapCanvas, 0, 0, W, H);

    if (optLegend && window.html2canvas) {
      setCaptureStatus('Rendering legend…');
      const legendEl = document.getElementById('legend');
      try {
        const legendCanvas = await html2canvas(legendEl, {
          backgroundColor: null, scale: 2, logging: false,
          useCORS: true, allowTaint: true
        });
        const lw = legendCanvas.width  / 2;
        const lh = legendCanvas.height / 2;
        const margin = 28;
        ctx.drawImage(legendCanvas, margin, H - lh - margin, lw, lh);
      } catch(e) { console.warn('legend capture failed', e); }
    }

    if (optStats && window.html2canvas) {
      setCaptureStatus('Rendering stats card…');
      const stats = computeFloodStats(lastDepths);
      populateStatsCard(stats);
      const statsEl = document.getElementById('statsCard');
      statsEl.style.position = 'fixed';
      statsEl.style.left = '-3000px';
      statsEl.style.top  = '50px';
      statsEl.style.display = 'block';
      try {
        const sc = await html2canvas(statsEl, {
          backgroundColor: null, scale: 2, logging: false,
          useCORS: true, allowTaint: true
        });
        const sw = sc.width  / 2;
        const sh = sc.height / 2;
        const margin = 28;
        ctx.drawImage(sc, W - sw - margin, H - sh - margin - 80, sw, sh);
      } catch(e) { console.warn('stats card capture failed', e); }
      statsEl.style.position = 'fixed';
      statsEl.style.left = '-9999px';
      statsEl.style.top  = '-9999px';
    }

    if (optTimestamp) {
      const ts = document.getElementById('timeDisplay').textContent;
      const pad = 16;
      ctx.save();
      ctx.font = 'bold 15px "Segoe UI", system-ui, sans-serif';
      const tw = ctx.measureText(ts).width;
      const rx = W - tw - pad*2 - 20;
      const ry = 20;
      const rw = tw + pad*2;
      const rh = 38;
      ctx.fillStyle = 'rgba(38,67,81,0.88)';
      ctx.beginPath();
      ctx.roundRect(rx, ry, rw, rh, 10);
      ctx.fill();
      ctx.fillStyle = '#B1DEE2';
      ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('FLOOD TWIN · AIRESQ', rx + pad, ry + 15);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(ts, rx + pad, ry + 29);
      ctx.restore();
    }

    if (optWatermark) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.font = 'bold 13px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4;
      ctx.fillText('airesq.com · FloodTwin', W - 12, H - 12);
      ctx.restore();
    }

    setCaptureStatus('Encoding image…');
    const dataUrl = canvas.toDataURL(mimeType, quality);
    lastDataUrl = dataUrl;

    flashScreen();
    triggerDownload(dataUrl, fmt);

    const prev = document.getElementById('previewImg');
    prev.src = dataUrl;
    document.getElementById('previewWrap').style.display = 'block';

    setCaptureStatus(`✅ Saved as .${fmt.toUpperCase()}`, '#10b981');

  } catch(err) {
    console.error('Capture error:', err);
    setCaptureStatus('❌ Capture failed: ' + err.message, '#ef4444');
  } finally {
    btn.disabled = false;
    icon.textContent = '📸';
    txt.textContent = 'Capture Map';
  }
}

document.getElementById('captureBtn').addEventListener('click', captureMap);

// ── UI controls ───────────────────────────────────────────────────────────────
function removeAttribution(){
  ['.mappls-copyright','.maplibregl-ctrl-attrib','.mappls-ctrl-attrib','.maplibregl-ctrl-bottom-left','.maplibregl-ctrl-bottom-right','.mappls-ctrl-bottom-left','.mappls-ctrl-bottom-right'].forEach(sel=>document.querySelectorAll(sel).forEach(el=>{el.style.cssText='display:none!important';}));
}
setInterval(removeAttribution,2000);

function toggleSidebar(){
  const sb=document.getElementById('sidebar'),ham=document.getElementById('hamburgerBtn'),chv=document.getElementById('collapseBtn');
  const c=sb.classList.toggle('collapsed');ham.classList.toggle('open',!c);chv.innerHTML=c?'›':'‹';
}
document.getElementById('hamburgerBtn').addEventListener('click',toggleSidebar);
document.getElementById('collapseBtn').addEventListener('click',toggleSidebar);
document.getElementById('timeSlider').addEventListener('input',e=>updateStep(+e.target.value));

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
  loadHtml2Canvas(()=>{
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

      ['move','zoom','pitch','rotate'].forEach(ev=>map.on(ev,syncAllMarkers));

      map.on('load', ()=>{
        initSearch();
        loadAllAssets();
        removeAttribution();
        initializeVisualization();
      });

      setTimeout(()=>{
        if(document.getElementById('loadingProgress').textContent==='Initialising map…'){
          initSearch();loadAllAssets();removeAttribution();
          initializeVisualization();
        }
      }, 8000);
    });
  });
});

})();
