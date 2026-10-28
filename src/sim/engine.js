/** Shared scenario accounting for every model. A port of sim/engine.py. */
import { capacity, junctionCount, partLayouts, parts, signalPlan, tramRedSeconds } from "./design.js";

/** The browser copy of the corridor, from public/corridor.json. */
export function loadCorridor(data) {
  const pieces = {};
  for (const [name, piece] of Object.entries(data.pieces)) {
    pieces[name] = { name, ...piece };
  }
  return {
    pieces,
    tramLength: data.tramLength,
    tramStops: data.tramStops,
    centreM: data.centreM,
    carPerHour: data.supply.carPerHour,
    bikePerHour: data.supply.bikePerHour,
    busPerHour: data.supply.busPerHour,
    occupancy: data.supply.occupancy ?? 1.3,
    passengersPerBus: data.supply.passengersPerBus ?? 45,
    hours: data.hours || [],
    year: data.years?.before ?? 2024,
    after: data.supply.after
      ? {
          carPerHour: data.supply.after.carPerHour,
          bikePerHour: data.supply.after.bikePerHour,
          busPerHour: data.supply.after.busPerHour,
          hours: data.hoursAfter || [],
          year: data.years?.after ?? 2026,
        }
      : null,
    weights: data.surrogate?.weights || null,
  };
}

/** The corridor with the measured demand of Before (2024) or After (2026). */
export function forYear(corridor, key) {
  if (key !== "after" || !corridor.after) return corridor;
  return { ...corridor, ...corridor.after, after: null };
}

/** The measured demand at one hour, in the year of `key` ("before" or "after"). */
export function hourRow(corridor, hour, key) {
  const source = forYear(corridor, key);
  const row = source.hours.find((item) => Number(item.hour) === Number(hour));
  if (row) return row;
  return { hour: 8, cars: source.carPerHour, buses: source.busPerHour, bikes: source.bikePerHour };
}

export function demand(corridor, scenario, shift, hour = 8) {
  const base = hourRow(corridor, hour);
  const moved = scenario === "after" ? shift : 0;
  const cars = base.cars * (1 - moved);
  const buses = scenario === "after" ? 0 : base.buses;
  return { cars, buses, bikes: base.bikes };
}

/** Buses an hour that keep running where there are no tracks. */
export function busesLeft(corridor, hour = 8) {
  return hourRow(corridor, hour).buses;
}

/**
 * A model's street, stretch by stretch: the cars that leave one stretch enter the next.
 * `solve(part, cars, buses, bikes, layout, plan)` is the model on one stretch. Stretches
 * without tracks keep `busFree` buses in After.
 */
export function runPiece(piece, scenario, street, priority, headway, carH, busH, bikeH, busFree, solve, chainBikes = false) {
  const items = parts(piece, scenario);
  const layouts = partLayouts(items.map((item) => item[2]), scenario, street);
  const rows = [];
  let car = carH;
  let bike = bikeH;
  items.forEach(([start, end, item], index) => {
    const layout = layouts[index];
    const plan = signalPlan(item, scenario, street, priority, headway);
    const tracks = scenario === "after" && Boolean(item.affected);
    const buses = tracks || scenario !== "after" ? busH : busFree;
    const stats = solve(item, car, buses, bike, layout, plan);
    rows.push({ start, end, item, layout, plan, tracks, buses, stats });
    car = stats.car_out;
    if (chainBikes) bike = Math.min(bike, Math.max(stats.bike_out, 1));
  });
  const loads = rows.map((row) => row.stats.pce_in / Math.max(1, capacity(row.layout, row.plan)));
  const binding = loads.indexOf(Math.max(...loads));
  const each = rows.map((row) => row.stats);
  let total;
  if (rows.length === 1) {
    total = { ...each[0] };
  } else {
    const sum = (key) => each.reduce((acc, item) => acc + item[key], 0);
    total = {
      car_min: sum("car_min"),
      bus_min: sum("bus_min"),
      bike_min: sum("bike_min"),
      car_in: carH,
      pce_in: each[binding].pce_in,
      car_out: each[each.length - 1].car_out,
      bike_out: each[each.length - 1].bike_out,
    };
    total.car_mps = piece.length / (total.car_min * 60);
    total.bike_mps = piece.length / (total.bike_min * 60);
  }
  total.layout = rows[binding].layout;
  total.plan = rows[binding].plan;
  total.capacity = capacity(rows[binding].layout, rows[binding].plan);
  total.parts = rows.map(({ start, end, item, layout, plan, tracks, buses, stats }) => ({
    from: start,
    to: end,
    tram: tracks,
    lanes: layout.lanes,
    carGreen: plan.carGreen,
    capacity: capacity(layout, plan),
    carIn: stats.car_in,
    pceIn: stats.pce_in,
    carOut: stats.car_out,
    carMin: stats.car_min,
    freeMin: item.length / item.free / 60,
    busMin: stats.bus_min,
    buses: item.name === "bypass" ? 0 : buses,
    junctions: junctionCount(item.signals),
  }));
  return total;
}

export function chainTime(stats, branch, key) {
  return stats.trunk[key] + stats.bypass[key] + stats.city[key] + stats[branch][key];
}

export function bikeTrip(stats, branch, key, corridor) {
  const centre = corridor.centreM / Math.max(1, stats.trunk.bike_mps) / 60;
  return stats.trunk[key] + centre + stats.city[key] + stats[branch][key];
}

export function busTrip(stats, branch, corridor) {
  const centre = corridor.centreM / 6.2 / 60;
  return stats.trunk.bus_min + centre + stats.city.bus_min + stats[branch].bus_min;
}

export function tramMinutes(corridor, branch) {
  const length = corridor.tramLength.trunk + corridor.tramLength[branch];
  const stops = Math.max(0, (corridor.tramStops.trunk ?? 1) + (corridor.tramStops[branch] ?? 1) - 2);
  return (length / 7.6 + stops * 26) / 60;
}

/**
 * Timetable minutes, plus the wait at red lights when trams have no priority.
 * Where the tracks end before the street does, riders wait half the bus interval and ride on.
 */
export function tramTrip(corridor, branch, design, headway, stats) {
  let minutes = tramMinutes(corridor, branch) + tramRedSeconds(corridor, branch, design, headway) / 60;
  const tail = stats[branch].parts[stats[branch].parts.length - 1];
  if (!tail.tram) minutes += 30 / Math.max(1, tail.buses) + tail.busMin;
  return minutes;
}

/** Each street at its busiest stretch, with every stretch listed. */
export function pieceReport(corridor, stats) {
  const report = {};
  for (const [name, item] of Object.entries(stats)) {
    const piece = corridor.pieces[name];
    const { layout, plan } = item;
    report[name] = {
      lanes: layout.lanes,
      oneWay: layout.oneWay,
      forcedOneWay: layout.forced,
      cycle: plan.cycle,
      green: plan.green,
      carGreen: plan.carGreen,
      wave: plan.wave,
      carIn: item.car_in,
      pceIn: item.pce_in,
      carOut: item.car_out,
      capacity: item.capacity,
      carMin: item.car_min,
      freeMin: piece.length / piece.free / 60,
      busMin: item.bus_min,
      bikeMin: item.bike_min,
      junctions: junctionCount(piece.signals),
      lengthM: piece.length,
      stretches: item.parts,
    };
  }
  return report;
}

export function peopleAndTransit(corridor, scenario, shift, headway, trunkCars, trunkBikes, transitFiera, transitPilastro, speeds, bikeSpeeds, carFiera, carPilastro, bikeFiera, hour = 8) {
  const base = hourRow(corridor, hour);
  let market;
  let room;
  let transit;
  let vehicles;
  if (scenario === "after") {
    market = base.buses * corridor.passengersPerBus + base.cars * shift * corridor.occupancy;
    room = (60 / headway) * 220;
    transit = "tram";
    vehicles = 60 / headway;
  } else {
    market = base.buses * corridor.passengersPerBus;
    room = base.buses * 90;
    transit = "bus";
    vehicles = base.buses;
  }
  const carried = Math.min(market, room);
  return {
    carFieraMin: carFiera,
    carPilastroMin: carPilastro,
    bikeFieraMin: bikeFiera,
    transitFieraMin: transitFiera,
    transitPilastroMin: transitPilastro,
    viaEmiliaKmh: speeds.trunk * 3.6,
    peoplePerHour: trunkCars * corridor.occupancy + trunkBikes + carried,
    unserved: Math.max(0, market - room),
    speeds,
    bikeSpeeds,
    carFlow: trunkCars,
    bikeFlow: trunkBikes,
    transit,
    vehiclesPerHour: vehicles,
  };
}

/** Speeds by piece, the transit trips, and the accounting every model shares. */
export function finish(corridor, scenario, shift, headway, hour, design, stats, trunkCars, trunkBikes) {
  const speeds = Object.fromEntries(Object.entries(stats).map(([name, item]) => [name, item.car_mps]));
  const bikeSpeeds = Object.fromEntries(Object.entries(stats).map(([name, item]) => [name, item.bike_mps]));
  const after = scenario === "after";
  const transitFiera = after ? tramTrip(corridor, "fiera", design, headway, stats) : busTrip(stats, "fiera", corridor);
  const transitPilastro = after ? tramTrip(corridor, "pilastro", design, headway, stats) : busTrip(stats, "pilastro", corridor);
  const result = peopleAndTransit(
    corridor, scenario, shift, headway,
    trunkCars, trunkBikes,
    transitFiera, transitPilastro, speeds, bikeSpeeds,
    chainTime(stats, "fiera", "car_min"),
    chainTime(stats, "pilastro", "car_min"),
    bikeTrip(stats, "fiera", "bike_min", corridor),
    hour,
  );
  result.pieces = pieceReport(corridor, stats);
  result.priority = Boolean(design.priority);
  return result;
}
