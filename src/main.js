import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { DEFAULTS, prepare, evaluate, finding } from "./model.js";
import { caseKey, predictionSentence, reportHtml, downloadReport, searchBestSetup } from "./report.js";
import { createHeat, hourCars } from "./heatmap.js";
import { withLines } from "./lines.js";
import { createTraffic } from "./traffic.js";

async function main() {
const network = await fetch("/network.json").then((response) => response.json());
const geo = prepare(network);
const state = {
  scenario: "before",
  playing: true,
  timeScale: 40,
  model: "ctm",
  hour: 8,
  heatmap: false,
  lines: ["rossa"],
  params: { ...DEFAULTS },
};

let catalog = null;
try {
  const response = await fetch("/catalog.json");
  if (response.ok) catalog = await response.json();
} catch {
  catalog = null;
}
if (catalog?.defaultModel) state.model = catalog.defaultModel;
if (catalog?.defaultHour) state.hour = catalog.defaultHour;

let linesPlan = null;
try {
  const response = await fetch("/lines.json");
  if (response.ok) linesPlan = await response.json();
} catch {
  linesPlan = null;
}
let centre = null;
try {
  const response = await fetch("/centre.json");
  if (response.ok) centre = await response.json();
} catch {
  centre = null;
}

function hourLabel(hour) {
  const slot = catalog?.hours?.find((item) => item.hour === hour);
  return slot?.label || `${String(hour).padStart(2, "0")}:00`;
}

function nearest(value, options) {
  return options.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best));
}

function pair() {
  if (!catalog) return evaluate(geo, state.params);
  const shift = nearest(state.params.modalShift, catalog.shifts);
  const headway = nearest(state.params.tramHeadwayMin, catalog.headways);
  const before = catalog.cases[caseKey(state.model, "before", shift, headway, state.hour)];
  const after = catalog.cases[caseKey(state.model, "after", shift, headway, state.hour)];
  if (!before || !after) return evaluate(geo, state.params);
  const exact = Math.abs(shift - state.params.modalShift) < 0.001 && Math.abs(headway - state.params.tramHeadwayMin) < 0.01;
  return { before, after, snapped: !exact, shift, headway };
}

let metrics = pair();
function shown() {
  return withLines(metrics, state.lines, linesPlan);
}
const traffic = createTraffic(geo);
traffic.seed(state.params, shown());

const map = L.map("map", { zoomControl: false, minZoom: 12, maxZoom: 18 });
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
L.control.scale({ imperial: false, position: "topright" }).addTo(map);

function sliceLatLngs(poly, start, end) {
  const points = poly.points;
  const at = (distance) => {
    let index = 0;
    while (index < points.length - 2 && points[index + 1].s < distance) index += 1;
    const a = points[index];
    const b = points[Math.min(points.length - 1, index + 1)];
    const span = b.s - a.s || 1;
    const t = Math.max(0, Math.min(1, (distance - a.s) / span));
    return [a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t];
  };
  const line = [at(start)];
  for (const point of points) {
    if (point.s > start && point.s < end) line.push([point.lat, point.lon]);
  }
  line.push(at(end));
  return line;
}

const carLines = {};
const plannedLines = [];
for (const [name, poly] of Object.entries(geo.pieces.car)) {
  const latlngs = poly.points.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, {
    color: "#f4efe4",
    weight: 12,
    opacity: 0.92,
    lineCap: "round",
    interactive: false,
  }).addTo(map);
  carLines[name] = L.polyline(latlngs, {
    weight: 6,
    opacity: 0.95,
    lineCap: "round",
    interactive: false,
  }).addTo(map);
}
for (const poly of Object.values(geo.pieces.tram)) {
  plannedLines.push(L.polyline(poly.points.map((p) => [p.lat, p.lon]), {
    color: "#e30613",
    weight: 2,
    dashArray: "1 9",
    opacity: 0.7,
    interactive: false,
  }).addTo(map));
}
const centreEnd = geo.lengths.tram.trunk - geo.lengths.car.city;
const centreLine = L.polyline(sliceLatLngs(geo.pieces.tram.trunk, geo.screenS, centreEnd), {
  color: "#e30613",
  weight: 5,
  opacity: 0,
  lineCap: "round",
  interactive: false,
}).addTo(map);

for (const stop of network.stops) {
  L.circleMarker([stop.lat, stop.lon], {
    radius: 4,
    color: "#1b1714",
    weight: 1,
    fillColor: "#fffaf3",
    fillOpacity: 1,
  }).bindTooltip(stop.name, { direction: "top", offset: [0, -6] }).addTo(map);
}

const extraLayers = [];
if (linesPlan) {
  for (const line of linesPlan.lines) {
    if (line.id === "rossa") continue;
    const layers = line.segments.map((segment) => L.polyline(segment, {
      color: line.color,
      weight: 4,
      opacity: 0.25,
      dashArray: "5 8",
      lineCap: "round",
      interactive: false,
    }).addTo(map));
    extraLayers.push({ id: line.id, layers });
  }
}

const bounds = L.latLngBounds(network.stops.map((stop) => [stop.lat, stop.lon]));
map.fitBounds(bounds, {
  paddingTopLeft: [window.innerWidth > 800 ? 430 : 24, 24],
  paddingBottomRight: [24, 70],
});

const canvas = document.getElementById("vehicles");
const ctx = canvas.getContext("2d");

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
resize();
window.addEventListener("resize", resize);

const heatCanvas = document.getElementById("heat");
const heat = centre ? createHeat(map, heatCanvas, centre, linesPlan) : null;
if (heat) {
  const heatResize = () => {
    heat.resize();
    paintHeat();
  };
  heatResize();
  window.addEventListener("resize", heatResize);
}

function paintHeat() {
  if (!heat) return;
  const current = shown();
  const carFlow = current[state.scenario].carFlow;
  const beforeCarFlow = current.before.carFlow;
  heat.paint({
    heatmap: state.heatmap,
    scenario: state.scenario,
    cars: hourCars(catalog, state.hour),
    peakCars: centre.peakCars,
    carFlow,
    beforeCarFlow,
    activeLines: state.lines,
  });
  document.getElementById("vehicles").classList.toggle("dim", state.heatmap);
  document.getElementById("heat-toggle").setAttribute("aria-pressed", String(state.heatmap));
  document.getElementById("heat-key").hidden = !state.heatmap;
  const open = state.lines.map((id) => linesPlan?.lines?.find((line) => line.id === id)?.name || id);
  document.getElementById("heat-note").textContent = state.heatmap
    ? `${Math.round(carFlow).toLocaleString("en-GB")} modeled cars/hour feed the centre heat${state.scenario === "after" && open.length ? `, with ${open.join(", ")} open` : ""}.`
    : "";
}

function congestionColor(speed) {
  const ratio = speed / state.params.freeSpeedMps;
  if (ratio > 0.72) return "#1f8a4c";
  if (ratio > 0.52) return "#e0a100";
  if (ratio > 0.36) return "#ef6c00";
  return "#9a3412";
}

function paintRoutes() {
  const current = shown();
  const speeds = current[state.scenario].speeds;
  for (const [name, line] of Object.entries(carLines)) {
    line.setStyle({ color: congestionColor(speeds[name]) });
  }
  const rossaOn = state.scenario === "after" && state.lines.includes("rossa");
  for (const line of plannedLines) line.setStyle({ opacity: rossaOn ? 0 : 0.75 });
  centreLine.setStyle({ opacity: rossaOn ? 1 : 0 });
  const after = state.scenario === "after";
  for (const item of extraLayers) {
    const on = state.lines.includes(item.id);
    for (const layer of item.layers) {
      layer.setStyle({
        opacity: on ? (after ? 0.95 : 0.45) : 0.18,
        weight: on && after ? 5 : 3,
        dashArray: on && after ? null : "5 8",
      });
    }
  }
  paintHeat();
}

function formatMinutes(value) {
  return `${Math.round(value)} min`;
}

function assumptionText() {
  if (!catalog) {
    return "The saved model catalog is missing, so the page is using the browser volume-delay curve. Run python -m sim.catalog to build the cell, car-following, and neural models.";
  }
  const supply = catalog.supply;
  const device = catalog.device;
  return [
    supply.notes.cars,
    supply.notes.bikes,
    supply.notes.buses,
    supply.signalTiming,
    `The neural surrogate is a 12-neuron network trained on cell-transmission runs of this corridor. Its holdout error is ${catalog.surrogate.holdoutMinutesMae} minutes per street.`,
    (reportedCuda ?? device.cuda)
      ? "Cell transmission and car following are Warp kernels, running on CUDA."
      : "Cell transmission and car following are Warp kernels. This page is using the NumPy copy of those updates, which the tests match to Warp. The model server runs the kernels on CUDA when Warp reports a GPU.",
    "With the tram, the buses counted at Porta San Felice leave the alignment, a share of drivers switch, and streets with tracks give up a lane. Cars go around the centre on the avenues. Bicycles stay on the corridor, including through the centre. Passenger service is expected in 2027. This is a scenario, not a forecast from the Comune.",
    linesPlan?.note,
    centre?.note,
  ].filter(Boolean).join(" ");
}

function paintPanel(options = {}) {
  if (!options.keep) metrics = pair();
  const current = shown();
  const before = current.before;
  const after = current.after;
  document.getElementById("when").textContent = `Bologna · ${hourLabel(state.hour)}`;
  document.getElementById("assumptions").textContent = assumptionText();
  const snap = document.getElementById("snap");
  if (metrics.snapped) {
    snap.textContent = `Showing the nearest saved case: ${Math.round(metrics.shift * 100)}% switch, tram every ${metrics.headway} min.`;
  } else if (metrics.live) {
    snap.textContent = metrics.cuda ? "Computed on CUDA for these slider values." : "Computed for these slider values.";
  } else {
    snap.textContent = "";
  }
  document.getElementById("speed-before").textContent = `${Math.round(before.viaEmiliaKmh)}`;
  document.getElementById("speed-after").textContent = `${Math.round(after.viaEmiliaKmh)}`;
  const extras = state.lines.filter((id) => id !== "rossa");
  const extraNames = extras.map((id) => linesPlan?.lines?.find((line) => line.id === id)?.name || id);
  const joined = extraNames.length < 2
    ? extraNames.join("")
    : `${extraNames.slice(0, -1).join(", ")} and ${extraNames.at(-1)}`;
  const base = state.lines.includes("rossa")
    ? finding(current)
    : "Rossa is off, so that corridor keeps its lanes and its car times.";
  const lineSentence = joined
    ? ` ${joined} ${extraNames.length === 1 ? "is" : "are"} also open, so this scenario leaves ${Math.round(after.carFlow).toLocaleString("en-GB")} cars an hour.`
    : "";
  document.getElementById("finding").textContent = `${base}${lineSentence}`;
  const rows = {
    carFieraMin: [before.carFieraMin, after.carFieraMin],
    carPilastroMin: [before.carPilastroMin, after.carPilastroMin],
    bikeFieraMin: [before.bikeFieraMin, after.bikeFieraMin],
    transitFieraMin: [before.transitFieraMin, after.transitFieraMin],
    transitPilastroMin: [before.transitPilastroMin, after.transitPilastroMin],
    carFlow: [before.carFlow, after.carFlow],
    peoplePerHour: [before.peoplePerHour, after.peoplePerHour],
    unserved: [before.unserved, after.unserved],
  };
  for (const [key, values] of Object.entries(rows)) {
    const cells = document.querySelectorAll(`tr[data-key="${key}"] td`);
    values.forEach((value, index) => {
      const text = key.endsWith("Min")
        ? formatMinutes(value)
        : Math.round(value).toLocaleString("en-GB");
      cells[index].textContent = text;
      cells[index].classList.toggle("active", (index === 0 ? "before" : "after") === state.scenario);
    });
  }
  document.getElementById("show-before").setAttribute("aria-pressed", String(state.scenario === "before"));
  document.getElementById("show-after").setAttribute("aria-pressed", String(state.scenario === "after"));
}

let reportedCuda = null;
let requestToken = 0;
async function refreshLive() {
  const token = ++requestToken;
  try {
    const response = await fetch("http://127.0.0.1:8765/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: state.model,
        shift: state.params.modalShift,
        headway: state.params.tramHeadwayMin,
        hour: state.hour,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok || token !== requestToken) return;
    const data = await response.json();
    if (!data.before || !data.after || token !== requestToken) return;
    reportedCuda = Boolean(data.cuda);
    metrics = { before: data.before, after: data.after, live: true, cuda: data.cuda, snapped: false };
    paintPanel({ keep: true });
    paintRoutes();
  } catch {
    // The saved catalog stays on screen when the model server is not running.
  }
}

const hourSelect = document.getElementById("hour");
for (const slot of catalog?.hours || [{ hour: 8, label: "08:00 · morning peak" }]) {
  const option = document.createElement("option");
  option.value = String(slot.hour);
  option.textContent = slot.label;
  hourSelect.append(option);
}
hourSelect.value = String(state.hour);

let dayTimer = 0;
const dayButton = document.getElementById("play-day");
function stopDay() {
  if (dayTimer) {
    clearInterval(dayTimer);
    dayTimer = 0;
  }
  dayButton.textContent = "Play the day";
  dayButton.setAttribute("aria-pressed", "false");
}
function applyHour(hour, live) {
  state.hour = hour;
  hourSelect.value = String(hour);
  document.getElementById("predict-note").textContent = "";
  paintPanel();
  paintRoutes();
  traffic.seed(state.params, shown());
  if (live) refreshLive();
  else requestToken += 1;
}
hourSelect.addEventListener("change", () => {
  stopDay();
  applyHour(Number(hourSelect.value), true);
});
dayButton.addEventListener("click", () => {
  if (dayTimer) {
    stopDay();
    return;
  }
  const hours = (catalog?.hours || [{ hour: state.hour }]).map((slot) => slot.hour);
  state.heatmap = true;
  dayButton.textContent = "Stop the day";
  dayButton.setAttribute("aria-pressed", "true");
  let index = 0;
  applyHour(hours[0], false);
  dayTimer = setInterval(() => {
    index += 1;
    if (index >= hours.length) {
      stopDay();
      return;
    }
    applyHour(hours[index], false);
  }, 1400);
});

const modelSelect = document.getElementById("model");
if (catalog) modelSelect.value = state.model;
modelSelect.addEventListener("change", () => {
  state.model = modelSelect.value;
  paintPanel();
  paintRoutes();
  traffic.seed(state.params, shown());
  refreshLive();
});

document.getElementById("lines").addEventListener("change", () => {
  state.lines = [...document.querySelectorAll("#lines input:checked")].map((input) => input.value);
  if (state.lines.some((id) => id !== "rossa")) state.scenario = "after";
  paintPanel({ keep: Boolean(metrics.live) });
  paintRoutes();
  traffic.seed(state.params, shown());
});

document.getElementById("show-before").addEventListener("click", () => {
  state.scenario = "before";
  paintPanel({ keep: Boolean(metrics.live) });
  paintRoutes();
});
document.getElementById("show-after").addEventListener("click", () => {
  state.scenario = "after";
  paintPanel({ keep: Boolean(metrics.live) });
  paintRoutes();
});

const heatToggle = document.getElementById("heat-toggle");
if (!centre) heatToggle.hidden = true;
heatToggle.addEventListener("click", () => {
  state.heatmap = !state.heatmap;
  paintHeat();
  if (state.heatmap && heat) heat.showCentre();
});

const shift = document.getElementById("shift");
const headway = document.getElementById("headway");
shift.addEventListener("input", () => {
  state.params.modalShift = Number(shift.value) / 100;
  document.getElementById("shift-value").textContent = `${shift.value}%`;
  paintPanel();
  paintRoutes();
  refreshLive();
});
headway.addEventListener("input", () => {
  state.params.tramHeadwayMin = Number(headway.value);
  document.getElementById("headway-value").textContent = `${headway.value} min`;
  paintPanel();
  paintRoutes();
  refreshLive();
});

function currentBest() {
  if (!catalog) return null;
  return searchBestSetup(catalog, state.model, state.hour);
}

function modelLabel() {
  return modelSelect.selectedOptions[0]?.textContent || state.model;
}

document.getElementById("predict").addEventListener("click", () => {
  const note = document.getElementById("predict-note");
  const found = currentBest();
  if (!found) {
    note.textContent = catalog ? "No saved setups for this hour." : "The saved catalog is required to search setups.";
    return;
  }
  const { best } = found;
  state.params.modalShift = best.shiftValue;
  state.params.tramHeadwayMin = best.headwayMin;
  state.scenario = "after";
  shift.value = String(Math.round(best.shiftValue * 100));
  headway.value = String(best.headwayMin);
  document.getElementById("shift-value").textContent = `${shift.value}%`;
  document.getElementById("headway-value").textContent = `${best.headwayMin} min`;
  note.textContent = predictionSentence(modelLabel(), hourLabel(state.hour), best);
  paintPanel();
  paintRoutes();
  traffic.seed(state.params, shown());
  refreshLive();
});

document.getElementById("export-report").addEventListener("click", () => {
  const note = document.getElementById("predict-note");
  const found = currentBest();
  if (!found) {
    note.textContent = catalog ? "No saved setups for this hour." : "The saved catalog is required to write the report.";
    return;
  }
  const label = modelLabel();
  const when = hourLabel(state.hour);
  const sentence = predictionSentence(label, when, found.best);
  const slot = catalog.hours?.find((item) => item.hour === state.hour);
  const supply = catalog.supply;
  const html = reportHtml({
    modelLabel: label,
    hourLabel: when,
    hourSlot: slot,
    best: found.best,
    ranked: found.ranked,
    notes: [
      supply?.notes?.cars,
      supply?.notes?.bikes,
      supply?.notes?.buses,
      supply?.signalTiming,
      "With the tram, the buses counted at Porta San Felice leave the alignment, a share of drivers switch, and streets with tracks give up a lane. Cars go around the centre on the avenues.",
    ],
    generatedAt: new Date().toLocaleString("en-GB", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "Europe/Rome",
    }),
  });
  const hour = String(state.hour).padStart(2, "0");
  downloadReport(`linea-rossa-${hour}-${state.model}.html`, html);
  note.textContent = sentence;
});

document.getElementById("play").addEventListener("click", () => {
  state.playing = !state.playing;
  document.getElementById("play").textContent = state.playing ? "Pause" : "Play";
});
for (const button of document.querySelectorAll(".scale button")) {
  button.addEventListener("click", () => {
    state.timeScale = Number(button.dataset.scale);
    for (const other of document.querySelectorAll(".scale button")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });
}

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    document.getElementById("play").click();
  } else if (event.key === "1") document.getElementById("show-before").click();
  else if (event.key === "2") document.getElementById("show-after").click();
});

function drawVehicle(vehicle, kind) {
  const here = traffic.locate(vehicle);
  const point = map.latLngToContainerPoint([here.lat, here.lon]);
  const ahead = map.latLngToContainerPoint([here.lat2, here.lon2]);
  if (point.x < -20 || point.y < -20 || point.x > canvas.clientWidth + 20 || point.y > canvas.clientHeight + 20) return;
  const angle = Math.atan2(ahead.y - point.y, ahead.x - point.x);
  const side = kind === "tram" ? 0 : kind === "bike" ? 12 * (vehicle.dir > 0 ? 1 : -1) : kind === "bus" ? 7 : 8 * (vehicle.dir > 0 ? 1 : -1);
  ctx.save();
  ctx.translate(point.x + Math.sin(angle) * side, point.y - Math.cos(angle) * side);
  ctx.rotate(angle);
  if (kind === "tram") {
    ctx.fillStyle = "#e30613";
    ctx.fillRect(-13, -2.6, 26, 5.2);
    ctx.fillStyle = "#fff6ee";
    ctx.fillRect(-8, -1.3, 16, 2.4);
  } else if (kind === "bus") {
    ctx.fillStyle = "#1e4f86";
    ctx.fillRect(-8, -2.2, 16, 4.4);
  } else if (kind === "bike") {
    ctx.fillStyle = "#1f8a4c";
    ctx.fillRect(-2.2, -0.7, 4.4, 1.4);
  } else {
    ctx.fillStyle = "#243040";
    ctx.fillRect(-3.2, -1.3, 6.4, 2.6);
  }
  ctx.restore();
}

let last = performance.now();
let styleTimer = 0;
function frame(now) {
  const wall = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.playing) {
    traffic.step(wall * state.timeScale, state.params, shown());
    styleTimer += wall;
    if (styleTimer > 0.4) {
      styleTimer = 0;
      paintRoutes();
    }
  }
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const vehicles = traffic.vehicles(state.scenario);
  const zoom = map.getZoom();
  const carStride = zoom >= 15 ? 1 : zoom >= 14 ? 3 : 10;
  let carIndex = 0;
  for (const vehicle of vehicles) {
    if (vehicle.mode !== "car") continue;
    if (carIndex++ % carStride !== 0) continue;
    drawVehicle(vehicle, "car");
  }
  for (const vehicle of vehicles) {
    if (vehicle.mode === "car") continue;
    drawVehicle(vehicle, vehicle.mode);
  }
  requestAnimationFrame(frame);
}

paintPanel();
paintRoutes();
refreshLive();
map.on("move zoom resize", () => paintRoutes());
requestAnimationFrame(frame);
}

main().catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<p id="boot-error">${error.message}</p>`);
  console.error(error);
});
