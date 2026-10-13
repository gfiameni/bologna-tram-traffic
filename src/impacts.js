/**
 * What the tram changes: street by street on the Linea Rossa car route, mode by mode on the
 * corridor, and area by area on the city's main roads. Also the light optimiser and the
 * search for the best tram setup.
 */
import { COUNTER_SHARE, CROSS_MIN_S, SATURATION_PER_LANE, hourRow, merge, runModel, tramPassages } from "./sim/index.js";
import { BUS_EXHAUST, NOISE_WEIGHT, losFromDelay, speedFactor, summarise } from "./roads.js";

export const PIECE_ORDER = ["trunk", "bypass", "city", "fiera", "pilastro"];
export const BRANCH_SHARE = { fiera: 0.56, pilastro: 0.44 };
export const CENTRE = { lat: 44.4939, lon: 11.3426 };
export const AREAS = ["centre", "viali", "rossa", "verde", "gialla", "blu", "bypass", "parallel"];

function pieceShare(name) {
  return BRANCH_SHARE[name] ?? 1;
}

function kmh(piece) {
  return (piece.lengthM / Math.max(1, piece.carMin * 60)) * 3.6;
}

/** Lanes, load, level of service and queue on each street of the car route. */
export function streetRows(record) {
  return PIECE_ORDER.filter((name) => record?.pieces?.[name]).map((name) => {
    const piece = record.pieces[name];
    const ratio = piece.pceIn / Math.max(1, piece.capacity);
    const delay = ((piece.carMin - piece.freeMin) * 60) / Math.max(1, piece.junctions);
    return {
      name,
      lanes: piece.lanes,
      oneWay: piece.oneWay,
      forced: piece.forcedOneWay,
      cycle: piece.cycle,
      green: piece.green,
      carGreen: piece.carGreen,
      wave: piece.wave,
      ratio,
      delay,
      los: losFromDelay(delay, ratio),
      queue: Math.max(0, piece.carIn - Math.min(piece.carOut, piece.capacity)),
      diverted: piece.oneWay ? piece.carIn * COUNTER_SHARE : 0,
      kmh: kmh(piece),
      carIn: piece.carIn,
      capacity: piece.capacity,
    };
  });
}

/** Exhaust and noise along the car route, split by mode. Trams add noise and no exhaust. */
export function corridorEnvironment(record, { buses = 0, trams = 0 } = {}) {
  const out = { carExhaust: 0, busExhaust: 0, carNoise: 0, busNoise: 0, tramNoise: 0, length: 0 };
  for (const name of PIECE_ORDER) {
    const piece = record?.pieces?.[name];
    if (!piece) continue;
    const km = piece.lengthM / 1000;
    const onLine = name !== "bypass";
    const bus = onLine ? buses * pieceShare(name) : 0;
    const tram = onLine ? trams : 0;
    out.carExhaust += piece.carIn * speedFactor(kmh(piece)) * km;
    out.busExhaust += bus * BUS_EXHAUST * km;
    out.carNoise += piece.carIn * NOISE_WEIGHT.car * piece.lengthM;
    out.busNoise += bus * NOISE_WEIGHT.bus * piece.lengthM;
    out.tramNoise += tram * NOISE_WEIGHT.tram * piece.lengthM;
    out.length += piece.lengthM;
  }
  const per = (value) => value / Math.max(1, out.length);
  return {
    carExhaust: out.carExhaust,
    busExhaust: out.busExhaust,
    exhaust: out.carExhaust + out.busExhaust,
    carNoise: per(out.carNoise),
    busNoise: per(out.busNoise),
    tramNoise: per(out.tramNoise),
    noise: per(out.carNoise + out.busNoise + out.tramNoise),
  };
}

export function decibels(before, after) {
  return 10 * Math.log10(Math.max(after, 0.05) / Math.max(before, 0.05));
}

export function percent(before, after) {
  return (after / Math.max(before, 1e-9) - 1) * 100;
}

/** Areas a road belongs to, for the map labels and the panel. */
export function roadAreas(road) {
  const mid = road.path[Math.floor(road.path.length / 2)];
  const dx = (mid[1] - CENTRE.lon) * 111320 * Math.cos((CENTRE.lat * Math.PI) / 180);
  const dy = (mid[0] - CENTRE.lat) * 110540;
  const distance = Math.hypot(dx, dy);
  const areas = [];
  if (/^Viale /.test(road.name) && distance > 750 && distance < 1600) areas.push("viali");
  else if (distance < 950) areas.push("centre");
  for (const line of road.tram) areas.push(line);
  if (road.piece && road.piece !== "bypass" && !areas.includes("rossa")) areas.push("rossa");
  if (road.piece === "bypass") areas.push("bypass");
  return areas;
}

export function prepareAreas(city) {
  for (const road of city.roads) road.areas = roadAreas(road);
  const anchors = {};
  for (const area of AREAS) {
    const members = city.roads.filter((road) => road.areas.includes(area));
    if (!members.length) continue;
    let lat = 0;
    let lon = 0;
    let weight = 0;
    for (const road of members) {
      const mid = road.path[Math.floor(road.path.length / 2)];
      lat += mid[0] * road.length;
      lon += mid[1] * road.length;
      weight += road.length;
    }
    lat /= weight;
    lon /= weight;
    let best = null;
    for (const road of members) {
      const mid = road.path[Math.floor(road.path.length / 2)];
      const gap = Math.hypot(mid[0] - lat, (mid[1] - lon) * 0.71) - road.length / 4e6;
      if (!best || gap < best.gap) best = { gap, lat: mid[0], lon: mid[1] };
    }
    anchors[area] = { lat: best.lat, lon: best.lon };
  }
  city.anchors = anchors;
  return city;
}

/** Summary per area. "parallel" is every road that takes diverted cars in the after case. */
export function areaSummaries(city, before, after) {
  const out = {};
  const parallel = new Set(after.roads.filter((state) => state.extra > 0).map((state) => state.id));
  for (const area of AREAS) {
    const pick = area === "parallel"
      ? (road) => parallel.has(road.id)
      : (road) => road.areas.includes(area);
    const b = summarise(city, before, pick);
    if (!b.km) continue;
    out[area] = { before: b, after: summarise(city, after, pick) };
  }
  if (out.parallel) {
    let best = null;
    for (const state of after.roads) {
      if (!parallel.has(state.id)) continue;
      const road = city.roads[state.id];
      const score = state.extra * road.length;
      if (!best || score > best.score) best = { score, road };
    }
    const mid = best.road.path[Math.floor(best.road.path.length / 2)];
    out.parallel.anchor = { lat: mid[0], lon: mid[1] };
  }
  return out;
}

/** Streets that change most between before and after, by name. */
export function changedStreets(city, before, after, limit = 5) {
  const byName = new Map();
  after.roads.forEach((state, i) => {
    const road = city.roads[i];
    if (!road.name) return;
    const prior = before.roads[i];
    const entry = byName.get(road.name) || { name: road.name, length: 0, before: 0, after: 0, carsBefore: 0, carsAfter: 0, losAfter: "A", losBefore: "A", tram: false };
    entry.length += road.length;
    entry.before += prior.worst * road.length;
    entry.after += state.worst * road.length;
    entry.carsBefore += prior.cars * road.length;
    entry.carsAfter += state.cars * road.length;
    if (state.los > entry.losAfter) entry.losAfter = state.los;
    if (prior.los > entry.losBefore) entry.losBefore = prior.los;
    entry.tram ||= state.open.length > 0;
    byName.set(road.name, entry);
  });
  return [...byName.values()]
    .filter((entry) => entry.length > 250)
    .map((entry) => ({
      ...entry,
      before: entry.before / entry.length,
      after: entry.after / entry.length,
      carsBefore: entry.carsBefore / entry.length,
      carsAfter: entry.carsAfter / entry.length,
    }))
    .sort((a, b) => (b.after - b.before) - (a.after - a.before))
    .slice(0, limit);
}

/** Cars, buses and bicycles, before and after, for the impact cards. */
export function modeImpacts({ pair, corridor, hour, headway, rossaOpen, city, cityBefore, cityAfter }) {
  const busesBefore = hourRow(corridor, hour, "before").buses;
  const after = pair.after;
  const before = pair.before;
  const trams = rossaOpen ? tramPassages(headway) : 0;
  const busesAfter = rossaOpen ? 0 : hourRow(corridor, hour, "after").buses;
  const envBefore = corridorEnvironment(before, { buses: busesBefore, trams: 0 });
  const envAfter = corridorEnvironment(after, { buses: busesAfter, trams });
  const streetsBefore = streetRows(before);
  const streetsAfter = streetRows(after);
  const queue = (rows) => rows.find((row) => row.name === "trunk")?.queue ?? 0;
  const diverted = (rows) => rows.reduce((sum, row) => sum + row.diverted, 0);
  const cityB = summarise(city, cityBefore);
  const cityA = summarise(city, cityAfter);
  return {
    traffic: {
      cars: [before.carFlow, after.carFlow],
      demand: [before.pieces.trunk.carIn, after.pieces.trunk.carIn],
      buses: [busesBefore, busesAfter],
      trams: [0, rossaOpen ? 60 / headway : 0],
      bikes: [before.bikeFlow, after.bikeFlow],
      carKm: [cityB.carKm, cityA.carKm],
    },
    congestion: {
      city: [cityB.congestedShare, cityA.congestedShare],
      cityKm: cityB.km,
      queue: [queue(streetsBefore), queue(streetsAfter)],
      diverted: diverted(streetsAfter),
      transit: [[before.transitFieraMin, after.transitFieraMin], [before.transitPilastroMin, after.transitPilastroMin]],
      bike: [before.bikeFieraMin, after.bikeFieraMin],
      car: [[before.carFieraMin, after.carFieraMin], [before.carPilastroMin, after.carPilastroMin]],
    },
    air: {
      cars: [envBefore.carExhaust, envAfter.carExhaust],
      buses: [envBefore.busExhaust, envAfter.busExhaust],
      corridor: [envBefore.exhaust, envAfter.exhaust],
      city: [cityB.exhaust, cityA.exhaust],
    },
    noise: {
      corridor: [envBefore.noise, envAfter.noise],
      cars: [envBefore.carNoise, envAfter.carNoise],
      buses: [envBefore.busNoise, envAfter.busNoise],
      trams: [envBefore.tramNoise, envAfter.tramNoise],
      city: [cityB.noise, cityA.noise],
    },
    streets: { before: streetsBefore, after: streetsAfter },
  };
}

export const LIGHT_CYCLES = [60, 90, 120];
export const LIGHT_SHARES = [0.45, 0.6, 0.75];
export const QUEUE_MINUTES = 30;
export const CROSS_FLOW = 300;
export const LOST_PER_PHASE_S = 4;

/** Minutes the cross street loses at one junction: Webster's delay, plus the cars that do not fit. */
export function crossMinutes(cycle, green) {
  const share = Math.max(0.05, (cycle - green - 2 * LOST_PER_PHASE_S) / cycle);
  const capacity = SATURATION_PER_LANE * share;
  const load = Math.min(1, CROSS_FLOW / capacity);
  const delay = (0.5 * cycle * (1 - share) ** 2) / Math.max(0.05, 1 - load * share);
  return (CROSS_FLOW * delay) / 60 + QUEUE_MINUTES * Math.max(0, CROSS_FLOW - capacity);
}

/**
 * Person-minutes lost in one hour: the delay of every car that wants the trip, on each street
 * and on the streets that cross it, half an hour for each car that cannot get through, and
 * the riders' time on board.
 */
export function minutesLost(record, corridor) {
  const occupancy = corridor.occupancy ?? 1.3;
  const demand = record.pieces?.trunk?.carIn ?? 0;
  let lost = 0;
  for (const name of PIECE_ORDER) {
    const piece = record.pieces?.[name];
    if (!piece) continue;
    const queue = Math.max(0, piece.carIn - Math.min(piece.carOut, piece.capacity));
    lost += occupancy * demand * pieceShare(name) * Math.max(0, piece.carMin - piece.freeMin);
    lost += occupancy * QUEUE_MINUTES * queue;
    lost += occupancy * piece.junctions * crossMinutes(piece.cycle, piece.green);
  }
  const carried = Math.max(0, record.peoplePerHour - record.carFlow * occupancy - record.bikeFlow);
  return lost + (carried + record.unserved) * 0.5 * (record.transitFieraMin + record.transitPilastroMin);
}

export function lightOptions(cycle) {
  const options = [];
  for (const length of LIGHT_CYCLES.includes(cycle) ? LIGHT_CYCLES : [...LIGHT_CYCLES, cycle]) {
    for (const share of LIGHT_SHARES) {
      for (const wave of [false, true]) {
        options.push({ cycle: length, green: Math.min(length - CROSS_MIN_S, Math.round(share * length)), wave });
      }
    }
  }
  return options;
}

/**
 * Try every cycle, green share and green wave on each signalised street, in route order,
 * with the selected model, and keep the timing that loses the fewest person-minutes.
 */
export async function optimiseLights(corridor, design, { model, shift, headway, hour }, { yieldEvery = 6, onProgress } = {}) {
  let best = structuredClone(merge(design));
  const run = (candidate) => runModel(model, corridor, "after", shift, headway, { hour, design: candidate });
  let bestLost = minutesLost(run(best), corridor);
  const streets = PIECE_ORDER.filter((name) => corridor.pieces[name]?.signals.length);
  const total = streets.reduce((sum, name) => sum + lightOptions(best.streets[name].cycle).length, 0);
  let done = 0;
  for (const name of streets) {
    for (const option of lightOptions(best.streets[name].cycle)) {
      const candidate = structuredClone(best);
      Object.assign(candidate.streets[name], option);
      const lost = minutesLost(run(candidate), corridor);
      if (lost < bestLost - 1e-6) {
        best = candidate;
        bestLost = lost;
      }
      done += 1;
      if (yieldEvery && done % yieldEvery === 0) {
        onProgress?.(done / total);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  return { design: best, minutesLost: bestLost };
}

export const WAIT_MINUTES = 30;
export const TRAM_COST_MINUTES = 300;
export const DIVERTED_MINUTES = 10;

/**
 * Cost of a setup in person-minutes an hour: time lost, half an hour for each rider left at
 * the stop, ten minutes for each car sent round by a one-way street, and 300 for each tram
 * an hour it takes to run the service.
 */
export function setupCost(after, corridor, headway) {
  const occupancy = corridor.occupancy ?? 1.3;
  const diverted = streetRows(after).reduce((sum, row) => sum + row.diverted, 0);
  return minutesLost(after, corridor) + WAIT_MINUTES * after.unserved + DIVERTED_MINUTES * occupancy * diverted
    + TRAM_COST_MINUTES * (60 / headway);
}

export const HEADWAYS = [3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8];

/** Every tram frequency, priority on and off, streets as set or one-way where the tram runs. */
export function setupGrid() {
  const grid = [];
  for (const headway of HEADWAYS) {
    for (const priority of [true, false]) {
      for (const direction of ["set", "oneWay"]) grid.push({ headway, priority, direction });
    }
  }
  return grid;
}

export function setupDesign(corridor, design, option) {
  const next = structuredClone(merge(design));
  next.priority = option.priority;
  if (option.direction === "oneWay") {
    for (const [name, piece] of Object.entries(corridor.pieces)) {
      if (piece.affected) next.streets[name].oneWay = true;
    }
  }
  return next;
}

/**
 * Rank the grid with the lights as set, then optimise the lights of the winner.
 * Runs a few cases at a time so the page stays responsive.
 */
export async function searchBestSetup(corridor, { model, shift, hour, design }, { yieldEvery = 4, onProgress } = {}) {
  const grid = setupGrid();
  const before = runModel(model, corridor, "before", shift, grid[0].headway, { hour, design });
  const ranked = [];
  for (let i = 0; i < grid.length; i++) {
    const option = grid[i];
    const chosen = setupDesign(corridor, design, option);
    const after = runModel(model, corridor, "after", shift, option.headway, { hour, design: chosen });
    ranked.push({ ...option, lights: "set", design: chosen, before, after, cost: setupCost(after, corridor, option.headway) });
    if (yieldEvery && (i + 1) % yieldEvery === 0) {
      onProgress?.((0.4 * (i + 1)) / grid.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  ranked.sort((a, b) => a.cost - b.cost);
  const winner = ranked[0];
  const tuned = await optimiseLights(corridor, winner.design, { model, shift, headway: winner.headway, hour }, {
    yieldEvery,
    onProgress: (share) => onProgress?.(0.4 + 0.6 * share),
  });
  const after = runModel(model, corridor, "after", shift, winner.headway, { hour, design: tuned.design });
  const best = { ...winner, lights: "optimised", design: tuned.design, after, cost: setupCost(after, corridor, winner.headway) };
  return { best: best.cost <= winner.cost ? best : winner, ranked };
}
