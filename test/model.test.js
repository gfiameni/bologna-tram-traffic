import { readFileSync } from "node:fs";
import { prepare, evaluate, volumeDelay, DEFAULTS } from "../src/model.js";

const network = JSON.parse(readFileSync(new URL("../public/network.json", import.meta.url)));
const geo = prepare(network);
const result = evaluate(geo, { ...DEFAULTS });

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const km = (meters) => (meters / 1000).toFixed(2);
console.log("lengths km", {
  tramTrunk: km(geo.lengths.tram.trunk),
  tramFiera: km(geo.lengths.tram.fiera),
  tramPilastro: km(geo.lengths.tram.pilastro),
  carTrunk: km(geo.lengths.car.trunk),
  carBypass: km(geo.lengths.car.bypass),
  carCity: km(geo.lengths.car.city),
});
console.log("before", {
  carFiera: result.before.carFieraMin.toFixed(1),
  carPilastro: result.before.carPilastroMin.toFixed(1),
  busFiera: result.before.transitFieraMin.toFixed(1),
  busPilastro: result.before.transitPilastroMin.toFixed(1),
  viaEmilia: result.before.viaEmiliaKmh.toFixed(1),
  people: Math.round(result.before.peoplePerHour),
  unserved: Math.round(result.before.unserved),
});
console.log("after", {
  carFiera: result.after.carFieraMin.toFixed(1),
  carPilastro: result.after.carPilastroMin.toFixed(1),
  tramFiera: result.after.transitFieraMin.toFixed(1),
  tramPilastro: result.after.transitPilastroMin.toFixed(1),
  viaEmilia: result.after.viaEmiliaKmh.toFixed(1),
  people: Math.round(result.after.peoplePerHour),
  unserved: Math.round(result.after.unserved),
  load: result.after.transitLoad.toFixed(2),
});

check("volume delay slows an overloaded street", volumeDelay(1800, 900, 10) < volumeDelay(900, 900, 10));
check("tram trunk is the via Emilia–centre corridor", geo.lengths.tram.trunk > 8000 && geo.lengths.tram.trunk < 14000);
check("car bypass avoids the centre", geo.lengths.car.bypass > 1500 && geo.lengths.car.bypass < 4500);
check("pilastro branch reaches Agraria", geo.lengths.tram.pilastro > 4000 && geo.lengths.tram.pilastro < 8000);
check("default cars are slower on via Emilia after the lane is taken", result.after.viaEmiliaKmh < result.before.viaEmiliaKmh - 3);
check("tram to the Fiera is in the published ballpark", result.after.transitFieraMin > 30 && result.after.transitFieraMin < 48);
check("tram to Agraria is in the published ballpark", result.after.transitPilastroMin > 40 && result.after.transitPilastroMin < 62);
check("buses are slower than the tram to the Fiera", result.before.transitFieraMin > result.after.transitFieraMin + 2);
check("the tram carries more people past San Felice", result.after.peoplePerHour > result.before.peoplePerHour + 200);

const heavy = evaluate(geo, { ...DEFAULTS, modalShift: 0.5 });
check("a large shift gives the lane back as speed", heavy.after.viaEmiliaKmh > result.after.viaEmiliaKmh + 2);
