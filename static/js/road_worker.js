// Web Worker: runs buildFloodedRoadGFC off the main thread.
// Receives: { roadCache, activePolygons, ROAD_CAUTION_M, ROAD_BLOCKED_M }
// Posts back: GeoJSON FeatureCollection

function pointInPolygon(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat;
    const xj = ring[j].lng, yj = ring[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

self.onmessage = function(e) {
  const { roadCache, activePolygons, ROAD_CAUTION_M, ROAD_BLOCKED_M } = e.data;
  const out = [];

  for (const { pts, name, cls } of roadCache) {
    let inFlood = false, seg = [], maxD = 0;

    const flush = () => {
      if (seg.length >= 2) out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: seg },
        properties: { name, cls, maxDepth: maxD,
          status: maxD >= ROAD_BLOCKED_M ? 'blocked' : 'caution' }
      });
    };

    for (const pt of pts) {
      const lng = pt[0], lat = pt[1];
      let ptDepth = 0;
      for (const { ring, depth, minLng, maxLng, minLat, maxLat } of activePolygons) {
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

  self.postMessage({ type: 'FeatureCollection', features: out });
};
