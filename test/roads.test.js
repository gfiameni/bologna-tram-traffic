import { readFileSync } from "node:fs";
import { decodePath, loadRoads, losFromDelay, losFromRatio, priorityLoss, runCity, summarise } from "../src/roads.js";
import { loadCorridor, runPair } from "../src/sim/index.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const city = loadRoads(read("../public/roads.json"));
const corridor = loadCorridor(read("../public/corridor.json"));
const lines = read("../public/lines.json");

check("thousands of main roads", city.roads.length > 2000);
check("some roads are counted by loop detectors", city.roads.some((road) => road.measured.some(Boolean)));
check("every road sits inside Bologna", city.roads.every((road) => road.path.every(([lat, lon]) => lat > 44.4 && lat < 44.6 && lon > 11.2 && lon < 11.45)));
const example = decodePath("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
const expected = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
check("paths decode like Google's polyline example", example.every(([lat, lon], i) => Math.abs(lat - expected[i][0]) < 1e-9 && Math.abs(lon - expected[i][1]) < 1e-9));
check("load bands run from A to F", losFromRatio(0.5) === "A" && losFromRatio(0.95) === "E" && losFromRatio(1.1) === "F");
check("delay bands run from A to F, and overload is F", losFromDelay(8) === "A" && losFromDelay(60) === "E" && losFromDelay(5, 1.2) === "F");
check("more trams take more green with priority", priorityLoss(0.6, 3) > priorityLoss(0.6, 8));

const pair = runPair("ctm", corridor, { shift: 0.25, headway: 4.5, hour: 8, design: null });
const base = { hour: 8, shift: 0.25, extraShift: lines.extraShift, headway: 4.5, priority: true, corridor: pair, buses: 46 };
const before = runCity(city, { ...base, scenario: "before", lines: ["rossa"] });
const rossa = runCity(city, { ...base, scenario: "after", lines: ["rossa"] });
const every = ["rossa", "verde", "gialla", "blu"];
const all = runCity(city, { ...base, scenario: "after", lines: every });
const noPriority = runCity(city, { ...base, scenario: "after", lines: every, priority: false });

const verde = city.roads.filter((road) => road.tram.includes("verde") && !road.tram.includes("rossa") && !road.piece && road.lanes[0] >= 2 && road.flow[0] >= 0);
check("Verde has two-lane streets to test", verde.length > 0);
check("an open Verde line gives the tracks a lane", verde.every((road) => all.roads[road.id].lanes[0] === road.lanes[0] - 1));
check("a closed line keeps its lanes", verde.every((road) => rossa.roads[road.id].lanes[0] === road.lanes[0]));
check("before the tram no cars are diverted", before.roads.every((state) => state.extra === 0));
check("diverted cars land on parallel roads", all.roads.some((state) => state.extra > 10));
const share = (result) => summarise(city, result).congestedShare;
check("more lines, more congested kilometres", share(all) > share(before));
check("without priority cars keep more green", share(noPriority) <= share(all));
const trunk = city.roads.filter((road) => road.piece === "trunk");
check("Via Emilia Ponente follows the corridor model", trunk.length > 0 && trunk.every((road) => rossa.roads[road.id].model));
check("every road has a level of service", rossa.roads.every((state) => "ABCDEF".includes(state.los)));
check("trams add noise on their streets", all.roads.some((state) => state.trams > 0 && state.noise > state.cars));

const later = runCity(city, { ...base, scenario: "after", lines: [] });
const open = (road) => !road.piece;
check("2026 has its own loop counts", city.roads.some((road) => road.measuredAfter.some(Boolean))
  && city.roads.some((road, i) => open(road) && Math.abs(later.roads[i].cars - before.roads[i].cars) > 1));
check("without the tram a road can carry the same cars in 2024 and 2026", city.roads.every((road, i) => !open(road)
  || (later.roads[i].capacity[0] === before.roads[i].capacity[0] && later.roads[i].capacity[1] === before.roads[i].capacity[1])));
