/**
 * Intelligent Driver Model. A port of sim/idm.py.
 *
 * Each street is driven for its first 2.5 km at most. Flow and speed use
 * Edie's definitions over whole signal cycles, and the travel time scales to
 * the full length from the mean speed.
 */
import { TODAY, layoutsAndPlans, measureWindow, offsets, pyRound } from "./design.js";
import { demand, finish } from "./engine.js";

const DT = 0.5;
const REACH_M = 2500;
const DWELL_S = 18;
const LIMIT_MPS = 30 / 3.6;
// Desired speed and length by kind: car, bus, bicycle.
const V0 = [LIMIT_MPS, LIMIT_MPS, 5.4];
const LENGTH = [5, 12, 2];
const ACCEL = 1.2;
const BRAKE = 2;
const HEADWAY = 1.2;
const S0 = 2;
const ROOT = 2 * Math.sqrt(ACCEL * BRAKE);

function stream(fullLength, signals, allStops, arrivals, bikeOnly = false, plan = TODAY, lanes = 1) {
  const cycle = plan.cycle;
  const green = plan.carGreen;
  const length = Math.min(fullLength, REACH_M);
  const shifts = offsets(signals, plan, "idm");
  const lights = [];
  signals.forEach((signal, index) => {
    if (signal < length) lights.push([signal, shifts[index]]);
  });
  const stops = allStops.filter((stop) => stop < length);
  const warmupSteps = Math.ceil((2.2 * length / LIMIT_MPS + 60) / DT);
  const windowSteps = pyRound(measureWindow(cycle) / DT);
  let pos = [];
  let vel = [];
  let kind = [];
  let dwell = [];
  let served = [];
  const nextSpawn = arrivals.map(([, first]) => first);
  const distance = [0, 0, 0];
  const timeSpent = [0, 0, 0];
  const steps = warmupSteps + windowSteps;
  const passing = lanes > 1;
  for (let step = 0; step < steps; step++) {
    const clock = step * DT;
    arrivals.forEach(([vehicleKind, , headway], index) => {
      if (bikeOnly && vehicleKind !== 2) return;
      if (headway <= 0 || clock + 1e-6 < nextSpawn[index]) return;
      let nearest = 1e9;
      for (let i = 0; i < pos.length; i++) if (kind[i] === vehicleKind && pos[i] < nearest) nearest = pos[i];
      if (pos.length && nearest < 8) return;
      pos.push(0);
      vel.push(0.2);
      kind.push(vehicleKind);
      dwell.push(0);
      served.push(new Set());
      nextSpawn[index] += headway;
    });
    const n = pos.length;
    if (n === 0) continue;
    // With a second lane, cars pass bicycles and buses at a stop.
    const hidden = new Array(n);
    for (let i = 0; i < n; i++) hidden[i] = passing && ((kind[i] === 1 && dwell[i] > 0) || kind[i] === 2);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => pos[a] - pos[b] || a - b);
    const leadPos = new Array(n);
    const leadVel = new Array(n);
    let ahead = -1;
    for (let rank = n - 1; rank >= 0; rank--) {
      const index = order[rank];
      if (ahead < 0) {
        leadPos[index] = pos[index] + length + 80;
        leadVel[index] = vel[index];
      } else {
        leadPos[index] = pos[ahead];
        leadVel[index] = vel[ahead];
      }
      if (!hidden[index]) ahead = index;
    }
    for (const [signal, shift] of lights) {
      if ((clock + shift) % cycle < green) continue;
      for (let i = 0; i < n; i++) {
        if (pos[i] < signal && signal - pos[i] < leadPos[i] - pos[i]) {
          leadPos[i] = signal;
          leadVel[i] = 0;
        }
      }
    }
    const prev = pos.slice();
    for (let i = 0; i < n; i++) {
      const v0 = V0[kind[i]];
      const gap = Math.max(0.4, leadPos[i] - pos[i] - LENGTH[kind[i]]);
      const closing = vel[i] - leadVel[i];
      let desired = S0 + vel[i] * HEADWAY + (vel[i] * closing) / ROOT;
      desired = Math.max(S0, desired);
      const ratio = vel[i] / Math.max(v0, 0.1);
      const squared = ratio * ratio;
      const pressure = desired / gap;
      let accel = ACCEL * (1 - squared * squared - pressure * pressure);
      accel = Math.min(Math.max(accel, -3.5), 1.6);
      vel[i] = dwell[i] > 0 ? 0 : Math.min(Math.max(vel[i] + accel * DT, 0), v0);
    }
    for (let i = 0; i < n; i++) {
      pos[i] = pos[i] + vel[i] * DT;
      dwell[i] = Math.max(0, dwell[i] - DT);
    }
    for (let i = 0; i < n; i++) {
      if (kind[i] !== 1 || dwell[i] > 0) continue;
      stops.forEach((stop, stopIndex) => {
        if (served[i].has(stopIndex)) return;
        if (pos[i] >= stop) {
          served[i].add(stopIndex);
          dwell[i] = DWELL_S;
          vel[i] = 0;
        }
      });
    }
    if (step >= warmupSteps) {
      // Edie's definitions: distance and time spent inside the stretch over the window.
      for (let i = 0; i < n; i++) {
        distance[kind[i]] += Math.min(pos[i], length) - prev[i];
        timeSpent[kind[i]] += DT;
      }
    }
    if (pos.some((value) => value >= length)) {
      const keep = pos.map((value) => value < length);
      pos = pos.filter((_, i) => keep[i]);
      vel = vel.filter((_, i) => keep[i]);
      kind = kind.filter((_, i) => keep[i]);
      dwell = dwell.filter((_, i) => keep[i]);
      served = served.filter((_, i) => keep[i]);
    }
  }
  const measured = windowSteps * DT;
  const out = {};
  [["car", 0], ["bus", 1], ["bike", 2]].forEach(([label, vehicleKind]) => {
    const seen = timeSpent[vehicleKind] > 0;
    const mean = seen ? Math.max(0.4, distance[vehicleKind] / timeSpent[vehicleKind]) : null;
    out[label] = {
      mps: mean,
      minutes: seen ? fullLength / mean / 60 : null,
      per_hour: (distance[vehicleKind] / (length * measured)) * 3600,
    };
  });
  return out;
}

function piece(item, carH, busH, bikeH, layout, plan) {
  const lanes = layout.lanes;
  // Lanes scale the arrival headway: two lanes means half the following distance.
  const carHw = (3600 / Math.max(carH, 1)) * lanes;
  let busHw = busH > 1 ? 3600 / busH : 0;
  const bikeHw = bikeH > 1 ? 3600 / Math.max(bikeH, 1) : 0;
  if (item.name === "bypass") busHw = 0;
  let mixed;
  let bike;
  let pce;
  if (item.bikeProtected) {
    mixed = stream(item.length, item.signals, item.stops, [[0, 0, carHw], [1, 4, busHw]], false, plan, lanes);
    bike = stream(item.length, [], [], [[2, 0.5, bikeHw]], true).bike;
    pce = carH + 2.2 * (busHw > 0 ? busH : 0);
  } else {
    mixed = stream(item.length, item.signals, item.stops, [[0, 0, carHw], [1, 4, busHw], [2, 1, bikeHw]], false, plan, lanes);
    bike = mixed.bike;
    pce = carH + 2.2 * (busHw > 0 ? busH : 0) + 0.3 * bikeH;
  }
  let car = mixed.car;
  if (car.mps === null) car = { mps: item.free, minutes: item.length / item.free / 60 };
  let busMin = mixed.bus.minutes;
  if (busMin === null) busMin = (item.length / Math.min(car.mps, 11) + DWELL_S * item.stops.length) / 60;
  const bikeMps = bike.mps !== null ? bike.mps : Math.min(5.4, car.mps);
  return {
    car_min: car.minutes,
    bus_min: busMin,
    bike_min: item.length / bikeMps / 60,
    car_mps: car.mps,
    bike_mps: bikeMps,
    car_in: carH,
    pce_in: pce,
    car_out: Math.min(carH, mixed.car.per_hour * lanes),
    bike_out: bike.per_hour,
  };
}

export function run(corridor, scenario, shift, headway, hour, design) {
  const { cars, buses, bikes } = demand(corridor, scenario, shift, hour);
  const { layouts, plans } = layoutsAndPlans(corridor, scenario, design, headway);
  const stats = {};
  let upstream = cars;
  let bikeUp = bikes;
  for (const name of ["trunk", "bypass", "city"]) {
    stats[name] = piece(corridor.pieces[name], upstream, name !== "bypass" ? buses : 0, bikeUp, layouts[name], plans[name]);
    upstream = Math.min(upstream, stats[name].car_out);
    bikeUp = Math.min(bikeUp, Math.max(stats[name].bike_out, 1));
  }
  for (const [name, share] of [["fiera", 0.56], ["pilastro", 0.44]]) {
    stats[name] = piece(corridor.pieces[name], upstream * share, buses * share, bikes * share, layouts[name], plans[name]);
  }
  return finish(corridor, scenario, shift, headway, hour, design, stats, layouts, plans, Math.min(cars, stats.trunk.car_out), Math.min(bikes, stats.trunk.bike_out));
}
