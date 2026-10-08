import { readFileSync } from "node:fs";
import { loadCorridor, runModel } from "../src/sim/index.js";

function check(name, condition, detail = "") {
  if (!condition) {
    console.error("FAIL", name, detail);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const corridor = loadCorridor(JSON.parse(readFileSync(new URL("../public/corridor.json", import.meta.url))));
const reference = JSON.parse(readFileSync(new URL("./fixtures/reference.json", import.meta.url)));

const KEYS = ["carFlow", "carFieraMin", "carPilastroMin", "bikeFieraMin", "transitFieraMin", "transitPilastroMin", "viaEmiliaKmh", "peoplePerHour", "unserved", "bikeFlow"];
const PIECE_KEYS = ["lanes", "carGreen", "carIn", "carOut", "carMin", "capacity"];

function close(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
}

const worst = {};
for (const item of reference.cases) {
  const design = reference.designs[item.design];
  const tolerance = 1e-6;
  for (const scenario of ["before", "after"]) {
    const ours = runModel(item.model, corridor, scenario, item.shift, item.headway, { hour: item.hour, design });
    const theirs = item[scenario];
    const misses = [];
    for (const key of KEYS) {
      if (!close(ours[key], theirs[key], tolerance)) misses.push(`${key} ${ours[key]} vs ${theirs[key]}`);
      const gap = Math.abs(ours[key] - theirs[key]) / Math.max(1, Math.abs(theirs[key]));
      worst[item.model] = Math.max(worst[item.model] || 0, gap);
    }
    for (const [name, piece] of Object.entries(theirs.pieces)) {
      for (const key of PIECE_KEYS) {
        if (!close(ours.pieces[name][key], piece[key], tolerance)) misses.push(`${name}.${key} ${ours.pieces[name][key]} vs ${piece[key]}`);
      }
      if (ours.pieces[name].oneWay !== piece.oneWay || ours.pieces[name].forcedOneWay !== piece.forcedOneWay) misses.push(`${name} direction`);
    }
    check(`${item.model} ${item.design} ${item.hour}:00 shift ${item.shift} tram ${item.headway} min ${scenario} matches Python`, misses.length === 0, misses.slice(0, 4).join("; "));
  }
}
console.log("largest relative gap by model", worst);
