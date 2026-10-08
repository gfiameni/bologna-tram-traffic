/** A small neural net trained on the cell-transmission model. A port of the inference in sim/surrogate.py. */
import { TODAY_CYCLE_S, TODAY_GREEN_S, layoutsAndPlans } from "./design.js";
import { demand, finish } from "./engine.js";

function features(carH, bikeH, busH, lanes, signals, length, isProtected, plan) {
  return [
    carH / 2500,
    bikeH / 300,
    busH / 20,
    lanes / 2,
    signals.length / 12,
    length / 6000,
    isProtected ? 1 : 0,
    (plan.carGreen / plan.cycle) / (TODAY_GREEN_S / TODAY_CYCLE_S),
    plan.cycle / TODAY_CYCLE_S,
    plan.wave ? 1 : 0,
  ];
}

export function predict(weights, input) {
  const x = input.map((value, i) => (value - weights.mean[i]) / weights.std[i]);
  const hidden = weights.b1.map((bias, j) => {
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += x[i] * weights.w1[i][j];
    return Math.tanh(sum + bias);
  });
  return weights.b2.map((bias, k) => {
    let sum = 0;
    for (let j = 0; j < hidden.length; j++) sum += hidden[j] * weights.w2[j][k];
    return (sum + bias) * weights.yStd[k] + weights.yMean[k];
  });
}

function piece(weights, item, carH, busH, bikeH, layout, plan) {
  const bus = item.name !== "bypass" ? busH : 0;
  const [rawMinutes, ratio] = predict(weights, features(carH, bikeH, bus, layout.lanes, item.signals, item.length, item.bikeProtected, plan));
  const minutes = Math.max(item.length / item.free / 60, rawMinutes);
  const pce = carH + 2.2 * bus + (item.bikeProtected ? 0 : 0.3 * bikeH);
  const throughput = Math.max(0, Math.min(pce, pce * ratio));
  const carOut = throughput * (carH / Math.max(1, pce));
  const bikeOut = item.bikeProtected ? bikeH : throughput * (bikeH / Math.max(1, pce));
  const carMps = item.length / (minutes * 60);
  const bikeMps = item.bikeProtected ? 5.6 : Math.min(4.6, carMps * 0.9);
  return {
    car_min: minutes,
    bus_min: minutes + (20 * item.stops.length) / 60,
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
  const weights = corridor.weights;
  const { cars, buses, bikes } = demand(corridor, scenario, shift, hour);
  const { layouts, plans } = layoutsAndPlans(corridor, scenario, design, headway);
  const stats = {};
  let upstream = cars;
  for (const name of ["trunk", "bypass", "city"]) {
    stats[name] = piece(weights, corridor.pieces[name], upstream, buses, bikes, layouts[name], plans[name]);
    upstream = stats[name].car_out;
  }
  for (const [name, share] of [["fiera", 0.56], ["pilastro", 0.44]]) {
    stats[name] = piece(weights, corridor.pieces[name], upstream * share, buses * share, bikes * share, layouts[name], plans[name]);
  }
  return finish(corridor, scenario, shift, headway, hour, design, stats, layouts, plans, stats.trunk.car_out, stats.trunk.bike_out);
}
