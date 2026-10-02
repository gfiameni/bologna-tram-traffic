import { withLines } from "../src/lines.js";
import { intensity } from "../src/heatmap.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const plan = { extraShift: { verde: 0.08, gialla: 0.08, blu: 0.1 } };
const pair = {
  before: { carFlow: 453, viaEmiliaKmh: 22 },
  after: { carFlow: 246, viaEmiliaKmh: 14 },
};

const rossa = withLines(pair, ["rossa"], plan);
check("Rossa alone keeps the saved after case", rossa.after.carFlow === 246 && rossa.after.viaEmiliaKmh === 14);

const blu = withLines(pair, ["rossa", "blu"], plan);
check("Blu takes a further share of cars", Math.abs(blu.after.carFlow - 246 * 0.9) < 0.001);

const all = withLines(pair, ["rossa", "verde", "gialla", "blu"], plan);
check("Three extra lines stack", Math.abs(all.after.carFlow - 246 * 0.74) < 0.001);

const off = withLines(pair, [], plan);
check("Rossa off restores the before corridor", off.after.carFlow === 453 && off.after.viaEmiliaKmh === 22);

const view = { scenario: "after", cars: 1155, peakCars: 1233, carFlow: 221, beforeCarFlow: 453 };
const sample = { line: "verde", rank: 0.7 };
const closed = intensity(sample, { ...view, activeLines: ["rossa"] });
const open = intensity(sample, { ...view, activeLines: ["rossa", "verde"] });
check("a closed line keeps its car traffic", closed > 0.36 && closed > open);
check("an open line cools its corridor", open > 0.05 && open < closed);
check("line heat waits for the with-tram view", intensity(sample, { ...view, scenario: "before", activeLines: ["verde"] }) > open);
