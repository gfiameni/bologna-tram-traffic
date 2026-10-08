import { stationSummary } from "../src/air.js";
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
