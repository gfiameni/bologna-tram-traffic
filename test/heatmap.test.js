import { HEAT_MEASURES, changeColor, heatColor, heatScale, measureValue } from "../src/heatmap.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const road = { length: 500, lanes: [2, 2], kind: "primary" };
const quiet = { cars: 200, worst: 0.2, exhaust: 100, noise: 200 };
const busy = { cars: 3200, worst: 1.2, exhaust: 2500, noise: 4000 };
for (const measure of HEAT_MEASURES) {
  check(`${measure}: a busy road glows more than a quiet one`, measureValue(measure, road, busy) > measureValue(measure, road, quiet));
  check(`${measure}: values stay between 0 and 1`, [quiet, busy].every((state) => {
    const value = measureValue(measure, road, state);
    return value >= 0 && value <= 1;
  }));
}
check("a road with no state stays dark", measureValue("traffic", road, undefined) === 0);

const roads = Array.from({ length: 50 }, (_, id) => ({ id, length: 500, lanes: [1, 1], kind: "secondary" }));
const states = { roads: roads.map((item) => ({ id: item.id, cars: 20 * (item.id + 1), worst: 0.5, exhaust: item.id + 1, noise: 20 * (item.id + 1) })) };
for (const measure of HEAT_MEASURES) {
  const scale = heatScale(measure, { roads }, states);
  check(`${measure}: the city scale has a spread`, scale.hi > scale.lo);
}
const traffic = heatScale("traffic", { roads }, states);
check("the busiest roads reach the top of the scale", measureValue("traffic", roads[49], states.roads[49], traffic) === 1);
check("the hottest band is dark red", heatColor(0.9).join() === "154,52,18");
check("more is red and less is green", changeColor(0.3)[0] > changeColor(-0.3)[0] && changeColor(-0.3)[1] > changeColor(0.3)[1]);
