import { readFileSync } from "node:fs";
import { defaultDesign, loadCorridor, runPair } from "../src/sim/index.js";
import {
  crossMinutes,
  decibels,
  lightOptions,
  minutesLost,
  optimiseLights,
  percent,
  searchBestSetup,
  setupDesign,
  setupGrid,
  streetRows,
} from "../src/impacts.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const corridor = loadCorridor(JSON.parse(readFileSync(new URL("../public/corridor.json", import.meta.url))));
const inputs = { shift: 0.25, headway: 4.5, hour: 8 };
const run = (design) => runPair("ctm", corridor, { ...inputs, design });
const street = (record, name) => streetRows(record).find((row) => row.name === name);

const pair = run(null);
check("the street check lists five streets", streetRows(pair.after).length === 5);
check("the tracks take a lane on Via Emilia Ponente", street(pair.after, "trunk").lanes < street(pair.before, "trunk").lanes);
check("San Felice · Marconi · Pietramellara keeps its lanes", street(pair.after, "bypass").lanes === street(pair.before, "bypass").lanes);
check("half the traffic sound is about −3 dB", Math.abs(decibels(2, 1) + 3.01) < 0.01);
check("125 against 100 is +25%", Math.abs(percent(100, 125) - 25) < 1e-9);
check("more green for the main street costs the cross street more", crossMinutes(90, 60) > crossMinutes(90, 40));
check("light options leave 30 s for the cross street", lightOptions(90).every((option) => option.green <= option.cycle - 30));
check("the search grid has 11 headways, priority, and direction", setupGrid().length === 44);

const oneWay = setupDesign(corridor, defaultDesign(), { headway: 5, priority: false, direction: "oneWay" });
check("the one-way option covers the streets with tracks", Object.entries(oneWay.streets).every(([name, item]) => item.oneWay === Boolean(corridor.pieces[name].affected)));
check("the priority option is applied", oneWay.priority === false);

const narrow = defaultDesign();
narrow.streets.trunk.width = 9;
const forced = street(run(narrow).after, "trunk");
check("a 9 m street with tracks runs one-way", forced.oneWay && forced.forced);

const wide = defaultDesign();
wide.streets.trunk.width = 20;
check("a wider street lets more cars through", run(wide).after.carFlow > pair.after.carFlow);

const green = defaultDesign();
green.streets.trunk.green = 60;
check("more green lets more cars through", run(green).after.carFlow > pair.after.carFlow);

const off = defaultDesign();
off.priority = false;
const offPair = run(off);
check("without priority cars get more of the green", offPair.after.carFlow >= pair.after.carFlow);
check("without priority the tram from Emilio Lepido to the Fiera takes longer", offPair.after.transitFieraMin > pair.after.transitFieraMin);

const tuned = await optimiseLights(corridor, defaultDesign(), { model: "ctm", ...inputs }, { yieldEvery: 0 });
check("optimised lights lose fewer person-minutes", tuned.minutesLost < minutesLost(pair.after, corridor));
check("optimised lights leave 30 s for the cross streets", Object.values(tuned.design.streets).every((item) => item.green <= item.cycle - 30));

const found = await searchBestSetup(corridor, { model: "bpr", shift: 0.25, hour: 8, design: defaultDesign() }, { yieldEvery: 0 });
check("the search ranks every setup", found.ranked.length === 44);
check("the best setup costs no more than the top of the ranking", found.best.cost <= found.ranked[0].cost + 1e-9);
check("the best setup carries every rider at 08:00", found.best.after.unserved < 1);
