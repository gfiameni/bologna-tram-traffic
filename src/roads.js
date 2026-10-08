/**
 * Congestion on Bologna's main roads, before and after the tram.
 *
 * Each road carries the cars per lane its loop detectors count in that hour, or the count
 * it borrows from the same street or its road class. Capacity is lanes × 1,800 cars an hour
 * × the share of green. On an open tram line a road gives one lane to the tracks (a road
 * with one lane each way shares it with the tram), loses the drivers who switch, and, with
 * priority, loses the green the trams take. Cars that no longer fit move to parallel roads
 * within 1.2 km. Roads on the Linea Rossa car route take their numbers from the selected
 * corridor model, so the map and the panel agree.
 */
import { COUNTER_SHARE, MAX_GREEN_LOST, SATURATION_PER_LANE, TRAM_HOLD_S, tramPassages } from "./sim/design.js";

export const GREEN_SHARE = { trunk: 0.7, primary: 0.6, secondary: 0.5, tertiary: 0.45 };
export const OPEN_SHARE = 0.9;
export const LANE_CEILING = 1900;
export const SHARED_LANE = 0.75;
export const FREE_KMH = 30;
export const BUS_EXHAUST = 5;
export const NOISE_WEIGHT = { car: 1, bus: 8, tram: 5 };
const RATIO_BANDS = [[0.6, "A"], [0.7, "B"], [0.8, "C"], [0.9, "D"], [1, "E"]];
const DELAY_BANDS = [[10, "A"], [20, "B"], [35, "C"], [55, "D"], [80, "E"]];

export function decodePath(text) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < text.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = text.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

export function loadRoads(data) {
  const column = data.roads;
  const roads = column.name.map((nameIndex, i) => ({
    id: i,
    name: data.names[nameIndex],
    kind: data.kinds[column.kind[i]],
    path: decodePath(column.path[i]),
    length: column.length[i],
    oneWay: Boolean(column.oneWay[i]),
    lanes: column.lanes[i],
    signals: column.signals[i],
    flow: column.flow[i],
    measured: [Boolean(column.measured[i] & 1), Boolean(column.measured[i] & 2)],
    tram: data.lines.filter((_, k) => column.tram[i] & (1 << k)),
    piece: column.piece[i] >= 0 ? data.pieces[column.piece[i]] : null,
    tramBins: column.tramBins[i],
    spill: column.spill[i],
  }));
  return {
    roads,
    hours: data.hours,
    profiles: data.profiles,
    binLine: data.bins.map((line) => data.lines[line]),
    attribution: data.attribution,
    source: data.source,
    note: data.note,
  };
}

export function hourIndex(city, hour) {
  const index = city.hours.indexOf(Number(hour));
  return index >= 0 ? index : Math.max(0, city.hours.indexOf(8));
}

export function losFromRatio(ratio) {
  for (const [limit, letter] of RATIO_BANDS) if (ratio < limit) return letter;
  return "F";
}

/** HCM signalised-junction bands, seconds of delay per junction. */
export function losFromDelay(seconds, ratio = 0) {
  if (ratio > 1) return "F";
  for (const [limit, letter] of DELAY_BANDS) if (seconds <= limit) return letter;
  return "F";
}

export function speedKmh(ratio, free = FREE_KMH) {
  return free / (1 + 0.8 * ratio * ratio);
}

/** Exhaust per car-km rises as traffic slows. */
export function speedFactor(kmh) {
  return 0.6 + 0.4 * (FREE_KMH / Math.max(kmh, 3));
}

export function laneCapacity(road, profile) {
  const share = road.signals > 0 ? GREEN_SHARE[road.kind] ?? 0.5 : OPEN_SHARE;
  return Math.min(LANE_CEILING, Math.max(SATURATION_PER_LANE * share, profile.peak));
}

/** Share of green cars lose when every tram gets the junction. */
export function priorityLoss(greenShare, headway) {
  return Math.min(MAX_GREEN_LOST, (tramPassages(headway) * TRAM_HOLD_S) / Math.max(greenShare * 3600, 1));
}

function corridorPiece(road, corridor, scenario, rossaOpen) {
  if (!corridor) return null;
  const record = scenario === "after" && rossaOpen ? corridor.after : corridor.before;
  return record?.pieces?.[road.piece] ? { record, report: record.pieces[road.piece] } : null;
}

/**
 * Cars, load, and level of service on every road for one scenario.
 * `corridor` is the selected model's before and after; `buses` are the corridor's buses an hour.
 */
export function runCity(city, {
  scenario = "before",
  hour = 8,
  lines = [],
  shift = 0,
  extraShift = {},
  headway = 4.5,
  priority = true,
  corridor = null,
  buses = 0,
} = {}) {
  const slot = hourIndex(city, hour);
  const after = scenario === "after";
  const active = new Set(after ? lines : []);
  const rossaOpen = active.has("rossa");
  const trams = tramPassages(headway);
  const shiftOf = (id) => (id === "rossa" ? shift : extraShift[id] ?? 0);
  const displaced = new Float64Array(city.binLine.length);
  const covered = new Float64Array(city.binLine.length);
  const roads = city.roads.map((road) => {
    const open = road.tram.filter((id) => active.has(id));
    const rossaStreet = road.piece && road.piece !== "bypass";
    if (rossaStreet && rossaOpen && !open.includes("rossa")) open.push("rossa");
    const state = {
      id: road.id, open, flow: [0, 0], ratio: [0, 0], lanes: [0, 0], capacity: [0, 0],
      extra: 0, blocked: 0, diverted: 0, buses: 0, trams: 0,
    };
    const spread = (cars) => {
      for (const [bin, length] of road.tramBins) {
        if (!active.has(city.binLine[bin])) continue;
        displaced[bin] += cars * length;
        covered[bin] += length;
      }
    };
    const piece = road.piece ? corridorPiece(road, corridor, scenario, rossaOpen) : null;
    if (piece) {
      const { report } = piece;
      const ratio = report.pceIn / Math.max(1, report.capacity);
      const delay = ((report.carMin - report.freeMin) * 60) / Math.max(1, report.junctions);
      const twoWay = !road.oneWay && !report.oneWay;
      state.model = true;
      state.flow = [report.carIn, twoWay ? report.carIn * COUNTER_SHARE : 0];
      state.ratio = [ratio, twoWay ? ratio * COUNTER_SHARE : 0];
      state.lanes = [report.lanes, twoWay ? report.lanes : 0];
      state.capacity = [report.capacity, twoWay ? report.capacity : 0];
      state.los = losFromDelay(delay, ratio);
      state.speed = (report.lengthM / Math.max(1, report.carMin * 60)) * 3.6;
      state.buses = road.piece === "bypass" || (after && rossaOpen) ? 0 : buses;
      state.trams = rossaStreet && after && rossaOpen ? trams : 0;
      if (after && rossaOpen && rossaStreet) {
        state.blocked = Math.max(0, report.carIn - Math.min(report.carOut, report.capacity));
        state.diverted = report.oneWay ? report.carIn * COUNTER_SHARE : 0;
        spread(state.blocked + state.diverted);
      }
      return state;
    }
    const lineShift = open.length ? Math.max(...open.map(shiftOf)) : 0;
    let crossSection = 0;
    for (const side of [0, 1]) {
      const lanes = road.lanes[side];
      if (!lanes || road.flow[side] < 0) continue;
      const profile = city.profiles[road.flow[side]];
      let perLane = laneCapacity(road, profile);
      let demand = profile.cars[slot] * lanes;
      let carLanes = lanes;
      if (open.length) {
        demand *= 1 - lineShift;
        if (lanes >= 2) carLanes = lanes - 1;
        else perLane *= SHARED_LANE;
        if (priority && road.signals > 0) perLane *= 1 - priorityLoss(GREEN_SHARE[road.kind] ?? 0.5, headway);
      }
      const capacity = carLanes * perLane;
      const excess = open.length ? Math.max(0, demand - capacity) : 0;
      state.flow[side] = demand - excess;
      state.lanes[side] = carLanes;
      state.capacity[side] = capacity;
      state.ratio[side] = demand / Math.max(1, capacity);
      crossSection += excess * (road.oneWay ? 2 : 1);
      state.blocked += excess;
    }
    state.trams = open.length ? trams : 0;
    if (open.length) spread(crossSection);
    return state;
  });
  const pushed = Array.from(displaced, (value, bin) => (covered[bin] > 0 ? value / covered[bin] : 0));
  roads.forEach((state, i) => {
    const road = city.roads[i];
    if (!state.model && after && !state.open.length) {
      let extra = 0;
      for (const [bin, share] of road.spill) {
        if (active.has(city.binLine[bin])) extra += pushed[bin] * share;
      }
      if (extra > 0) {
        const total = state.lanes[0] + state.lanes[1];
        state.extra = extra;
        for (const side of [0, 1]) {
          if (!state.lanes[side]) continue;
          state.flow[side] += extra * (state.lanes[side] / Math.max(1, total));
          state.ratio[side] = state.flow[side] / Math.max(1, state.capacity[side]);
        }
      }
    }
    const worst = Math.max(state.ratio[0], state.ratio[1]);
    state.worst = worst;
    if (!state.model) {
      state.los = losFromRatio(worst);
      state.speed = speedKmh(worst);
    }
    const cars = state.flow[0] + state.flow[1];
    state.cars = cars;
    state.exhaust = ((cars * speedFactor(state.speed) + state.buses * BUS_EXHAUST) * road.length) / 1000;
    state.noise = cars * NOISE_WEIGHT.car + state.buses * NOISE_WEIGHT.bus + state.trams * NOISE_WEIGHT.tram;
  });
  return { roads, pushed };
}

/** Length-weighted summary of a set of roads. */
export function summarise(city, result, pick = () => true) {
  let length = 0;
  let congested = 0;
  let carKm = 0;
  let exhaust = 0;
  let noise = 0;
  let load = 0;
  for (const state of result.roads) {
    const road = city.roads[state.id];
    if (!pick(road, state)) continue;
    length += road.length;
    if (state.los === "E" || state.los === "F") congested += road.length;
    carKm += (state.cars * road.length) / 1000;
    exhaust += state.exhaust;
    noise += state.noise * road.length;
    load += state.worst * road.length;
  }
  return {
    km: length / 1000,
    congestedShare: length ? congested / length : 0,
    carKm,
    exhaust,
    noise: length ? noise / length : 0,
    load: length ? load / length : 0,
  };
}
