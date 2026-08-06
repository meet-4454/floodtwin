import{r as Zt}from"./index-Diq9ICiP.js";import"./react-C4xND61i.js";const ta=[{key:"trunk",label:"Trunk main",min:1,color:[.96,.49,.2]},{key:"main",label:"Branch main",min:.25,color:[.16,.55,.86]},{key:"lateral",label:"Lateral",min:0,color:[.28,.74,.82]}],aa=f=>f>=1?0:f>=.25?1:2,ke=14,jt=.95,ra=3.7,oa=3.5,sa=[{key:"storm",label:"Storm conduits",color:[.2,.62,.9]},{key:"sewer",label:"Sewer conduits",color:[.55,.38,.78]},{key:"unclassified",label:"Unclassified",color:[.45,.52,.58]}],na=[0,13.2,15],Kt=`
// ── IN-PIPE WATER COLOUR ────────────────────────────────────────────────────
// A water-blue gradient keyed on METRES OF WATER ÷ uWaterRef, not on the surface
// flood's own precipitation ramp. Sharing that ramp made a running conduit magenta/orange,
// which read as an alarm state rather than as water. Blue says "this is water";
// the ramp still says "how much" because it is strictly MONOTONIC — pale for a
// few centimetres, deep blue at the reference depth. Keying it on metres rather
// than on each pipe's own percentage is what makes a deep drain holding 2 m read
// as more water than a shallow one holding 0.5 m (it used to read as less).
vec3 pipeWater(float f){
  vec3 a = vec3(0.847, 0.949, 0.996);   // #D8F2FE  barely wet
  vec3 b = vec3(0.596, 0.839, 0.965);   // #98D6F6
  vec3 c = vec3(0.376, 0.667, 0.902);   // #60AAE6
  vec3 d = vec3(0.216, 0.478, 0.769);   // #377AC4  running full
  vec3 col = mix(a, b, smoothstep(0.02, 0.35, f));
  col = mix(col, c, smoothstep(0.30, 0.72, f));
  col = mix(col, d, smoothstep(0.66, 1.0, f));
  return col;
}
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float v = 0.5*noise(p); p = p*2.1 + vec2(1.7,9.2); return v + 0.25*noise(p); }
// Interference of two advected noise fields — the same construction the surface
// sheet uses for its caustic web.
float caustics(vec2 a, vec2 b){
  float nA = fbm(a), nB = fbm(b);
  return pow(clamp(1.0 - abs(nA - nB), 0.0, 1.0), 8.0);
}`,ia=`
  attribute float aTier; attribute float aClass;
  attribute float aWaterM; attribute float aWaterMPrev; attribute float aU;
  attribute float aRad; attribute float aNRad;
  uniform vec3 uTierCol[3]; uniform float uTierOn[3];
  uniform vec3 uClassCol[3]; uniform float uClassOn[3];
  uniform float uMix; uniform float uClassTint; uniform float uWaterRef;
  varying vec3 vN; varying float vNy; varying vec3 vTC; varying float vFill;
  varying float vOn; varying float vDepthY;
  void main(){
    vN = normalize(normalMatrix*normal); vNy = normal.y;
    int t = int(aTier+0.5); int c = int(aClass+0.5);
    // Tier drives the size read, class drives the WHAT-IS-IT read; blend so both
    // survive. Storm stays blue, sewer violet — matching the 2-D sewer layer.
    vTC = mix(uTierCol[t], uClassCol[c], uClassTint);
    vOn = uTierOn[t] * uClassOn[c];
    // HOW FULL THIS BORE IS — the same quantity the water body clips against, so
    // the dry-bore shadow and the waterline always agree. (The capacity view
    // ramps on this too, which is what a capacity ramp should mean.)
    float wm = mix(aWaterMPrev, aWaterM, uMix);
    float rise = clamp(wm / max(uWaterRef, 0.01), 0.0, 1.0) * 2.0 * aNRad;
    vFill = clamp(rise / max(2.0*aRad, 0.001), 0.0, 1.0);
    vDepthY = position.y;
    gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
  }`,la=`
  precision highp float;
  uniform float uMode, uTime;              // uMode 0 = water view, 1 = capacity view
  varying vec3 vN; varying float vNy; varying vec3 vTC; varying float vFill;
  varying float vOn; varying float vDepthY;
  void main(){
    if(vOn < 0.5) discard;
    // Aerial perspective, underground: the further below the street a conduit
    // sits the more it recedes. This is the strongest cue that the network has
    // real vertical extent rather than being a flat diagram lying under the map.
    float depthFog = clamp(1.0 + vDepthY*0.022, 0.42, 1.0);
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
    float fres = pow(1.0 - abs(dot(N, vec3(0.0,1.0,0.0))), 3.0);
    // BARREL SHADING. Facet count alone never reads as round — what the eye uses
    // is the gradient ACROSS the section: a bright band where the surface faces
    // the light, falling to a dark terminator as it curves away.
    vec3 Lp = normalize(vec3(0.35, 0.86, 0.38));
    float lam = max(dot(N, Lp), 0.0);
    vec3 col = vTC*(0.40 + 0.60*nl) + fres*0.45;
    col += vec3(1.0, 0.99, 0.95) * pow(lam, 2.2) * 0.32;   // crown highlight
    col *= (1.0 - pow(1.0 - lam, 2.5) * 0.34);              // shade the far side
    // Dry bore: a touch of shadow on the airspace above the waterline so an
    // empty pipe reads as EMPTY rather than as absent.
    float level = 2.0*f - 1.0;
    float air = step(level, vNy);
    float a = (0.17 + fres*0.30 + air*0.10) * (0.55 + 0.45*depthFog);
    col = mix(col, col*0.55, air*0.5);
    col *= depthFog;
    gl_FragColor = vec4(col, a);
  }`,ca=`
  attribute float aTier; attribute float aClass;
  attribute float aWaterM; attribute float aWaterMPrev; attribute float aU;
  attribute float aFlow; attribute float aRad; attribute float aNRad;
  uniform float uMix; uniform float uTierOn[3]; uniform float uClassOn[3];
  uniform float uWaterRef;
  varying float vNy; varying float vFill; varying float vFull; varying float vU; varying float vOn;
  varying vec3 vN; varying float vFlow; varying vec3 vW;
  varying float vDepthY;
  void main(){
    // vFill = water depth in METRES against the global reference — the colour key.
    // vFull = how full THIS conduit is, from the node-shared water surface height.
    float wm = mix(aWaterMPrev, aWaterM, uMix);
    vFill = clamp(wm / max(uWaterRef, 0.01), 0.0, 1.0);
    float rise = vFill * 2.0 * aNRad;              // height above the invert
    vFull = clamp(rise / max(2.0 * aRad, 0.001), 0.0, 1.0);
    vNy = normal.y; vU = aU; vFlow = aFlow;
    vDepthY = position.y;
    vOn = uTierOn[int(aTier+0.5)] * uClassOn[int(aClass+0.5)];
    vN = normalize(normalMatrix*normal);
    vec3 p = position - normal*0.06;   // sit just inside the casing, no z-fight
    vW = p;
    gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0);
  }`,ua=`
  precision highp float;
  uniform float uTime;
  varying float vNy; varying float vFill; varying float vFull; varying float vU; varying float vOn;
  varying vec3 vN; varying float vFlow; varying vec3 vW;
  varying float vDepthY;
  ${Kt}
  void main(){
    if(vOn < 0.5) discard;
    float f = clamp(vFill,0.0,1.0);       // metres of water ÷ global reference
    if(f < 0.005) discard;                // dry pipe → only the ghost casing
    // The waterline sits where the node's water SURFACE cuts this bore; a conduit
    // narrower than the shared radius is simply submerged to its crown.
    float level = 2.0*vFull - 1.0;
    // Anti-alias the clip against the radial normal's screen gradient, so the
    // waterline follows the bore smoothly instead of stepping ring to ring.
    float aa = max(fwidth(vNy), 1e-4);
    if(vNy > level + aa) discard;         // above the waterline = air

    vec3 N = normalize(vN);
    float lam = max(dot(N, normalize(vec3(0.35,0.86,0.38))), 0.0);
    float nl = 0.55 + 0.45*lam;

    vec3 col = pipeWater(f);
    // Curve the water body across the section too, so a full bore reads as a
    // filled cylinder rather than a flat-topped slab.
    col *= (1.0 - pow(1.0 - lam, 2.6) * 0.30);
    col += vec3(0.85,0.95,1.0) * pow(lam, 3.0) * 0.16;
    float below = clamp((level - vNy)*0.5, 0.0, 1.0);
    col *= (1.0 - below*0.20);                      // gentle shading for roundness

    // CAUSTICS, advected downstream at the solved velocity — the same web the
    // 2-D sheet draws, so surface and sub-surface water read as one substance.
    float spd = abs(vFlow), sgn = sign(vFlow);
    float scroll = uTime*(0.8 + spd*4.8)*sgn;
    vec2 ca = vec2(vU*0.30 - scroll*1.4, (vW.x+vW.z)*0.26);
    vec2 cb = vec2(vU*0.46 - scroll*2.1, (vW.x-vW.z)*0.20 + 3.0);
    float caus = caustics(ca, cb);
    // Brightest just under the surface, as real caustics are.
    col += vec3(0.55,0.88,1.0) * caus * 0.62 * (1.0 - below);
    // the same packet train as the surface, so bore and surface move together
    float pkv = fract(vU*0.045 - uTime*(0.42 + spd*1.5)*sgn);
    col += vec3(0.5,0.8,1.0) * smoothstep(0.92,1.0,pkv)*smoothstep(1.0,0.97,pkv) * 0.22 * (1.0-below);

    // A meniscus so the WATER LINE itself is visible — the single strongest cue
    // for "how full is this pipe" — but wide and soft, so it reads as a curved
    // surface meeting the barrel rather than a drawn-on line.
    float edge = 1.0 - smoothstep(0.0, 0.20, level - vNy);
    col = mix(col, vec3(0.95,0.99,1.0), edge*0.42);

    float pres = smoothstep(0.96,1.0,vFull);        // running full → warm alarm
    col = mix(col, vec3(0.96,0.44,0.25), pres*(0.45+0.15*sin(uTime*5.0)));
    col *= clamp(1.0 + vDepthY*0.016, 0.55, 1.0);   // recede with burial depth
    gl_FragColor = vec4(col*nl, 1.0);
  }`,fa=`
  attribute vec3 aPerp; attribute float aSide; attribute float aCenterY;
  attribute float aRad; attribute float aNRad;
  attribute float aWaterM; attribute float aWaterMPrev; attribute float aU;
  attribute float aFlow; attribute float aTier; attribute float aClass;
  uniform float uMix; uniform float uTime; uniform float uTierOn[3]; uniform float uClassOn[3];
  uniform float uWaterRef;
  varying float vFill; varying float vFull; varying float vU; varying float vFlow; varying vec3 vW;
  varying float vOn; varying float vChord;
  void main(){
    vOn = uTierOn[int(aTier+0.5)] * uClassOn[int(aClass+0.5)];
    vChord = aSide;
    // Metres of water ÷ the global reference, raised from the invert through the
    // radius SHARED by every conduit at this node, then clipped to this bore. Two
    // pipes meeting at a manhole therefore agree on the water surface exactly.
    float f = clamp(mix(aWaterMPrev, aWaterM, uMix) / max(uWaterRef, 0.01), 0.0, 1.0);
    float rise = clamp(f*2.0*aNRad, 0.0, 2.0*aRad);
    vFull = clamp(rise / max(2.0*aRad, 0.001), 0.0, 1.0);
    float waterY = aCenterY - aRad + rise;
    float dy = waterY - aCenterY;
    float halfW = sqrt(max(0.0, aRad*aRad - dy*dy))*0.92;
    // travelling waves — amplitude grows with flow speed, like the 2-D sheet
    float spd = abs(aFlow);
    float wave = sin(aU*0.5 - uTime*(1.0+spd*4.0)*sign(aFlow)) * (0.06 + spd*0.18)
               + sin(aU*1.3 + uTime*1.7) * 0.04;
    // A bore running full is pressurised — no free surface, so no ripple.
    waterY += wave * f * (1.0 - smoothstep(0.90, 1.0, vFull));
    vec3 wp = vec3(position.x + aPerp.x*aSide*halfW, waterY, position.z + aPerp.z*aSide*halfW);
    vFill=f; vU=aU; vFlow=aFlow; vW=wp;
    gl_Position = projectionMatrix*modelViewMatrix*vec4(wp,1.0);
  }`,va=`
  precision highp float;
  uniform float uTime;
  varying float vFill; varying float vFull; varying float vU; varying float vFlow; varying vec3 vW;
  varying float vOn; varying float vChord;
  ${Kt}
  void main(){
    if(vOn < 0.5) discard;
    if(vFill < 0.005) discard;
    float spd = abs(vFlow), sgn = sign(vFlow);
    // FLOW-MAP scroll. A minimum rate matters: at low flow the old 0.35 base
    // read as standing water, and a storm drain that never moves looks broken
    // even when the solver says the flow is small.
    float scroll = uTime*(0.9 + spd*5.2)*sgn;
    vec2 uv1 = vec2(vU*0.11 - scroll,       (vW.x+vW.z)*0.16);
    vec2 uv2 = vec2(vU*0.21 - scroll*1.6,   (vW.x-vW.z)*0.12 + 2.0);
    // animated normal from noise gradients → ripples
    float e = 0.10;
    float hx = (noise(uv1+vec2(e,0.))-noise(uv1-vec2(e,0.))) + 0.7*(noise(uv2+vec2(e,0.))-noise(uv2-vec2(e,0.)));
    float hz = (noise(uv1+vec2(0.,e))-noise(uv1-vec2(0.,e))) + 0.7*(noise(uv2+vec2(0.,e))-noise(uv2-vec2(0.,e)));
    vec3 N = normalize(vec3(-hx*3.4, 1.0, -hz*3.4));
    vec3 V = normalize(cameraPosition - vW);
    vec3 L = normalize(vec3(0.4, 0.9, 0.35));
    float fres = 0.03 + 0.97*pow(1.0 - max(dot(N,V),0.0), 5.0);
    float glint = pow(max(dot(reflect(-L,N),V),0.0), 80.0);

    vec3 water = pipeWater(vFill);

    // the surface flood's caustic web, on the pipe's water surface
    float caus = caustics(uv1*2.2, uv2*1.7);
    water += vec3(0.6,0.9,1.0) * caus * 0.30;

    // travelling crests advecting downstream
    float crest = smoothstep(0.68, 1.0, sin(vU*0.7 - uTime*(2.6+spd*6.0)*sgn)*0.5+0.5 + (noise(uv1)-0.5)*0.6);
    water += vec3(0.85,0.95,1.0)*crest*0.26;
    // FLOW PACKETS: discrete bright pulses running downstream. Continuous noise
    // alone reads as shimmer; you need something with an edge to actually see
    // which way the water is going and how fast.
    float pk = fract(vU*0.045 - uTime*(0.42 + spd*1.5)*sgn);
    float packet = smoothstep(0.90, 1.0, pk) * smoothstep(1.0, 0.965, pk);
    water += vec3(0.75,0.93,1.0) * packet * (0.30 + spd*0.5);

    // The chord is WIDEST at exactly half-full, so an undamped sky wash puts the
    // palest pixels on screen at mid-fill and a half-full pipe reads as fuller
    // than a full one. Damp the highlight as the pipe fills.
    float bright = (1.0 - vFull*0.55) * (1.0 - smoothstep(0.5, 1.0, abs(vChord))*0.75);
    water = mix(water, mix(water, vec3(0.88,0.95,1.0), 0.7), fres*0.24*bright);
    water += vec3(1.0,0.98,0.92)*glint*bright;
    float turb = smoothstep(0.22, 0.8, spd) * step(0.015, spd);
    float foam = smoothstep(0.5, 1.0, noise(vec2(vU*0.4 - scroll*2.2, (vW.x+vW.z)*0.5)));
    water = mix(water, vec3(0.96,0.99,1.0), foam*turb*0.7*bright);
    float pres = smoothstep(0.9,1.0,vFull);
    water = mix(water, vec3(0.97,0.42,0.24), pres*(0.35+0.15*sin(uTime*5.0)));
    water = mix(water, vec3(1.0), pres*foam*0.5);
    // ── EDGE SHAPING ──────────────────────────────────────────────────────
    // The surface is a flat chord across a round bore. Left flat-shaded it read
    // as a plate laid on top of the pipe, with a hard straight cut where it met
    // the wall. Rolling the shading off toward the chord ends — darker, less
    // specular, tending to the submerged colour — makes the surface tuck into
    // the barrel, so the water reads as filling a cylinder.
    float edge = abs(vChord);
    float roll = smoothstep(0.55, 1.0, edge);
    water = mix(water, pipeWater(vFill) * 0.62, roll * 0.85);
    water *= 1.0 - roll * 0.18;
    gl_FragColor = vec4(water, 1.0);
  }`;function ha(f,q,fe){const N=new Map,t=(u,v)=>{let w=N.get(u);w||(w=[],N.set(u,w)),w.push(v)};for(let u=0;u<f.length;u++){const v=f[u];t(q[v],{k:u,other:fe[v]}),t(fe[v],{k:u,other:q[v]})}const g=u=>(N.get(u)||[]).length,L=new Uint8Array(f.length),ve=[],he=(u,v)=>{const w=[u],y=[];let S=v,xe=0;for(;S&&!L[S.k]&&xe++<1e5;){L[S.k]=1,y.push(S.k),w.push(S.other);const i=S.other;if(g(i)!==2)break;const A=N.get(i),O=A[0].k===S.k?A[1]:A[0];if(!O||L[O.k])break;S=O}y.length&&ve.push({nodes:w,slots:y})};for(const[u,v]of N)if(v.length!==2)for(const w of v)L[w.k]||he(u,w);for(let u=0;u<f.length;u++)if(!L[u]){const v=f[u];he(q[v],{k:u,other:fe[v]})}return ve}const da=`
  attribute float aRise; attribute float aRisePrev; attribute float aSurch; attribute float aBaseY;
  uniform float uMix;
  varying float vY; varying float vTop; varying float vSurch; varying float vBaseY;
  void main(){
    float r = mix(aRisePrev, aRise, uMix);
    vSurch = aSurch; vBaseY = aBaseY;
    // Surcharging nodes are, by definition, at or above the rim.
    float top = mix(aBaseY, 0.05, clamp(r + aSurch*0.35, 0.0, 1.0));
    vTop = top;
    vec3 p = position;
    // The column's own top vertices ride the water level; the base stays put.
    if(p.y > aBaseY + 0.001) p.y = top;
    vY = p.y;
    gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0);
  }`,pa=`
  precision highp float;
  uniform float uTime;
  varying float vY; varying float vTop; varying float vSurch; varying float vBaseY;
  void main(){
    if(vTop <= vBaseY + 0.02) discard;               // dry shaft
    float depthFrac = clamp((vTop - vY) / max(vTop - vBaseY, 0.01), 0.0, 1.0);
    vec3 calm = mix(vec3(0.596,0.839,0.965), vec3(0.216,0.478,0.769), depthFrac);
    vec3 alarm = vec3(0.965,0.478,0.259);
    vec3 col = mix(calm, alarm, vSurch*(0.62 + 0.18*sin(uTime*4.0)));
    // brighten the meniscus at the top of the column
    col = mix(col, vec3(0.95,0.99,1.0), (1.0 - smoothstep(0.0, 0.35, vTop - vY))*0.45);
    gl_FragColor = vec4(col, 0.88);
  }`;function ma(f,q,fe,N,t){if(!q.length)return null;const g=6,L=.26,ve=.46,he=(g+1)*4,u=q.length*he,v=new Float32Array(u*3),w=new Float32Array(u*3),y=new Uint32Array(q.length*g*6*2),S=new Float32Array(g+1),xe=new Float32Array(g+1);for(let Y=0;Y<=g;Y++){const P=Y/g*Math.PI*2;S[Y]=Math.cos(P),xe[Y]=Math.sin(P)}let i=0,A=0,O=0;for(const Y of q){const P=fe[Y],re=t[Y],$e=N[Y];for(let h=0;h<2;h++){const _=h?0:$e;for(let V=0;V<=g;V++){const W=S[V]*L,se=xe[V]*L;v[i]=P+W,v[i+1]=_,v[i+2]=re+se;const pe=1/(Math.hypot(W,se)||1);w[i]=W*pe,w[i+1]=0,w[i+2]=se*pe,i+=3}}for(let h=0;h<2;h++){const _=h?ve:L;for(let V=0;V<=g;V++)v[i]=P+S[V]*_,v[i+1]=.15,v[i+2]=re+xe[V]*_,w[i]=0,w[i+1]=1,w[i+2]=0,i+=3}const oe=O,Me=O+(g+1),x=O+(g+1)*2,Fe=O+(g+1)*3;for(let h=0;h<g;h++)y[A++]=oe+h,y[A++]=Me+h,y[A++]=oe+h+1,y[A++]=oe+h+1,y[A++]=Me+h,y[A++]=Me+h+1,y[A++]=x+h,y[A++]=Fe+h,y[A++]=x+h+1,y[A++]=x+h+1,y[A++]=Fe+h,y[A++]=Fe+h+1;O+=he}const H=new f.BufferGeometry;H.setAttribute("position",new f.BufferAttribute(v,3)),H.setAttribute("normal",new f.BufferAttribute(w,3)),H.setIndex(new f.BufferAttribute(y,1));const de=new f.MeshLambertMaterial({color:9148067,transparent:!0,opacity:.3,side:f.DoubleSide,depthWrite:!1}),M=new f.Mesh(H,de);return M.frustumCulled=!1,M}function ya(f,q,{vexag:fe=oa,waterRef:N=0}={}){const{THREE:t,scene:g,toLocal:L}=f,{nodeLon:ve,nodeLat:he,nodeMax:u,linkFrom:v,linkTo:w,linkPeak:y,linkClass:S,nodeClass:xe}=q,i=ve.length,A=v.length;if(!(N>0)){const e=Float32Array.from(u).sort();N=Math.max(.5,e[e.length>>1]||1.5)}const O=new Float32Array(i),H=new Float32Array(i),de=new Float32Array(i);for(let e=0;e<i;e++){const s=L(ve[e],he[e]);O[e]=s.x,H[e]=s.z,de[e]=-Math.min(Math.max(u[e],.3),12)*fe}const M=new Array(A);for(let e=0;e<A;e++)M[e]=e;const Y=new Map;for(let e=0;e<M.length;e++)Y.set(M[e],e);const P=ha(M,v,w),re=new Int32Array(i);for(let e=0;e<M.length;e++)re[v[M[e]]]++,re[w[M[e]]]++;const $e=Math.cos(7*Math.PI/180),oe=[];let Me=0,x=0,Fe=0;for(const e of P){const s=e.nodes,p=e.slots,b=s.length,l=[],n=[],m=[],I=[],E=[];for(let o=0;o<b;o++){const U=s[o];l.push(O[U]),n.push(de[U]),m.push(H[U]),I.push(U),E.push(Y.get(M[p[Math.min(o,p.length-1)]]))}const a=(o,U)=>{const J=l[U]-l[o],ee=n[U]-n[o],r=m[U]-m[o],R=Math.hypot(J,ee,r);if(R<1e-4)return;const D=Math.min(1.5,R*.34);l[o]+=J/R*D,n[o]+=ee/R*D,m[o]+=r/R*D};l.length>1&&(re[I[0]]>=3&&a(0,1),re[I[l.length-1]]>=3&&a(l.length-1,l.length-2));const d=[l[0]],c=[n[0]],z=[m[0]],G=[I[0]],Ae=[E[0]];for(let o=1;o<l.length-1;o++){const U=l[o]-d[d.length-1],J=n[o]-c[c.length-1],ee=m[o]-z[z.length-1],r=l[o+1]-l[o],R=n[o+1]-n[o],D=m[o+1]-m[o],te=Math.hypot(U,J,ee),ae=Math.hypot(r,R,D);te>1e-5&&ae>1e-5&&(U*r+J*R+ee*D)/(te*ae)>$e||(d.push(l[o]),c.push(n[o]),z.push(m[o]),G.push(I[o]),Ae.push(E[o]))}if(l.length>1){const o=l.length-1;d.push(l[o]),c.push(n[o]),z.push(m[o]),G.push(I[o]),Ae.push(E[o])}oe.push({xs:d,ys:c,zs:z,nds:G,sls:Ae,slots:p}),Me+=d.length,x+=d.length*2,Fe+=d.length-1}const h=new Float32Array(P.length),_=new Float32Array(i);for(let e=0;e<P.length;e++){let s=0;for(const b of P[e].slots)s=Math.max(s,y[M[b]]);const p=Math.min(ra,jt+Math.log10(1+s*12)*1.7);h[e]=p;for(const b of oe[e].nds)p>_[b]&&(_[b]=p)}for(let e=0;e<i;e++)_[e]===0&&(_[e]=jt);const V=ke+1,W=Me*V,se=new Float32Array(W*3),pe=new Float32Array(W*3),ut=new Uint8Array(W),ft=new Uint8Array(W),vt=new Float32Array(W),Qe=new Float32Array(W),ht=new Float32Array(W),dt=new Float32Array(W),pt=new Float32Array(W),mt=new Float32Array(W),Je=new Uint32Array(W),wt=new Uint32Array(W);let gt=0;for(const e of oe)gt+=(e.xs.length-1)*ke;const me=new Uint32Array(gt*6),Le=new Float32Array(x*3),_e=new Float32Array(x*3),yt=new Float32Array(x),bt=new Float32Array(x),At=new Float32Array(x),xt=new Float32Array(x),Mt=new Float32Array(x),et=new Float32Array(x),Ft=new Float32Array(x),Tt=new Float32Array(x),Wt=new Uint8Array(x),Ct=new Uint8Array(x),tt=new Uint32Array(x),Rt=new Uint32Array(x),we=new Uint32Array(Fe*6),Ee=new Float32Array(V),Ge=new Float32Array(V);for(let e=0;e<=ke;e++){const s=e/ke*Math.PI*2;Ee[e]=Math.cos(s),Ge[e]=Math.sin(s)}const $t=new t.Vector3(0,1,0),X=new t.Vector3,qe=new t.Vector3,C=new t.Vector3,K=new t.Vector3,ze=new t.Vector3,at=new t.Vector3,Pe=new t.Vector3,Qt=new t.Vector3,Jt=new t.Vector3(1,0,0);let ge=0,Te=0,$=0,T=0,We=0;const St=[0,0,0],Ot=[0,0,0];for(let e=0;e<P.length;e++){const s=P[e],p=oe[e],b=s.slots,l=p.xs,n=p.ys,m=p.zs,I=p.nds,E=p.sls,a=l.length;let d=0;for(const r of b)d=Math.max(d,y[M[r]]);const c=h[e],z=aa(d);for(let r=0;r<n.length;r++)n[r]+=c;St[z]+=b.length;let G=[0,0,0];for(const r of b)G[S?S[M[r]]:2]++;const Ae=G[0]>=G[1]&&G[0]>=G[2]?0:G[1]>=G[2]?1:2;Ot[Ae]+=b.length;let o=!1,U=0;const J=[],ee=[];for(let r=0;r<a;r++){const R=I[r];if(X.set(l[r],n[r],m[r]),r<a-1?(qe.set(l[r+1],n[r+1],m[r+1]),C.subVectors(qe,X)):(qe.set(l[r-1],n[r-1],m[r-1]),C.subVectors(X,qe)),C.lengthSq()<1e-10&&C.set(1,0,0),C.normalize(),!o)K.crossVectors(Math.abs(C.y)>.9?Jt:$t,C).normalize(),ze.crossVectors(C,K).normalize(),o=!0;else{Pe.crossVectors(at,C);const F=Pe.length(),ue=at.dot(C);F>1e-6&&(Pe.multiplyScalar(1/F),K.applyAxisAngle(Pe,Math.atan2(F,ue))),K.sub(Qt.copy(C).multiplyScalar(K.dot(C))).normalize(),ze.crossVectors(C,K).normalize()}at.copy(C),r>0&&(U+=X.distanceTo(Pe.set(l[r-1],n[r-1],m[r-1])));const D=E[r];J.push($);for(let F=0;F<=ke;F++){const ue=K.x*Ee[F]*c+ze.x*Ge[F]*c,Ne=K.y*Ee[F]*c+ze.y*Ge[F]*c,De=K.z*Ee[F]*c+ze.z*Ge[F]*c;se[ge]=X.x+ue,se[ge+1]=X.y+Ne,se[ge+2]=X.z+De;const ct=1/(Math.hypot(ue,Ne,De)||1);pe[ge]=ue*ct,pe[ge+1]=Ne*ct,pe[ge+2]=De*ct,ut[$]=z,ft[$]=Ae,Je[$]=R,wt[$]=D,vt[$]=U,pt[$]=c,mt[$]=_[R],ge+=3,$++}const te=-C.z,ae=C.x,j=Math.hypot(te,ae)||1;ee.push(T);for(let F=0;F<2;F++)Le[T*3]=X.x,Le[T*3+1]=0,Le[T*3+2]=X.z,_e[T*3]=te/j,_e[T*3+1]=0,_e[T*3+2]=ae/j,yt[T]=F?1:-1,bt[T]=X.y,At[T]=c,Mt[T]=_[R],xt[T]=U,Wt[T]=z,Ct[T]=Ae,tt[T]=R,Rt[T]=D,T++}for(let r=0;r<a-1;r++){const R=J[r],D=J[r+1];for(let j=0;j<ke;j++){const F=R+j,ue=R+j+1,Ne=D+j,De=D+j+1;me[Te++]=F,me[Te++]=Ne,me[Te++]=ue,me[Te++]=ue,me[Te++]=Ne,me[Te++]=De}const te=ee[r],ae=ee[r+1];we[We++]=te,we[We++]=ae,we[We++]=te+1,we[We++]=te+1,we[We++]=ae,we[We++]=ae+1}}const k=new t.BufferGeometry;k.setAttribute("position",new t.BufferAttribute(se,3)),k.setAttribute("normal",new t.BufferAttribute(pe,3)),k.setAttribute("aTier",new t.BufferAttribute(ut,1)),k.setAttribute("aClass",new t.BufferAttribute(ft,1)),k.setAttribute("aU",new t.BufferAttribute(vt,1)),k.setAttribute("aRad",new t.BufferAttribute(pt,1)),k.setAttribute("aNRad",new t.BufferAttribute(mt,1));const Bt=new t.BufferAttribute(Qe,1),Ut=new t.BufferAttribute(ht,1),Nt=new t.BufferAttribute(dt,1);k.setAttribute("aWaterM",Bt),k.setAttribute("aWaterMPrev",Ut),k.setAttribute("aFlow",Nt),k.setIndex(new t.BufferAttribute(me,1));const Ve={value:[1,1,1]},He={value:[1,1,1]},ne=new t.ShaderMaterial({uniforms:{uMode:{value:0},uTime:{value:0},uMix:{value:1},uTierOn:Ve,uTierCol:{value:ta.map(e=>new t.Vector3(...e.color))},uClassOn:He,uClassCol:{value:sa.map(e=>new t.Vector3(...e.color))},uClassTint:{value:.72},uWaterRef:{value:N}},vertexShader:ia,fragmentShader:la,transparent:!0,depthWrite:!1,side:t.FrontSide}),Ce=new t.Mesh(k,ne);Ce.frustumCulled=!1,Ce.renderOrder=2,g.add(Ce);const Ye=new t.ShaderMaterial({uniforms:{uTime:{value:0},uMix:{value:1},uTierOn:Ve,uClassOn:He,uWaterRef:{value:N},...Zt(t)},vertexShader:ca,fragmentShader:ua,transparent:!1,depthWrite:!0,side:t.DoubleSide,extensions:{derivatives:!0}}),Re=new t.Mesh(k,Ye);Re.frustumCulled=!1,Re.renderOrder=1,g.add(Re);const B=new t.BufferGeometry;B.setAttribute("position",new t.BufferAttribute(Le,3)),B.setAttribute("aPerp",new t.BufferAttribute(_e,3)),B.setAttribute("aSide",new t.BufferAttribute(yt,1)),B.setAttribute("aCenterY",new t.BufferAttribute(bt,1)),B.setAttribute("aRad",new t.BufferAttribute(At,1)),B.setAttribute("aNRad",new t.BufferAttribute(Mt,1)),B.setAttribute("aU",new t.BufferAttribute(xt,1));const kt=new t.BufferAttribute(et,1),zt=new t.BufferAttribute(Ft,1),Pt=new t.BufferAttribute(Tt,1);B.setAttribute("aWaterM",kt),B.setAttribute("aWaterMPrev",zt),B.setAttribute("aFlow",Pt),B.setAttribute("aTier",new t.BufferAttribute(Wt,1)),B.setAttribute("aClass",new t.BufferAttribute(Ct,1)),B.setIndex(new t.BufferAttribute(we,1));const Ie=new t.ShaderMaterial({uniforms:{uTime:{value:0},uMix:{value:1},uTierOn:Ve,uClassOn:He,uWaterRef:{value:N},...Zt(t)},vertexShader:fa,fragmentShader:va,transparent:!1,depthWrite:!0,side:t.DoubleSide,extensions:{derivatives:!0}}),Se=new t.Mesh(B,Ie);Se.frustumCulled=!1,Se.renderOrder=3,g.add(Se);const Oe=[],ea=1.2;for(let e=0;e<i;e++)re[e]>=3&&u[e]>=ea&&Oe.push(e);const Z=ma(t,Oe,O,de,H);Z&&(Z.renderOrder=1,g.add(Z));const Q=6,Vt=.2,Yt=(Q+1)*2,Be=Oe.length*Yt,Xe=new Float32Array(Be*3),rt=new Float32Array(Be),It=new Float32Array(Be),Dt=new Float32Array(Be),Lt=new Float32Array(Be),ot=new Uint32Array(Be),ye=new Uint32Array(Oe.length*Q*6);{const e=new Float32Array(Q+1),s=new Float32Array(Q+1);for(let n=0;n<=Q;n++){const m=n/Q*Math.PI*2;e[n]=Math.cos(m),s[n]=Math.sin(m)}let p=0,b=0,l=0;for(const n of Oe){const m=O[n],I=H[n],E=de[n]+.05;for(let c=0;c<2;c++)for(let z=0;z<=Q;z++)Xe[p*3]=m+e[z]*Vt,Xe[p*3+1]=c?0:E,Xe[p*3+2]=I+s[z]*Vt,Lt[p]=E,ot[p]=n,p++;const a=l,d=l+(Q+1);for(let c=0;c<Q;c++)ye[b++]=a+c,ye[b++]=d+c,ye[b++]=a+c+1,ye[b++]=a+c+1,ye[b++]=d+c,ye[b++]=d+c+1;l+=Yt}}const ie=new t.BufferGeometry;ie.setAttribute("position",new t.BufferAttribute(Xe,3));const _t=new t.BufferAttribute(rt,1),Et=new t.BufferAttribute(It,1),Gt=new t.BufferAttribute(Dt,1);ie.setAttribute("aRise",_t),ie.setAttribute("aRisePrev",Et),ie.setAttribute("aSurch",Gt),ie.setAttribute("aBaseY",new t.BufferAttribute(Lt,1)),ie.setIndex(new t.BufferAttribute(ye,1));const Ze=new t.ShaderMaterial({uniforms:{uTime:{value:0},uMix:{value:1}},vertexShader:da,fragmentShader:pa,transparent:!0,depthWrite:!1,side:t.DoubleSide}),be=new t.Mesh(ie,Ze);be.frustumCulled=!1,be.renderOrder=2,g.add(be);const st=new Float32Array(i),qt=new Float32Array(i),nt=new Float32Array(M.length),le={casing:!0,water:!0,shafts:!0},je=[null,null,null];let Ue=!1,ce=1,Ht="water",it=12.6;function Ke(){Ce.visible=Ue&&le.casing;const e=Ht==="capacity";Re.visible=Ue&&le.water&&!e,Se.visible=Ue&&le.water&&!e,Z&&(Z.visible=Ue&&le.shafts),be&&(be.visible=Ue&&le.shafts&&le.water)}function lt(){for(let e=0;e<3;e++){const s=it>=na[e];Ve.value[e]=(je[e]===null?s:je[e])?1:0}f.triggerRepaint()}lt(),Ke();const Xt=e=>{ne.uniforms.uTime.value=e,Ie.uniforms.uTime.value=e,Ye.uniforms.uTime.value=e,Ze.uniforms.uTime.value=e,ce<1&&(ce=Math.min(1,ce+.035),ne.uniforms.uMix.value=ce,Ie.uniforms.uMix.value=ce,Ye.uniforms.uMix.value=ce,Ze.uniforms.uMix.value=ce)};return f.tickers.add(Xt),{meshes:[Ce,Re,Se,Z,be].filter(Boolean),tierCount:St,classCount:Ot,shafts:Oe.length,chains:P.length,links:M.length,updateHour(e,s,p,b){const l=p||1e3,n=b||100,m=e.depth,I=e.flow;for(let a=0;a<M.length;a++)nt[a]=Math.max(-1,Math.min(1,I[M[a]]/n/2));for(let a=0;a<i;a++){const d=m[a]/l;st[a]=d,qt[a]=Math.min(1,d/Math.max(s[a],.1))}Ft.set(et),ht.set(Qe);for(let a=0;a<tt.length;a++)et[a]=st[tt[a]],Tt[a]=nt[Rt[a]];for(let a=0;a<Je.length;a++)Qe[a]=st[Je[a]],dt[a]=nt[wt[a]];Bt.needsUpdate=Ut.needsUpdate=Nt.needsUpdate=!0,kt.needsUpdate=zt.needsUpdate=Pt.needsUpdate=!0,It.set(rt);const E=e.sur;for(let a=0;a<ot.length;a++){const d=ot[a];rt[a]=qt[d],Dt[a]=E[d>>3]&1<<(d&7)?1:0}_t.needsUpdate=Et.needsUpdate=Gt.needsUpdate=!0,ce=0,Ze.uniforms.uMix.value=0,ne.uniforms.uMix.value=0,Ie.uniforms.uMix.value=0,Ye.uniforms.uMix.value=0},setVisible(e){Ue=e,Ke(),f.triggerRepaint()},setMode(e){Ht=e,ne.uniforms.uMode.value=e==="capacity"?1:0,ne.depthWrite=e==="capacity",ne.needsUpdate=!0,Ke(),f.triggerRepaint()},setLayer(e,s){e in le&&(le[e]=!!s,Ke(),f.triggerRepaint())},setTier(e,s){e>=0&&e<3&&(je[e]=s,lt())},setClass(e,s){e>=0&&e<3&&(He.value[e]=s?1:0,f.triggerRepaint())},tierAuto(e){return je[e]===null},tierVisible(e){return Ve.value[e]>.5},setZoom(e){Math.abs(e-it)>.05&&(it=e,lt())},setMaxDepth(){},setWaterRef(e){e>0&&(Ye.uniforms.uWaterRef.value=e,Ie.uniforms.uWaterRef.value=e,ne.uniforms.uWaterRef.value=e,f.triggerRepaint())},waterRef:N,nodeXYZ:{nx:O,ny:de,nz:H},dispose(){var e;f.tickers.delete(Xt);for(const s of[Ce,Re,Se,Z,be])s&&((e=s.parent)==null||e.remove(s),s.material.dispose());k.dispose(),B.dispose(),Z==null||Z.geometry.dispose(),ie.dispose()}}}export{sa as CLASSES,oa as DEFAULT_VEXAG,ta as TIERS,ya as createDrainageViz,aa as tierOf};
