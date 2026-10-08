/** Route geometry for the animation: the tram and car pieces of the Linea Rossa, with their stops. */

export const ANIMATION = {
  tramSpeedMps: 7.6,
  centerSpeedMps: 6.8,
  dwellSec: 26,
  fieraShare: 0.56,
};

function hav(a, b) {
  const r = 6371000;
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = ((b[1] - a[1]) * Math.PI) / 180;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function polylineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += hav(coords[i - 1], coords[i]);
  return total;
}

function project(coords, lon, lat) {
  let bestS = 0;
  let bestD = Infinity;
  let traveled = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const seg = hav(a, b) || 1e-6;
    const scale = Math.cos((a[1] * Math.PI) / 180);
    const vx = (b[0] - a[0]) * scale;
    const vy = b[1] - a[1];
    const wx = (lon - a[0]) * scale;
    const wy = lat - a[1];
    const den = vx * vx + vy * vy || 1e-12;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / den));
    const proj = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const dist = hav(proj, [lon, lat]);
    if (dist < bestD) {
      bestD = dist;
      bestS = traveled + seg * t;
    }
    traveled += seg;
  }
  return { s: bestS, dist: bestD };
}

function samplePolyline(coords) {
  const points = [];
  let traveled = 0;
  points.push({ lon: coords[0][0], lat: coords[0][1], s: 0 });
  for (let i = 1; i < coords.length; i++) {
    traveled += hav(coords[i - 1], coords[i]);
    points.push({ lon: coords[i][0], lat: coords[i][1], s: traveled });
  }
  return { points, length: traveled };
}

export function prepare(network) {
  const pieces = {};
  for (const mode of ["tram", "car"]) {
    pieces[mode] = {};
    for (const [name, coords] of Object.entries(network.pieces[mode])) {
      pieces[mode][name] = samplePolyline(coords);
    }
  }
  const stops = { trunk: [], fiera: [], pilastro: [] };
  for (const stop of network.stops) {
    const piece = stop.branch === "trunk" ? "trunk" : stop.branch;
    const hit = project(network.pieces.tram[piece], stop.lon, stop.lat);
    if (hit.dist < 90) stops[piece].push(hit.s);
  }
  for (const list of Object.values(stops)) list.sort((a, b) => a - b);
  const lengths = {
    tram: Object.fromEntries(Object.entries(pieces.tram).map(([k, v]) => [k, v.length])),
    car: Object.fromEntries(Object.entries(pieces.car).map(([k, v]) => [k, v.length])),
  };
  return {
    pieces,
    stops,
    lengths,
    affected: network.affected.car,
    screenS: network.screenline.tramTrunkM,
    screenName: network.screenline.name,
  };
}
