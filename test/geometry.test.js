import { readFileSync } from "node:fs";
import { polylineLength, prepare } from "../src/geometry.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const network = JSON.parse(readFileSync(new URL("../public/network.json", import.meta.url)));
const geo = prepare(network);
check("the tram trunk is several kilometres long", geo.lengths.tram.trunk > 3000);
check("both branches have stops", geo.stops.fiera.length > 0 && geo.stops.pilastro.length > 0);
check("stops are sorted along the line", Object.values(geo.stops).every((list) => list.every((s, i) => i === 0 || list[i - 1] <= s)));
check("the car route has the five streets", ["trunk", "bypass", "city", "fiera", "pilastro"].every((name) => geo.lengths.car[name] > 0));
const east = 1000 / (111320 * Math.cos((44.5 * Math.PI) / 180));
check("a 1 km east-west line measures about 1 km", Math.abs(polylineLength([[11.3, 44.5], [11.3 + east, 44.5]]) - 1000) < 5);
