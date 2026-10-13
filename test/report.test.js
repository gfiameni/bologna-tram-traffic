import { readFileSync } from "node:fs";
import { carChange, reportHtml, setupSentence } from "../src/report.js";
import { defaultDesign, hourRow, loadCorridor, merge, runPair } from "../src/sim/index.js";
import { loadRoads, runCity } from "../src/roads.js";
import { changedStreets, minutesLost, modeImpacts, prepareAreas, searchBestSetup } from "../src/impacts.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const corridor = loadCorridor(read("../public/corridor.json"));
const city = prepareAreas(loadRoads(read("../public/roads.json")));
const lines = read("../public/lines.json");
const NAMES = {
  trunk: "Via Emilia Ponente",
  bypass: "San Felice · Marconi · Pietramellara",
  city: "Via Matteotti · Via della Liberazione",
  fiera: "Viale Aldo Moro",
  pilastro: "Via San Donato",
};

const pair = runPair("bpr", corridor, { shift: 0.25, headway: 4.5, hour: 8, design: null });
const options = { hour: 8, lines: ["rossa"], shift: 0.25, extraShift: lines.extraShift, headway: 4.5, priority: true, corridor: pair, buses: 46 };
const cityBefore = runCity(city, { ...options, scenario: "before" });
const cityAfter = runCity(city, { ...options, scenario: "after" });
const current = {
  pair,
  impacts: modeImpacts({ pair, corridor, hour: 8, headway: 4.5, rossaOpen: true, city, cityBefore, cityAfter }),
  changed: changedStreets(city, cityBefore, cityAfter),
  lost: [minutesLost(pair.before, corridor), minutesLost(pair.after, corridor)],
};
const found = await searchBestSetup(corridor, { model: "bpr", shift: 0.25, hour: 8, design: defaultDesign() }, { yieldEvery: 0 });
const html = reportHtml({
  modelLabel: "Volume-delay",
  hourLabel: "08:00 · morning peak",
  hourSlots: { before: hourRow(corridor, 8, "before"), after: hourRow(corridor, 8, "after") },
  years: { before: 2024, after: 2026 },
  setup: { shift: 0.25, headway: 4.5, lines: ["rossa"], design: merge(null) },
  current,
  found,
  streetName: (name) => NAMES[name],
  notes: ["A note."],
  generatedAt: "8 October 2026",
});

check("the report names the streets", Object.values(NAMES).every((name) => html.includes(name)));
check("the report gives the demand of both years", html.includes("in 2024, ") && html.includes("in 2026, ") && html.includes("After, 2026"));
check("the report has no NaN or undefined", !/NaN|undefined/.test(html));
check("every trip names both ends", html.includes("Emilio Lepido to the Fiera") && html.includes("Emilio Lepido to Agraria"));
check("the report ranks ten setups", (html.match(/<tr class="(chosen)?">/g) || []).length === 10);
check("the chosen setup is marked", html.includes('<tr class="chosen">'));
check("a longer car trip is worded as longer", carChange({ carFieraMin: 30 }, { carFieraMin: 33 }) === "3 min longer");
check("the setup sentence names the trip", setupSentence("Volume-delay", "08:00", found.best).includes("from Emilio Lepido to the Fiera"));
