/** Volume-delay model with signals, buses, and bicycles. A port of sim/bpr.py. */
import { SATURATION_PER_LANE, WAVE_PROGRESSION, junctionCount, layoutsAndPlans } from "./design.js";
import { demand, finish } from "./engine.js";

const ALPHA = 0.8;

export function speed(flow, capacity, free) {
  const ratio = flow / Math.max(1, capacity);
  return free / (1 + ALPHA * ratio * ratio);
}

/** Webster's uniform delay at each junction, in seconds, for the whole street. */
export function signalDelay(flow, lanes, signals, plan) {
  const cycle = plan.cycle;
  const green = plan.carGreen / cycle;
  const saturation = Math.max(1, lanes * SATURATION_PER_LANE);
  const progression = plan.wave ? WAVE_PROGRESSION : 1;
  const volume = Math.min(0.92, flow / (saturation * green));
  const each = (0.5 * cycle * (1 - green) ** 2) / Math.max(0.08, 1 - green * volume);
  return progression * each * junctionCount(signals);
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
  const capacity = (lanes * SATURATION_PER_LANE * plan.carGreen) / plan.cycle;
  const carMps = speed(pce, capacity, item.free);
  if (bikeMps === null) bikeMps = Math.min(4.6, carMps * 0.9);
  const delay = signalDelay(pce, lanes, item.signals, plan);
  return {
    car_min: (item.length / carMps + delay) / 60,
    bus_min: (item.length / Math.min(carMps, 11) + delay + 20 * item.stops.length) / 60,
    bike_min: item.length / bikeMps / 60,
    car_mps: carMps,
    bike_mps: bikeMps,
    car_in: carH,
    pce_in: pce,
    car_out: carH,
    bike_out: bikeH,
  };
}

export function run(corridor, scenario, shift, headway, hour, design) {
  const { cars, buses, bikes } = demand(corridor, scenario, shift, hour);
  const { layouts, plans } = layoutsAndPlans(corridor, scenario, design, headway);
  const stats = {};
  for (const name of Object.keys(corridor.pieces)) {
    const share = name === "fiera" ? 0.56 : name === "pilastro" ? 0.44 : 1;
    stats[name] = piece(corridor.pieces[name], cars * share, buses * share, bikes * share, layouts[name], plans[name]);
  }
  return finish(corridor, scenario, shift, headway, hour, design, stats, layouts, plans, stats.trunk.car_out, stats.trunk.bike_out);
}
