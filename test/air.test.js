import { readingText, stationSummary } from "../src/air.js";
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
check("both years cover the same months", air.periods.before.replace(air.years.before, "") === air.periods.after.replace(air.years.after, ""));
check("a station summary names the 2024 measured gases", stationSummary(sanFelice).includes(`NO2 ${sanFelice.no2} `) && stationSummary(sanFelice).includes(`PM10 ${sanFelice.pm10} `));
check("After reads the 2026 means", stationSummary(sanFelice, "en", "after").includes(`NO2 ${sanFelice.after.no2} `));
check("Compare gives both years", readingText(sanFelice, "no2", "compare") === `${sanFelice.no2} → ${sanFelice.after.no2}`);
check("the Before air note is about 2024 alone", !/tram|After|2026/.test(air.notes.before));
check("the traffic station reads higher NO2 than the suburban background", sanFelice.no2 > chiarini.no2 && sanFelice.after.no2 > chiarini.after.no2);
