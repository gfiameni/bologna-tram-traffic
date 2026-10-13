/** Shared scenario accounting for every model. A port of sim/engine.py. */
import { capacity, junctionCount } from "./design.js";

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

/** Timetable minutes, plus the wait at red lights when trams have no priority. */
export function tramTrip(corridor, branch, plans) {
  let wait = 0;
  for (const name of ["trunk", "city", branch]) {
    wait += junctionCount(corridor.pieces[name].signals) * plans[name].tramWait;
  }
  return tramMinutes(corridor, branch) + wait / 60;
}

export function pieceReport(corridor, stats, layouts, plans) {
  const report = {};
  for (const [name, item] of Object.entries(stats)) {
    const piece = corridor.pieces[name];
    report[name] = {
      lanes: layouts[name].lanes,
      oneWay: layouts[name].oneWay,
      forcedOneWay: layouts[name].forced,
      cycle: plans[name].cycle,
      green: plans[name].green,
      carGreen: plans[name].carGreen,
      wave: plans[name].wave,
      carIn: item.car_in,
      pceIn: item.pce_in,
      carOut: item.car_out,
      capacity: capacity(layouts[name], plans[name]),
      carMin: item.car_min,
      freeMin: piece.length / piece.free / 60,
      busMin: item.bus_min,
      bikeMin: item.bike_min,
      junctions: junctionCount(piece.signals),
      lengthM: piece.length,
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
export function finish(corridor, scenario, shift, headway, hour, design, stats, layouts, plans, trunkCars, trunkBikes) {
  const speeds = Object.fromEntries(Object.entries(stats).map(([name, item]) => [name, item.car_mps]));
  const bikeSpeeds = Object.fromEntries(Object.entries(stats).map(([name, item]) => [name, item.bike_mps]));
  const after = scenario === "after";
  const transitFiera = after ? tramTrip(corridor, "fiera", plans) : busTrip(stats, "fiera", corridor);
  const transitPilastro = after ? tramTrip(corridor, "pilastro", plans) : busTrip(stats, "pilastro", corridor);
  const result = peopleAndTransit(
    corridor, scenario, shift, headway,
    trunkCars, trunkBikes,
    transitFiera, transitPilastro, speeds, bikeSpeeds,
    chainTime(stats, "fiera", "car_min"),
    chainTime(stats, "pilastro", "car_min"),
    bikeTrip(stats, "fiera", "bike_min", corridor),
    hour,
  );
  result.pieces = pieceReport(corridor, stats, layouts, plans);
  result.priority = Boolean(design.priority);
  return result;
}
