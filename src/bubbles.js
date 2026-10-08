/**
 * Congestion bubbles on the biggest named streets. Long streets are cut into stretches of
 * about 2 km, so each bubble describes the part of the street it sits on.
 */
export const BUBBLE_KINDS = ["trunk", "primary", "secondary"];
export const STRETCH_M = 2000;
export const MIN_STRETCH_M = 300;
export const BUBBLE_LIMIT = 36;
export const SPOT_M = 120;
export const SPOT_LIMIT = 32;
const LEVELS = ["A", "B", "C", "D", "E", "F"];
const METRES_PER_DEGREE = 111320;

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function project([lat, lon], cosLat) {
  return [lon * cosLat * METRES_PER_DEGREE, lat * METRES_PER_DEGREE];
}

/** The point halfway along a path of [lat, lon] pairs. */
export function pathMidpoint(path) {
  if (path.length === 1) return path[0];
  const cosLat = Math.cos((path[0][0] * Math.PI) / 180);
  const points = path.map((point) => project(point, cosLat));
  const steps = points.slice(1).map((point, i) => Math.hypot(point[0] - points[i][0], point[1] - points[i][1]));
  let left = steps.reduce((sum, step) => sum + step, 0) / 2;
  for (let i = 0; i < steps.length; i++) {
    if (left <= steps[i] || i === steps.length - 1) {
      const f = steps[i] ? Math.min(1, left / steps[i]) : 0;
      return [path[i][0] + f * (path[i + 1][0] - path[i][0]), path[i][1] + f * (path[i + 1][1] - path[i][1])];
    }
    left -= steps[i];
  }
  return path[0];
}

/** Points along a path of [lat, lon] pairs, one every `every` metres, from its first point. */
export function pathPoints(path, every = SPOT_M) {
  const cosLat = Math.cos((path[0][0] * Math.PI) / 180);
  const points = [path[0]];
  let left = every;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = project(path[i - 1], cosLat);
    const [bx, by] = project(path[i], cosLat);
    const step = Math.hypot(bx - ax, by - ay);
    let walked = 0;
    while (step - walked >= left) {
      walked += left;
      const f = walked / step;
      points.push([path[i - 1][0] + f * (path[i][0] - path[i - 1][0]), path[i - 1][1] + f * (path[i][1] - path[i - 1][1])]);
      left = every;
    }
    left -= step - walked;
  }
  return points;
}

/** Named trunk, primary, and secondary streets, cut into stretches along their main axis. */
export function streetStretches(city, { stretchM = STRETCH_M, minM = MIN_STRETCH_M } = {}) {
  const streets = new Map();
  for (const road of city.roads) {
    if (!road.name || !BUBBLE_KINDS.includes(road.kind)) continue;
    if (!streets.has(road.name)) streets.set(road.name, []);
    streets.get(road.name).push(road);
  }
  const stretches = [];
  for (const [name, roads] of streets) {
    const length = roads.reduce((sum, road) => sum + road.length, 0);
    if (length < minM) continue;
    const cosLat = Math.cos((roads[0].path[0][0] * Math.PI) / 180);
    const items = roads.map((road) => {
      const mid = pathMidpoint(road.path);
      const [x, y] = project(mid, cosLat);
      return { road, mid, x, y, w: road.length };
    });
    const cx = items.reduce((sum, item) => sum + item.x * item.w, 0) / length;
    const cy = items.reduce((sum, item) => sum + item.y * item.w, 0) / length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const item of items) {
      sxx += item.w * (item.x - cx) ** 2;
      syy += item.w * (item.y - cy) ** 2;
      sxy += item.w * (item.x - cx) * (item.y - cy);
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const along = (x, y) => (x - cx) * Math.cos(angle) + (y - cy) * Math.sin(angle);
    for (const item of items) item.s = along(item.x, item.y);
    items.sort((a, b) => a.s - b.s);
    const parts = Math.max(1, Math.round(length / stretchM));
    const groups = Array.from({ length: parts }, () => []);
    let walked = 0;
    for (const item of items) {
      const middle = walked + item.w / 2;
      groups[Math.min(parts - 1, Math.floor((middle / length) * parts))].push(item);
      walked += item.w;
    }
    groups.forEach((group, index) => {
      const size = group.reduce((sum, item) => sum + item.w, 0);
      if (!group.length || size < minM) return;
      const gx = group.reduce((sum, item) => sum + item.x * item.w, 0) / size;
      const gy = group.reduce((sum, item) => sum + item.y * item.w, 0) / size;
      const centre = group.reduce((best, item) => (Math.hypot(item.x - gx, item.y - gy) < Math.hypot(best.x - gx, best.y - gy) ? item : best));
      const points = group
        .flatMap((item) => pathPoints(item.road.path, SPOT_M / 4))
        .map((point) => ({ lat: point[0], lon: point[1], s: along(...project(point, cosLat)) }))
        .sort((a, b) => a.s - b.s);
      const spots = [];
      for (const point of points) if (!spots.length || point.s - spots[spots.length - 1].s >= SPOT_M) spots.push(point);
      const middle = centre.s;
      spots.sort((a, b) => Math.abs(a.s - middle) - Math.abs(b.s - middle));
      const anchor = { lat: centre.mid[0], lon: centre.mid[1] };
      stretches.push({
        key: `${name}#${index}`,
        name,
        kind: group.reduce((best, item) => (BUBBLE_KINDS.indexOf(item.road.kind) < BUBBLE_KINDS.indexOf(best) ? item.road.kind : best), group[0].road.kind),
        ids: group.map((item) => item.road.id),
        length: size,
        anchor,
        spots: [anchor, ...spots.slice(0, SPOT_LIMIT - 1).map(({ lat, lon }) => ({ lat, lon }))],
      });
    });
  }
  return stretches;
}

function weightedMedian(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const half = sorted.reduce((sum, pair) => sum + pair[1], 0) / 2;
  let walked = 0;
  for (const [value, weight] of sorted) {
    walked += weight;
    if (walked >= half) return value;
  }
  return sorted.length ? sorted[sorted.length - 1][0] : 0;
}

/** Load and level along one stretch: the length-weighted median, and its busiest point. */
export function stretchValue(stretch, city, result) {
  const loads = [];
  const levels = [];
  let cars = 0;
  let length = 0;
  let peak = null;
  for (const id of stretch.ids) {
    const state = result.roads[id];
    const w = city.roads[id].length;
    loads.push([state.worst, w]);
    levels.push([Math.max(0, LEVELS.indexOf(state.los)), w]);
    cars += state.cars * w;
    length += w;
    if (!peak || state.worst > peak.worst) peak = state;
  }
  return {
    load: weightedMedian(loads),
    level: LEVELS[weightedMedian(levels)],
    cars: length ? cars / length : 0,
    peak: peak?.worst ?? 0,
    peakLevel: peak?.los ?? "A",
  };
}

/**
 * Stretches the tram runs along come first, then the other stretches it changes, each with the
 * largest change in load first, then the busiest. The order depends only on the before and
 * after results, so a bubble keeps its place when the view changes.
 */
export function rankStretches(stretches, city, before, after = before) {
  const tier = (item) => (item.tram ? 2 : item.changed ? 1 : 0);
  return stretches.map((stretch) => {
    const was = stretchValue(stretch, city, before);
    const now = stretchValue(stretch, city, after);
    const carKm = stretch.ids.reduce((sum, id) => sum + before.roads[id].cars * city.roads[id].length, 0);
    const tramM = stretch.ids.reduce((sum, id) => sum + (after.roads[id].open?.length ? city.roads[id].length : 0), 0);
    const tram = tramM >= stretch.length / 2;
    const shift = Math.abs(now.load - was.load);
    const changed = tram || shift >= 0.03 || stretch.ids.some((id) => after.roads[id].extra > 1);
    return { stretch, before: was, after: now, carKm, tram, changed, shift };
  }).sort((a, b) => tier(b) - tier(a) || (tier(a) ? b.shift - a.shift : 0) || b.carKm - a.carKm);
}

export function bubbleDiameter(load) {
  return Math.round(30 + 16 * clamp((load - 0.4) / 0.8));
}

export function changeTone(delta) {
  if (delta > 0.15) return "worse-much";
  if (delta > 0.03) return "worse";
  if (delta < -0.15) return "better-much";
  if (delta < -0.03) return "better";
  return "same";
}

/**
 * Place candidates, in order, inside the area and clear of the taken boxes and of each other.
 * A candidate is a circle of diameter d with spots [{ x, y }] to try in turn (or one x, y);
 * it lands on the first free spot, or stays off the map. Boxes are { x, y, w, h } centred on x, y.
 * A box marked trail gives way to a candidate marked onTrail, which lists it in covers.
 */
export function placeBubbles(candidates, { area = null, taken = [], limit = BUBBLE_LIMIT, pad = 4 } = {}) {
  const shown = [];
  const clear = (a, b) => Math.abs(a.x - b.x) >= (a.w + b.w) / 2 + pad || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 + pad;
  const fits = ({ x, y }, d, onTrail) => {
    const box = { x, y, w: d, h: d };
    if (area && (x - d / 2 < area.left || x + d / 2 > area.right || y - d / 2 < area.top || y + d / 2 > area.bottom)) return false;
    return taken.every((other) => (onTrail && other.trail) || clear(box, other)) && shown.every((other) => Math.hypot(other.x - x, other.y - y) >= (other.d + d) / 2 + pad);
  };
  for (const candidate of candidates) {
    if (shown.length >= limit) break;
    const spot = (candidate.spots ?? [candidate]).find((point) => fits(point, candidate.d, candidate.onTrail));
    if (!spot) continue;
    const box = { x: spot.x, y: spot.y, w: candidate.d, h: candidate.d };
    const covers = candidate.onTrail ? taken.filter((other) => other.trail && !clear(box, other)) : [];
    shown.push({ ...candidate, x: spot.x, y: spot.y, spot, covers });
  }
  return shown;
}
