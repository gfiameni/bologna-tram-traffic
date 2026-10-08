/** The exported report. It is always in English. */
import { decibels, percent, streetRows } from "./impacts.js";

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

function share(value) {
  return `${Math.round(value * 100)}%`;
}

function signed(value, digits = 0, unit = "") {
  const rounded = Number(value.toFixed(digits));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toFixed(digits)}${unit}`;
}

function queueOf(record) {
  const trunk = record.pieces.trunk;
  return Math.max(0, trunk.carIn - Math.min(trunk.carOut, trunk.capacity));
}

export function carChange(before, after) {
  const extra = Math.round(after.carFieraMin - before.carFieraMin);
  if (extra > 0) return `${extra} min longer`;
  if (extra < 0) return `${-extra} min shorter`;
  return "about the same";
}

export function setupSentence(modelLabel, hourLabel, option) {
  const priority = option.priority ? "priority at the lights" : "no priority at the lights";
  const direction = option.direction === "oneWay" ? "one-way where the tracks run" : "streets as set";
  const lights = option.lights === "optimised" ? "optimised lights" : "lights as set";
  return `${modelLabel} at ${hourLabel}: a tram every ${option.headway} min, ${priority}, ${direction}, ${lights}. `
    + `${count(option.after.peoplePerHour)} people an hour pass Porta San Felice, ${count(option.after.unserved)} wait for a later tram, `
    + `and the car trip from Emilio Lepido to the Fiera is ${carChange(option.before, option.after)}.`;
}

function streetTable(design, rows, streetName) {
  const body = rows.after.map((row) => {
    const prior = rows.before.find((item) => item.name === row.name);
    const street = design.streets[row.name];
    const lanes = (item) => `${item.lanes} ${item.oneWay ? "one way" : "each way"}`;
    const lights = street ? `${street.cycle}/${Math.min(street.green, street.cycle - 30)} s${street.wave ? ", green wave" : ""}` : "";
    return `<tr><th>${escapeHtml(streetName(row.name))}</th><td>${street?.width ?? ""} m</td><td>${escapeHtml(lanes(prior))} → ${escapeHtml(lanes(row))}${row.forced ? " (too narrow for two-way)" : ""}</td><td>${escapeHtml(lights)}</td><td>${share(prior.ratio)} → ${share(row.ratio)}</td><td>${prior.los} → ${row.los}</td><td>${count(prior.queue)} → ${count(row.queue)}</td></tr>`;
  }).join("");
  return `<table>
      <thead><tr><th>Street</th><th>Width</th><th>Lanes</th><th>Lights after</th><th>Load</th><th>Level</th><th>Queue / hour</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function impactRows(current) {
  const { before, after } = current.pair;
  const impacts = current.impacts;
  const rows = [
    ["Cars / hour that reach Porta San Felice", count(before.carFlow), count(after.carFlow)],
    ["Cars / hour queued before Porta San Felice", count(queueOf(before)), count(queueOf(after))],
    ["Buses and trams / hour", `${count(impacts?.traffic.buses[0] ?? 0)} buses`, impacts?.traffic.trams[1] ? `${impacts.traffic.trams[1].toFixed(1)} trams each way` : `${count(impacts?.traffic.buses[1] ?? 0)} buses`],
    ["Bicycles / hour on Via Emilia", count(before.bikeFlow), count(after.bikeFlow)],
    ["Car, Emilio Lepido to the Fiera", minutes(before.carFieraMin), minutes(after.carFieraMin)],
    ["Car, Emilio Lepido to Agraria", minutes(before.carPilastroMin), minutes(after.carPilastroMin)],
    ["Transit, Emilio Lepido to the Fiera", minutes(before.transitFieraMin), minutes(after.transitFieraMin)],
    ["Transit, Emilio Lepido to Agraria", minutes(before.transitPilastroMin), minutes(after.transitPilastroMin)],
    ["Bicycle, Emilio Lepido to the Fiera", minutes(before.bikeFieraMin), minutes(after.bikeFieraMin)],
    ["People / hour at Porta San Felice", count(before.peoplePerHour), count(after.peoplePerHour)],
    ["Transit riders left waiting", count(before.unserved), count(after.unserved)],
    ["Person-minutes lost / hour on the route", count(current.lost[0]), count(current.lost[1])],
  ];
  if (impacts) {
    rows.push(
      ["Main roads at level E or F", share(impacts.congestion.city[0]), share(impacts.congestion.city[1])],
      ["Car-km / hour on the main roads", count(impacts.traffic.carKm[0]), `${count(impacts.traffic.carKm[1])} (${signed(percent(impacts.traffic.carKm[0], impacts.traffic.carKm[1]), 0, "%")})`],
      ["Exhaust on the route", "today", signed(percent(impacts.air.corridor[0], impacts.air.corridor[1]), 0, "%")],
      ["Exhaust on the main roads", "today", signed(percent(impacts.air.city[0], impacts.air.city[1]), 0, "%")],
      ["Traffic noise on the route", "today", signed(decibels(impacts.noise.corridor[0], impacts.noise.corridor[1]), 1, " dB")],
      ["Traffic noise on the main roads", "today", signed(decibels(impacts.noise.city[0], impacts.noise.city[1]), 1, " dB")],
    );
  }
  return rows.map(([label, b, a]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(b)}</td><td>${escapeHtml(a)}</td></tr>`).join("");
}

export function reportHtml({
  modelLabel,
  hourLabel,
  hourSlot,
  setup,
  current,
  found,
  streetName = (name) => name,
  notes = [],
  generatedAt,
}) {
  const lines = setup.lines.length ? setup.lines.map((id) => id[0].toUpperCase() + id.slice(1)).join(", ") : "none";
  const lead = `${modelLabel} at ${hourLabel}. A tram every ${setup.headway} min ${setup.design.priority ? "with" : "without"} priority at the lights; `
    + `${Math.round(setup.shift * 100)}% of car trips switch to the tram. Open lines: ${lines}.`;
  const demand = hourSlot
    ? `<p>${escapeHtml(count(hourSlot.cars))} cars, ${escapeHtml(count(hourSlot.buses))} buses, and ${escapeHtml(count(hourSlot.bikes))} bicycles an hour are the open-data demand for this hour. Cars enter at Emilio Lepido; those that get through arrive at Porta San Felice.</p>`
    : "";
  const changed = (current.changed || []).filter((entry) => entry.after - entry.before > 0.02).map((entry) =>
    `<li>${escapeHtml(entry.name)}: level ${entry.losBefore} → ${entry.losAfter}, load ${share(entry.before)} → ${share(entry.after)}, cars ${signed(percent(entry.carsBefore, entry.carsAfter), 0, "%")}</li>`,
  ).join("") || "<li>Main roads keep today's levels.</li>";
  const best = found?.best;
  const ranked = (found?.ranked || []).slice(0, 10).map((row) => {
    const chosen = best && row.headway === best.headway && row.priority === best.priority && row.direction === best.direction;
    return `<tr class="${chosen ? "chosen" : ""}"><td>${row.headway} min</td><td>${row.priority ? "on" : "off"}</td><td>${row.direction === "oneWay" ? "one-way on tram streets" : "as set"}</td><td>${count(row.after.peoplePerHour)}</td><td>${count(row.after.unserved)}</td><td>${carChange(row.before, row.after)}</td><td>${count(row.cost)}</td></tr>`;
  }).join("");
  const search = best
    ? `<h2>Best setup found</h2>
    <p class="lead">${escapeHtml(setupSentence(modelLabel, hourLabel, best))}</p>
    ${streetTable(best.design, { before: streetRows(best.before), after: streetRows(best.after) }, streetName)}
    <p class="note">The search tries a tram every 3 to 8 minutes, with and without priority, with the streets as set or one-way where the tracks run. It then optimises the winner's lights. The cost is person-minutes an hour: delay for every car that wants the trip and for the streets that cross it, 30 minutes for each car or rider that cannot get through, 10 for each car sent round a one-way street, the riders' time on board, and 300 for each tram an hour.</p>
    <table>
      <thead><tr><th>Tram every</th><th>Priority</th><th>Streets</th><th>People / hour</th><th>Waiting</th><th>Car, Emilio Lepido to the Fiera</th><th>Cost</th></tr></thead>
      <tbody>${ranked}</tbody>
    </table>`
    : "";
  const notesHtml = notes.filter(Boolean).map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bologna tram network · ${escapeHtml(hourLabel)}</title>
  <style>
    body { margin: 0; background: #1e1e1e; color: #ffffff; font: 16px/1.45 "Segoe UI", sans-serif; }
    main { max-width: 860px; margin: 0 auto; padding: 40px 28px 72px; }
    h1, h2 { font-weight: 560; }
    h1 { font-size: 36px; margin: 8px 0 12px; }
    h2 { font-size: 22px; margin: 32px 0 8px; }
    .eyebrow { margin: 0; letter-spacing: 0.14em; text-transform: uppercase; font-size: 12px; color: #76b900; }
    .lead { font-size: 18px; }
    table { width: 100%; border-collapse: collapse; background: #2a2a2a; margin: 8px 0; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.16); font-size: 14px; }
    tr.chosen { outline: 2px solid #76b900; }
    .note, li { color: #b5b5b5; }
    .note { font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Bologna tram network</p>
    <h1>Tram setup report</h1>
    <p class="lead">${escapeHtml(lead)}</p>
    ${demand}
    <h2>Streets on the Linea Rossa car route</h2>
    ${current.impacts ? streetTable(setup.design, current.impacts.streets, streetName) : ""}
    <p class="note">Level A to F comes from the delay at each junction. Load is cars and buses against the cars the street's lanes and green can carry.</p>
    <h2>Impact, before and after</h2>
    <table>
      <thead><tr><th></th><th>Before</th><th>After</th></tr></thead>
      <tbody>${impactRows(current)}</tbody>
    </table>
    <h2>Main roads that change most</h2>
    <ul>${changed}</ul>
    ${search}
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
