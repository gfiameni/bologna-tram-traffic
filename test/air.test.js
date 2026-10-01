import { airPaintValue, emissionLevel, stationSummary } from "../src/air.js";
import { readFileSync } from "node:fs";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const air = JSON.parse(readFileSync(new URL("../public/air.json", import.meta.url)));
const sanFelice = air.stations.find((station) => station.id === "porta-san-felice");
const chiarini = air.stations.find((station) => station.id === "via-chiarini");
check("three Bologna stations", air.stations.length === 3 && Boolean(sanFelice) && Boolean(chiarini));
check("a station summary names the measured gases", stationSummary(sanFelice).includes("NO2 23") && stationSummary(sanFelice).includes("PM10 25"));
check("the traffic station reads higher NO2 than the suburban background", sanFelice.no2 > chiarini.no2);

const tram = { tram: true, rank: 0.8 };
const ring = { ring: true, rank: 1 };
const view = {
  scenario: "after",
  cars: 1155,
  peakCars: 1233,
  carFlow: 246,
  beforeCarFlow: 453,
  activeLines: ["rossa"],
};
const quiet = { ...view, scenario: "before", carFlow: 453, activeLines: [] };
const closed = { ...view, activeLines: [] };
check("no open line leaves the exhaust proxy unchanged", emissionLevel(ring, closed) === emissionLevel(ring, quiet));
check("an open line lowers the proxy on its street", airPaintValue(tram, view).mode === "down");
check("diverted cars raise the proxy on the avenues", airPaintValue(ring, view).mode === "up");
check("a closed extra line is not painted", airPaintValue({ line: "verde", rank: 0.7 }, view).mode === "flat");
