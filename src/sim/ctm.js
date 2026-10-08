/** Cell-transmission model. A port of sim/ctm.py. */
import { SATURATION_PER_LANE, TODAY, layoutsAndPlans, measureWindow, offsets, pyRound } from "./design.js";
import { demand, finish } from "./engine.js";

const DX = 50;
const DT = 1;
const WAVE = 5;
const QMAX_LANE = SATURATION_PER_LANE / 3600;
const KJ_LANE = 0.13;

export function rollout(length, lanes, inflow, signals, free, steps, plan = TODAY) {
  const cycle = plan.cycle;
  const green = plan.carGreen;
  const n = Math.max(2, pyRound(length / DX));
  const dx = length / n;
  const qmax = lanes * QMAX_LANE;
  const kj = lanes * KJ_LANE;
  let density = new Float64Array(n);
  const red = new Uint8Array(n);
  const offset = new Float64Array(n);
  const shifts = offsets(signals, plan, "ctm");
  signals.forEach((position, index) => {
    // A light in the entry cell would turn arriving cars away instead of queueing them.
    const cell = Math.min(n - 1, Math.max(1, Math.trunc(position / dx)));
    red[cell] = 1;
    offset[cell] = shifts[index];
  });
  const anyRed = signals.length > 0;
  const measureFrom = steps;
  const total = steps + pyRound(measureWindow(cycle) / DT);
  const scale = new Float64Array(n);
  const send = new Float64Array(n);
  const receive = new Float64Array(n);
  const flowIn = new Float64Array(n);
  const flowOut = new Float64Array(n);
  let next = new Float64Array(n);
  let travelSum = 0;
  let outflow = 0;
  let measuredSteps = 0;
  for (let step = 0; step < total; step++) {
    const clock = step * DT;
    for (let i = 0; i < n; i++) {
      scale[i] = anyRed && red[i] && (clock + offset[i]) % cycle >= green ? 0 : 1;
    }
    for (let i = 0; i < n; i++) {
      send[i] = Math.min(free * density[i], qmax) * scale[i];
      receive[i] = Math.min(WAVE * Math.max(kj - density[i], 0), qmax) * scale[i];
    }
    flowIn[0] = Math.min(inflow, receive[0]);
    for (let i = 1; i < n; i++) flowIn[i] = Math.min(send[i - 1], receive[i]);
    for (let i = 0; i < n - 1; i++) flowOut[i] = flowIn[i + 1];
    flowOut[n - 1] = send[n - 1];
    for (let i = 0; i < n; i++) next[i] = Math.max(0, density[i] + (DT / dx) * (flowIn[i] - flowOut[i]));
    [density, next] = [next, density];
    if (step >= measureFrom) {
      let sum = 0;
      let last = 0;
      for (let i = 0; i < n; i++) {
        const out = Math.min(free * density[i], qmax) * scale[i];
        let speed = free;
        if (density[i] > 1e-5) speed = Math.min(free, out / density[i]);
        speed = Math.max(speed, 0.5);
        sum += dx / speed;
        last = out;
      }
      travelSum += sum;
      outflow += last * DT;
      measuredSteps += 1;
    }
  }
  const measured = Math.max(1, measuredSteps * DT);
  return { seconds: travelSum / Math.max(1, measuredSteps), throughput: (outflow / measured) * 3600 };
}

export function horizon(length) {
  return Math.trunc(Math.min(2150, Math.max(460, length / 2.5 + 160)));
}

function piece(item, carH, busH, bikeH, layout, plan) {
  const lanes = layout.lanes;
  const bus = item.name !== "bypass" ? busH : 0;
  let pce;
  let bikeMps = null;
  if (item.bikeProtected) {
    pce = carH + 2.2 * bus;
    bikeMps = 5.6;
  } else {
    pce = carH + 2.2 * bus + 0.3 * bikeH;
  }
  const inflow = pce / 3600;
  const { seconds, throughput } = rollout(item.length, lanes, inflow, item.signals, item.free, horizon(item.length), plan);
  const carShare = carH / Math.max(1, pce);
  const bikeShare = (item.bikeProtected ? 0 : bikeH) / Math.max(1, pce);
  const carOut = throughput * carShare;
  const bikeOut = item.bikeProtected ? bikeH : throughput * bikeShare;
  const carMps = item.length / Math.max(seconds, 1);
  if (bikeMps === null) bikeMps = Math.min(4.6, carMps * 0.9);
  const busMps = Math.min(carMps, 11);
  return {
    car_min: seconds / 60,
    bus_min: (item.length / Math.max(busMps, 0.5) + 20 * item.stops.length) / 60,
    bike_min: item.length / bikeMps / 60,
    car_mps: carMps,
    bike_mps: bikeMps,
    car_in: carH,
    pce_in: pce,
    car_out: Math.min(carH, carOut),
    bike_out: bikeOut,
  };
}

export function run(corridor, scenario, shift, headway, hour, design) {
  const { cars, buses, bikes } = demand(corridor, scenario, shift, hour);
  const { layouts, plans } = layoutsAndPlans(corridor, scenario, design, headway);
  const stats = {};
  let upstream = cars;
  for (const name of ["trunk", "bypass", "city"]) {
    const busHere = name !== "bypass" ? buses : 0;
    stats[name] = piece(corridor.pieces[name], upstream, busHere, name === "trunk" ? bikes : bikes * 0.9, layouts[name], plans[name]);
    upstream = stats[name].car_out;
  }
  for (const [name, share] of [["fiera", 0.56], ["pilastro", 0.44]]) {
    stats[name] = piece(corridor.pieces[name], upstream * share, buses * share, bikes * share, layouts[name], plans[name]);
  }
  return finish(corridor, scenario, shift, headway, hour, design, stats, layouts, plans, stats.trunk.car_out, stats.trunk.bike_out);
}
