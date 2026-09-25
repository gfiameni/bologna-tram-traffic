import { hourCars, intensity } from "../src/heatmap.js";
import { readFileSync } from "node:fs";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const centre = JSON.parse(readFileSync(new URL("../public/centre.json", import.meta.url)));
const catalog = JSON.parse(readFileSync(new URL("../public/catalog.json", import.meta.url)));
const tram = centre.samples.filter((sample) => sample.tram).sort((a, b) => b.rank - a.rank)[0];
const ring = centre.samples.filter((sample) => sample.ring).sort((a, b) => b.rank - a.rank)[0];
const inside = centre.samples.find((sample) => !sample.tram && !sample.ring);
check("centre file has streets inside the viali", centre.samples.length > 400 && Boolean(tram) && Boolean(ring) && Boolean(inside));
check("bbox covers Porta San Felice", centre.bbox[1] < 11.33 && centre.bbox[0] < 44.5);

const morning = hourCars(catalog, 8);
const evening = hourCars(catalog, 21);
check("morning is the busy hour", morning > evening);

const viewMorning = { scenario: "before", cars: morning, peakCars: centre.peakCars, shift: 0.25 };
const viewAfter = { scenario: "after", cars: morning, peakCars: centre.peakCars, shift: 0.25 };
const viewNight = { scenario: "before", cars: evening, peakCars: centre.peakCars, shift: 0.25 };
check("tram streets cool when cars leave the centre", intensity(tram, viewAfter) < intensity(tram, viewMorning) * 0.3);
check("the avenues pick up heat when cars go around", intensity(ring, viewAfter) > intensity(ring, viewMorning));
check("evening is cooler than the morning peak", intensity(inside, viewNight) < intensity(inside, viewMorning));
check("heat stays between 0 and 1", intensity(ring, viewAfter) <= 1 && intensity(tram, viewMorning) > 0);
