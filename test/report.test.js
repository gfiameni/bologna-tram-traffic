import { readFileSync } from "node:fs";
import { predictionSentence, reportHtml, searchBestSetup } from "../src/report.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const catalog = JSON.parse(readFileSync(new URL("../public/catalog.json", import.meta.url)));
const found = searchBestSetup(catalog, "ctm", 21);
check("evening search finds a setup", Boolean(found));
check("evening cell transmission prefers half the drivers and an 8 min tram", found.best.shiftValue === 0.5 && found.best.headwayMin === 8);
check("chosen row is the top of the ranking", found.ranked[0] === found.best);

const sentence = predictionSentence("Cell transmission", "21:00 · evening", found.best);
check("sentence names the setup", sentence.includes("50% of drivers switch") && sentence.includes("tram every 8 min"));

const html = reportHtml({
  modelLabel: "Cell <transmission>",
  hourLabel: "21:00 · evening",
  hourSlot: catalog.hours.find((item) => item.hour === 21),
  best: found.best,
  ranked: found.ranked,
  notes: ["Cars from the boulevards."],
  generatedAt: "25 September 2026 at 10:00",
});
check("report includes the prediction", html.includes(sentence.replace("Cell transmission", "Cell &lt;transmission&gt;")) || html.includes("50% of drivers switch"));
check("report escapes the model name", html.includes("Cell &lt;transmission&gt;") && !html.includes("Cell <transmission>"));
check("report marks one chosen setup", html.includes(">Chosen<"));
check("report includes evening demand", html.includes("468") && html.includes("bicycles"));
check("report states it is a scenario", html.includes("not a forecast from the Comune di Bologna"));
