import { finding } from "./model.js";

export function caseKey(model, scenario, shift, headway, hour) {
  return `${model}|${scenario}|${shift.toFixed(2)}|${headway.toFixed(1)}|${String(hour).padStart(2, "0")}`;
}

export function setupScore(before, after, headwayMin) {
  const extraMinutes = Math.max(0, after.carFieraMin - before.carFieraMin);
  return after.peoplePerHour - 4 * after.unserved - 90 * extraMinutes - 6 * (60 / headwayMin);
}

export function searchBestSetup(catalog, model, hour) {
  if (!catalog?.cases || !catalog.shifts || !catalog.headways) return null;
  let best = null;
  const ranked = [];
  for (const shiftValue of catalog.shifts) {
    for (const headwayMin of catalog.headways) {
      const before = catalog.cases[caseKey(model, "before", shiftValue, headwayMin, hour)];
      const after = catalog.cases[caseKey(model, "after", shiftValue, headwayMin, hour)];
      if (!before || !after) continue;
      const row = { shiftValue, headwayMin, score: setupScore(before, after, headwayMin), before, after };
      ranked.push(row);
      if (!best || row.score > best.score) best = row;
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return best ? { best, ranked } : null;
}

export function predictionSentence(modelLabel, hourLabel, best) {
  const shiftPct = Math.round(best.shiftValue * 100);
  const extra = Math.round(best.after.carFieraMin - best.before.carFieraMin);
  const carChange = extra > 0 ? `${extra} min longer` : extra < 0 ? `${Math.abs(extra)} min shorter` : "about the same";
  const people = Math.round(best.after.peoplePerHour).toLocaleString("en-GB");
  const waiting = Math.round(best.after.unserved).toLocaleString("en-GB");
  return `${modelLabel} for ${hourLabel}: ${shiftPct}% of drivers switch, tram every ${best.headwayMin} min. ${people} people an hour pass San Felice, ${waiting} are left waiting, and the car trip to the Fiera is ${carChange}.`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function minutes(value) {
  return `${Math.round(value)} min`;
}

function count(value) {
  return Math.round(value).toLocaleString("en-GB");
}

const METRICS = [
  ["Car to the Fiera", "carFieraMin", true],
  ["Car to Agraria", "carPilastroMin", true],
  ["Bicycle to the Fiera", "bikeFieraMin", true],
  ["Transit to the Fiera", "transitFieraMin", true],
  ["Transit to Agraria", "transitPilastroMin", true],
  ["Via Emilia speed", "viaEmiliaKmh", false],
  ["Cars / hour through San Felice", "carFlow", false],
  ["People / hour at San Felice", "peoplePerHour", false],
  ["Transit riders left waiting", "unserved", false],
];

function metricText(key, value, asMinutes) {
  if (asMinutes) return minutes(value);
  if (key === "viaEmiliaKmh") return `${Math.round(value)} km/h`;
  return count(value);
}

export function reportHtml({
  modelLabel,
  hourLabel,
  hourSlot,
  best,
  ranked,
  notes = [],
  generatedAt,
}) {
  const sentence = predictionSentence(modelLabel, hourLabel, best);
  const shiftPct = Math.round(best.shiftValue * 100);
  const comparison = METRICS.map(([label, key, asMinutes]) => {
    const before = metricText(key, best.before[key], asMinutes);
    const after = metricText(key, best.after[key], asMinutes);
    return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(before)}</td><td>${escapeHtml(after)}</td></tr>`;
  }).join("");
  const setups = ranked.map((row) => {
    const extra = Math.round(row.after.carFieraMin - row.before.carFieraMin);
    const chosen = row === best ? "Chosen" : "";
    return `<tr class="${chosen ? "chosen" : ""}"><td>${Math.round(row.shiftValue * 100)}%</td><td>${row.headwayMin} min</td><td>${escapeHtml(count(row.after.peoplePerHour))}</td><td>${escapeHtml(count(row.after.unserved))}</td><td>${extra > 0 ? `+${extra} min` : extra < 0 ? `${extra} min` : "same"}</td><td>${chosen}</td></tr>`;
  }).join("");
  const demand = hourSlot
    ? `<p>${escapeHtml(count(hourSlot.cars))} cars, ${escapeHtml(count(hourSlot.buses))} buses, and ${escapeHtml(count(hourSlot.bikes))} bicycles an hour are the open-data demand for this hour.</p>`
    : "";
  const notesHtml = notes.filter(Boolean).map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bologna tram network · ${escapeHtml(hourLabel)}</title>
  <style>
    body { margin: 0; background: #f4efe4; color: #1b1714; font: 16px/1.45 "Segoe UI", sans-serif; }
    main { max-width: 760px; margin: 0 auto; padding: 40px 28px 72px; }
    h1, h2 { font-family: Georgia, serif; font-weight: 560; }
    h1 { font-size: 40px; margin: 8px 0 12px; }
    h2 { font-size: 22px; margin: 32px 0 8px; }
    .eyebrow { margin: 0; letter-spacing: 0.14em; text-transform: uppercase; font-size: 12px; color: #6d645b; }
    .lead { font-size: 18px; }
    .setup { display: flex; gap: 18px; margin: 18px 0; }
    .setup div { background: #fffaf3; border-top: 3px solid #e30613; padding: 12px 14px; min-width: 140px; }
    .setup strong { display: block; font-size: 28px; }
    .setup span { color: #6d645b; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; background: #fffaf3; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e3d8c8; }
    tr.chosen { outline: 2px solid #1b1714; }
    .note, li { color: #3d352e; }
    .note { font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Bologna tram network</p>
    <h1>Best setup</h1>
    <p class="lead">${escapeHtml(sentence)}</p>
    <div class="setup">
      <div><strong>${shiftPct}%</strong><span>of drivers switch</span></div>
      <div><strong>${best.headwayMin} min</strong><span>between trams</span></div>
      <div><strong>${escapeHtml(count(best.after.peoplePerHour))}</strong><span>people / hour at San Felice</span></div>
    </div>
    <p>${escapeHtml(finding({ before: best.before, after: best.after }))}</p>
    <h2>${escapeHtml(modelLabel)} · ${escapeHtml(hourLabel)}</h2>
    ${demand}
    <table>
      <thead><tr><th></th><th>Before</th><th>With the tram</th></tr></thead>
      <tbody>${comparison}</tbody>
    </table>
    <h2>Setups compared</h2>
    <p class="note">The search ranks saved switch shares and tram frequencies for this model and hour. It favours more people through San Felice, a shorter waiting queue, less extra car time to the Fiera, and a tram that still has room.</p>
    <table>
      <thead><tr><th>Switch</th><th>Tram every</th><th>People / hour</th><th>Waiting</th><th>Car to the Fiera</th><th></th></tr></thead>
      <tbody>${setups}</tbody>
    </table>
    <h2>What the numbers rest on</h2>
    <ul>${notesHtml}</ul>
    <p class="note">Written ${escapeHtml(generatedAt)}. This is a scenario from the models in this project, not a forecast from the Comune di Bologna.</p>
  </main>
</body>
</html>
`;
}

export function downloadReport(filename, html) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
