import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { DEFAULTS, prepare, evaluate, finding } from "./model.js";
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

function caseKey(model, scenario, shift, headway, hour) {
  return `${model}|${scenario}|${shift.toFixed(2)}|${headway.toFixed(1)}|${String(hour).padStart(2, "0")}`;
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
const traffic = createTraffic(geo);
traffic.seed(state.params, metrics);

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

function congestionColor(speed) {
  const ratio = speed / state.params.freeSpeedMps;
  if (ratio > 0.72) return "#1f8a4c";
  if (ratio > 0.52) return "#e0a100";
  if (ratio > 0.36) return "#ef6c00";
  return "#9a3412";
}

function paintRoutes() {
  const speeds = metrics[state.scenario].speeds;
  for (const [name, line] of Object.entries(carLines)) {
    line.setStyle({ color: congestionColor(speeds[name]) });
  }
  const planned = state.scenario === "before";
  for (const line of plannedLines) line.setStyle({ opacity: planned ? 0.75 : 0 });
  centreLine.setStyle({ opacity: planned ? 0 : 1 });
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
  ].join(" ");
}

function paintPanel(options = {}) {
  if (!options.keep) metrics = pair();
  const before = metrics.before;
  const after = metrics.after;
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
  document.getElementById("finding").textContent = finding(metrics);
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
hourSelect.addEventListener("change", () => {
  state.hour = Number(hourSelect.value);
  document.getElementById("predict-note").textContent = "";
  paintPanel();
  paintRoutes();
  traffic.seed(state.params, metrics);
  refreshLive();
});

const modelSelect = document.getElementById("model");
if (catalog) modelSelect.value = state.model;
modelSelect.addEventListener("change", () => {
  state.model = modelSelect.value;
  paintPanel();
  paintRoutes();
  traffic.seed(state.params, metrics);
  refreshLive();
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
  refreshLive();
});

function setupScore(before, after, headwayMin) {
  const extraMinutes = Math.max(0, after.carFieraMin - before.carFieraMin);
  return after.peoplePerHour - 4 * after.unserved - 90 * extraMinutes - 6 * (60 / headwayMin);
}

document.getElementById("predict").addEventListener("click", () => {
  const note = document.getElementById("predict-note");
  if (!catalog) {
    note.textContent = "The saved catalog is required to search setups.";
    return;
  }
  let best = null;
  for (const shiftValue of catalog.shifts) {
    for (const headwayMin of catalog.headways) {
      const before = catalog.cases[caseKey(state.model, "before", shiftValue, headwayMin, state.hour)];
      const after = catalog.cases[caseKey(state.model, "after", shiftValue, headwayMin, state.hour)];
      if (!before || !after) continue;
      const score = setupScore(before, after, headwayMin);
      if (!best || score > best.score) best = { shiftValue, headwayMin, score, before, after };
    }
  }
  if (!best) {
    note.textContent = "No saved setups for this hour.";
    return;
  }
  state.params.modalShift = best.shiftValue;
  state.params.tramHeadwayMin = best.headwayMin;
  state.scenario = "after";
  shift.value = String(Math.round(best.shiftValue * 100));
  headway.value = String(best.headwayMin);
  document.getElementById("shift-value").textContent = `${shift.value}%`;
  document.getElementById("headway-value").textContent = `${best.headwayMin} min`;
  const modelName = modelSelect.selectedOptions[0]?.textContent || state.model;
  const extra = Math.round(best.after.carFieraMin - best.before.carFieraMin);
  const carChange = extra > 0 ? `${extra} min longer` : extra < 0 ? `${Math.abs(extra)} min shorter` : "about the same";
  note.textContent = `${modelName} for ${hourLabel(state.hour)}: ${shift.value}% of drivers switch, tram every ${best.headwayMin} min. ${Math.round(best.after.peoplePerHour).toLocaleString("en-GB")} people an hour pass San Felice, ${Math.round(best.after.unserved).toLocaleString("en-GB")} are left waiting, and the car trip to the Fiera is ${carChange}.`;
  paintPanel();
  paintRoutes();
  traffic.seed(state.params, metrics);
  refreshLive();
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
    traffic.step(wall * state.timeScale, state.params, metrics);
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
