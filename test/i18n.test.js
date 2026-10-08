import { readFileSync } from "node:fs";
import { keys, noteText, tr } from "../src/i18n.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const en = new Set(keys("en"));
const it = new Set(keys("it"));
const missingIt = [...en].filter((key) => !it.has(key));
const missingEn = [...it].filter((key) => !en.has(key));
check(`every English string has an Italian one${missingIt.length ? `: ${missingIt.join(", ")}` : ""}`, !missingIt.length);
check(`every Italian string has an English one${missingEn.length ? `: ${missingEn.join(", ")}` : ""}`, !missingEn.length);

const placeholders = (text) => [...new Set(text.match(/\{\w+\}/g) || [])].sort().join(",");
const mismatched = [...en].filter((key) => placeholders(tr("en", key)) !== placeholders(tr("it", key)));
check(`placeholders match in both languages${mismatched.length ? `: ${mismatched.join(", ")}` : ""}`, !mismatched.length);

const page = [...read("../index.html").matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)].map((match) => match[1]);
const pageMissing = page.filter((key) => !en.has(key));
check(`every key in the page exists${pageMissing.length ? `: ${pageMissing.join(", ")}` : ""}`, !pageMissing.length);

const main = read("../src/main.js");
const literal = [...main.matchAll(/\bt\("([^"]+)"/g), ...main.matchAll(/\bt\([^)]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)]
  .flatMap((match) => match.slice(1))
  .filter(Boolean);
const literalMissing = [...new Set(literal)].filter((key) => !en.has(key));
check(`every literal key in main.js exists${literalMissing.length ? `: ${literalMissing.join(", ")}` : ""}`, !literalMissing.length);

const families = {
  street: ["trunk", "bypass", "city", "fiera", "pilastro"],
  place: ["centre", "viali", "rossa", "verde", "gialla", "blu", "bypass", "parallel"],
  model: ["ctm", "bpr", "idm", "surrogate"],
  modelUse: ["ctm", "bpr", "idm", "surrogate"],
  layer: ["traffic", "congestion", "air", "noise"],
  impact: ["traffic", "congestion", "air", "noise"],
  area: ["traffic", "congestion", "air", "noise"],
  caption: ["before", "after", "compare"],
  queue: ["before", "after"],
};
const familyMissing = Object.entries(families).flatMap(([family, names]) => names.map((name) => `${family}.${name}`)).filter((key) => !en.has(key));
check(`every built key exists${familyMissing.length ? `: ${familyMissing.join(", ")}` : ""}`, !familyMissing.length);

const corridor = JSON.parse(read("../public/corridor.json"));
const hours = corridor.hours.map((slot) => slot.label?.split(" · ")[1]).filter(Boolean).map((part) => `hour.${part}`);
check("every hour label has a translation", hours.every((key) => en.has(key) && it.has(key)));
const roads = JSON.parse(read("../public/roads.json"));
const lines = JSON.parse(read("../public/lines.json"));
for (const [name, text] of [
  ["roads", roads.note],
  ["lines", lines.note],
  ["signal timing", corridor.supply.signalTiming],
  ["car counts", corridor.supply.notes.cars],
]) {
  check(`the ${name} note has an Italian version`, noteText("it", text) !== text);
}
