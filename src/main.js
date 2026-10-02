import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { DEFAULTS, prepare, evaluate, applyTramPriority, carGreenSec } from "./model.js";
import { LANGS, tr, count, hourText, noteText, locale } from "./i18n.js";
import { caseKey, reportHtml, downloadReport, searchBestSetup } from "./report.js";
import { createHeat, hourCars, placeCongestion } from "./heatmap.js";
import { createAir, stationSummary } from "./air.js";
import { extraShift, withLines } from "./lines.js";
import { createTraffic } from "./traffic.js";

async function main() {
const network = await fetch("/network.json").then((response) => response.json());
const geo = prepare(network);
const state = {
  scenario: "before",
  view: "before",
  playing: true,
  timeScale: 40,
  model: "ctm",
  hour: 8,
  heatmap: true,
  air: false,
  sensors: false,
  lines: ["rossa"],
  params: { ...DEFAULTS },
  lang: startLang(),
};

function startLang() {
  const asked = new URLSearchParams(location.search).get("lang");
  if (LANGS.includes(asked)) return asked;
  const saved = localStorage.getItem("lang");
  if (LANGS.includes(saved)) return saved;
  return navigator.language?.toLowerCase().startsWith("it") ? "it" : "en";
}

function t(key, vars) {
  return tr(state.lang, key, vars);
}

function applyStatic() {
  document.documentElement.lang = state.lang;
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-html]")) node.innerHTML = t(node.dataset.i18nHtml);
  for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", t(node.dataset.i18nAria));
  for (const button of document.querySelectorAll(".lang button")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === state.lang));
  }
}
applyStatic();

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
let airData = null;
try {
  const response = await fetch("/air.json");
  if (response.ok) airData = await response.json();
} catch {
  airData = null;
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
  return slot?.label ? hourText(state.lang, slot.label) : `${String(hour).padStart(2, "0")}:00`;
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
  return applyTramPriority({ before, after, snapped: !exact, shift, headway }, headway);
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

map.createPane("tramlines");
map.getPane("tramlines").style.zIndex = 450;

const plannedLines = [];
const bypassSamples = (geo.pieces.car.bypass?.points || [])
  .filter((point, index) => index % 2 === 0)
  .map((point) => ({ lat: point.lat, lon: point.lon, bypass: true, rank: 0.7 }));
for (const poly of Object.values(geo.pieces.tram)) {
  const latlngs = poly.points.map((p) => [p.lat, p.lon]);
  const casing = L.polyline(latlngs, {
    pane: "tramlines",
    color: "#fffaf3",
    weight: 9,
    opacity: 0,
    lineCap: "round",
    interactive: false,
  }).addTo(map);
  const line = L.polyline(latlngs, {
    pane: "tramlines",
    color: "#e30613",
    weight: 5,
    opacity: 0,
    lineCap: "round",
    interactive: false,
  }).addTo(map);
  plannedLines.push({ casing, line });
}

const stopLayer = L.layerGroup();
for (const stop of network.stops) {
  L.circleMarker([stop.lat, stop.lon], {
    radius: 4,
    color: "#1b1714",
    weight: 1,
    fillColor: "#fffaf3",
    fillOpacity: 1,
  }).bindTooltip(stop.name, { direction: "top", offset: [0, -6] }).addTo(stopLayer);
}

const extraLayers = [];
if (linesPlan) {
  for (const line of linesPlan.lines) {
    if (line.id !== "rossa") {
      const casing = line.segments.map((segment) => L.polyline(segment, {
        pane: "tramlines",
        color: "#fffaf3",
        weight: 9,
        opacity: 0,
        lineCap: "round",
        interactive: false,
      }).addTo(map));
      const layers = line.segments.map((segment) => L.polyline(segment, {
        pane: "tramlines",
        color: line.color,
        weight: 5,
        opacity: 0,
        lineCap: "round",
        interactive: false,
      }).addTo(map));
      extraLayers.push({ id: line.id, casing, layers });
    }
  }
}

map.createPane("sensors");
const sensorPane = map.getPane("sensors");
sensorPane.style.zIndex = "640";
sensorPane.style.pointerEvents = "none";

const sensorLayer = airData?.stations?.length
  ? L.layerGroup(airData.stations.map((station) => {
    const direction = {
      "via-chiarini": "left",
      "porta-san-felice": "bottom",
      "giardini-margherita": "right",
    }[station.id] || "right";
    const offset = {
      left: [-8, 0],
      top: [0, -10],
      bottom: [0, 10],
      right: [8, 0],
    }[direction];
    const marker = L.circleMarker([station.lat, station.lon], {
      pane: "sensors",
      radius: 7,
      color: "#f4efe4",
      weight: 2,
      fillColor: "#4c1d95",
      fillOpacity: 1,
    });
    marker.bindTooltip(station.name, {
      permanent: true,
      direction,
      className: "sensor-tip",
      offset,
    });
    marker.bindPopup(() => `<strong>${station.name}</strong><br>${stationSummary(station, state.lang)}`);
    return marker;
  }))
  : null;

const bounds = L.latLngBounds(network.stops.map((stop) => [stop.lat, stop.lon]));
for (const line of linesPlan?.lines || []) {
  for (const segment of line.segments || []) bounds.extend(segment);
}
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
const heat = centre ? createHeat(map, heatCanvas, centre, linesPlan, bypassSamples) : null;
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
    mode: state.view,
    scenario: state.scenario,
    cars: hourCars(catalog, state.hour),
    peakCars: centre.peakCars,
    carFlow,
    beforeCarFlow,
    afterCarFlow: current.after.carFlow,
    activeLines: state.lines,
  });
  document.getElementById("vehicles").classList.toggle("dim", state.heatmap || state.air);
  document.getElementById("heat-toggle").setAttribute("aria-pressed", String(state.heatmap));
  document.querySelector(".scale-key").hidden = !state.heatmap;
}

function paintRoutes() {
  const rossaOn = state.scenario === "after" && state.lines.includes("rossa");
  const scale = document.querySelector(".scale-key");
  const labels = scale ? [...scale.querySelectorAll("span")] : [];
  if (labels.length === 2) {
    const compare = state.view === "compare";
    labels[0].textContent = t(compare ? "legend.less" : "legend.fast");
    labels[1].textContent = t(compare ? "legend.more" : "legend.slow");
  }
  for (const { casing, line } of plannedLines) {
    casing.setStyle({ opacity: rossaOn ? 1 : 0 });
    line.setStyle({ opacity: rossaOn ? 1 : 0 });
  }
  if (rossaOn) stopLayer.addTo(map);
  else stopLayer.remove();
  const after = state.scenario === "after";
  for (const item of extraLayers) {
    const open = after && state.lines.includes(item.id);
    for (const layer of item.casing) layer.setStyle({ opacity: open ? 1 : 0, weight: 9 });
    for (const layer of item.layers) {
      layer.setStyle({ opacity: open ? 0.95 : 0, weight: 5, dashArray: null });
    }
  }
  paintHeat();
  paintAir();
}

function formatMinutes(value) {
  return `${Math.round(value)} min`;
}

function assumptionText() {
  if (!catalog) return t("assume.noCatalog");
  const supply = catalog.supply;
  const device = catalog.device;
  const note = (text) => noteText(state.lang, text);
  return [
    note(supply.notes.cars),
    note(supply.notes.bikes),
    note(supply.notes.buses),
    note(supply.signalTiming),
    t("assume.surrogate", { mae: catalog.surrogate.holdoutMinutesMae.toLocaleString(locale(state.lang)) }),
    (reportedCuda ?? device.cuda) ? t("assume.cuda") : t("assume.numpy"),
    t("assume.scenario"),
    note(linesPlan?.note),
    note(centre?.note),
    note(airData?.note),
  ].filter(Boolean).join(" ");
}

function carAccount(record, scenario) {
  const asked = hourCars(catalog, state.hour);
  const switched = scenario === "after" && state.lines.includes("rossa") ? state.params.modalShift : 0;
  const extra = scenario === "after" ? extraShift(linesPlan, state.lines) : 0;
  const demand = asked * (1 - switched) * (1 - extra);
  const passing = record.carFlow;
  return { demand, passing, queued: Math.max(0, demand - passing) };
}

function carLine(account, compare) {
  const n = (value) => count(state.lang, value);
  if (!compare) {
    return account.queued < 1
      ? t("impact.carsClear", { demand: n(account.demand), pass: n(account.passing) })
      : t("impact.carsNow", { demand: n(account.demand), pass: n(account.passing), queue: n(account.queued) });
  }
  const [before, after] = compare;
  const queued = before.queued >= 1 || after.queued >= 1;
  return t(queued ? "impact.carsCompare" : "impact.carsCompareClear", {
    demandBefore: n(before.demand),
    demandAfter: n(after.demand),
    passBefore: n(before.passing),
    passAfter: n(after.passing),
    queueBefore: n(before.queued),
    queueAfter: n(after.queued),
  });
}

function paintImpact(current) {
  const { before, after } = current;
  const rossaOn = state.lines.includes("rossa");
  const beforeCars = carAccount(before, "before");
  const afterCars = carAccount(after, "after");
  const set = (id, text) => {
    document.getElementById(id).textContent = text;
  };
  const trips = (record, fieraKey, agrariaKey) => t("impact.trips", {
    fiera: Math.round(record[fieraKey]),
    agraria: Math.round(record[agrariaKey]),
  });
  if (state.view !== "compare") {
    const record = state.view === "after" ? after : before;
    const trams = state.view === "after" && rossaOn;
    set("impact-cars-value", carLine(state.view === "after" ? afterCars : beforeCars));
    set("impact-cars-detail", trips(record, "carFieraMin", "carPilastroMin"));
    set("impact-bikes-value", t("impact.bikesNow", { n: Math.round(record.bikeFieraMin) }));
    set("impact-bikes-detail", "");
    set("impact-transit-value", t(trams ? "impact.tram" : "impact.bus"));
    set("impact-transit-detail", trips(record, "transitFieraMin", "transitPilastroMin"));
    set("impact-air-value", state.view === "after" && state.lines.length ? t("impact.airShift") : t("impact.airNow"));
    return;
  }
  set("impact-cars-value", carLine(null, [beforeCars, afterCars]));
  const delta = (fieraKey, agrariaKey) => t("impact.tripsDelta", {
    fieraBefore: Math.round(before[fieraKey]),
    fieraAfter: Math.round(after[fieraKey]),
    agrariaBefore: Math.round(before[agrariaKey]),
    agrariaAfter: Math.round(after[agrariaKey]),
  });
  set("impact-cars-detail", delta("carFieraMin", "carPilastroMin"));
  const bikeBefore = Math.round(before.bikeFieraMin);
  const bikeAfter = Math.round(after.bikeFieraMin);
  set("impact-bikes-value", bikeBefore === bikeAfter
    ? t("impact.bikesSame", { n: bikeAfter })
    : t("impact.bikesChange", { before: bikeBefore, after: bikeAfter }));
  set("impact-bikes-detail", "");
  set("impact-transit-value", t(rossaOn ? "impact.busToTram" : "impact.transitSame"));
  set("impact-transit-detail", rossaOn ? delta("transitFieraMin", "transitPilastroMin") : "");
  set("impact-air-value", state.lines.length ? t("impact.airShift") : t("impact.airSame"));
}

function paintNoise(beforeLevel, afterLevel, order) {
  const value = document.getElementById("impact-noise-value");
  const name = (id) => t(`place.${id}`);
  if (state.view === "before" || !state.lines.length) {
    value.textContent = state.view === "compare"
      ? t("impact.noiseSame")
      : t("impact.noiseNow", { place: name(order[0].id) });
    return;
  }
  const changes = Object.keys(beforeLevel).map((id) => ({
    id,
    db: 10 * Math.log10(Math.max(afterLevel[id], 0.05) / Math.max(beforeLevel[id], 0.05)),
  }));
  changes.sort((a, b) => a.db - b.db);
  const quiet = changes[0];
  const loud = changes[changes.length - 1];
  const db = (number) => number.toLocaleString(locale(state.lang), { maximumFractionDigits: 1 });
  if (quiet.db > -0.5) {
    value.textContent = t("impact.noiseSame");
    return;
  }
  value.textContent = loud.db >= 0.5
    ? t("impact.noiseShift", { quiet: name(quiet.id), quietDb: db(quiet.db), loud: name(loud.id), loudDb: db(loud.db) })
    : t("impact.noiseQuiet", { quiet: name(quiet.id), quietDb: db(quiet.db) });
}

function paintCongestion(current) {
  const base = {
    cars: hourCars(catalog, state.hour),
    peakCars: centre?.peakCars,
    beforeCarFlow: current.before.carFlow,
    activeLines: state.lines,
  };
  const beforePlaces = placeCongestion(centre, linesPlan, { ...base, scenario: "before", carFlow: current.before.carFlow });
  const afterPlaces = placeCongestion(centre, linesPlan, { ...base, scenario: "after", carFlow: current.after.carFlow });
  const levelOf = (places) => Object.fromEntries(places.map((place) => [place.id, place.level]));
  const order = state.view === "before" ? beforePlaces : afterPlaces;
  paintNoise(levelOf(beforePlaces), levelOf(afterPlaces), order);
}

function paintPanel(options = {}) {
  if (!options.keep) metrics = pair();
  const current = shown();
  const before = current.before;
  const after = current.after;
  document.body.classList.remove("view-before", "view-after", "view-compare");
  document.body.classList.add(`view-${state.view}`);
  document.body.classList.toggle("scenario-before", state.scenario === "before");
  document.body.classList.toggle("scenario-after", state.scenario === "after");
  const titles = { before: "impact.titleBefore", after: "impact.titleAfter", compare: "impact.titleCompare" };
  document.querySelector(".kicker").textContent = t(titles[state.view]);
  document.getElementById("map-caption").textContent = t(`caption.${state.view}`);
  document.getElementById("when").textContent = `Bologna · ${hourLabel(state.hour)}`;
  const priority = document.getElementById("priority-note");
  if (priority) {
    priority.textContent = state.view === "before"
      ? ""
      : t("priority.note", { green: Math.round(carGreenSec(state.params.tramHeadwayMin)) });
  }
  document.getElementById("assumptions").textContent = assumptionText();
  const snap = document.getElementById("snap");
  if (metrics.snapped) {
    snap.textContent = t("snap.nearest", {
      pct: Math.round(metrics.shift * 100),
      headway: metrics.headway.toLocaleString(locale(state.lang)),
    });
  } else if (metrics.live) {
    snap.textContent = metrics.cuda ? t("snap.cuda") : t("snap.live");
  } else {
    snap.textContent = "";
  }
  paintImpact(current);
  paintCongestion(current);
  const rows = {
    carFieraMin: [before.carFieraMin, after.carFieraMin],
    carPilastroMin: [before.carPilastroMin, after.carPilastroMin],
    bikeFieraMin: [before.bikeFieraMin, after.bikeFieraMin],
    transitFieraMin: [before.transitFieraMin, after.transitFieraMin],
    transitPilastroMin: [before.transitPilastroMin, after.transitPilastroMin],
    viaEmiliaKmh: [before.viaEmiliaKmh, after.viaEmiliaKmh],
    carDemand: [carAccount(before, "before").demand, carAccount(after, "after").demand],
    carFlow: [before.carFlow, after.carFlow],
    carQueue: [carAccount(before, "before").queued, carAccount(after, "after").queued],
    peoplePerHour: [before.peoplePerHour, after.peoplePerHour],
    unserved: [before.unserved, after.unserved],
  };
  for (const [key, values] of Object.entries(rows)) {
    const cells = document.querySelectorAll(`tr[data-key="${key}"] td`);
    values.forEach((value, index) => {
      const text = key.endsWith("Min")
        ? formatMinutes(value)
        : key === "viaEmiliaKmh"
          ? `${Math.round(value)} km/h`
          : count(state.lang, value);
      cells[index].textContent = text;
      cells[index].classList.toggle("active", (index === 0 ? "before" : "after") === state.scenario);
    });
  }
  document.getElementById("show-before").setAttribute("aria-pressed", String(state.view === "before"));
  document.getElementById("show-after").setAttribute("aria-pressed", String(state.view === "after"));
  document.getElementById("show-compare").setAttribute("aria-pressed", String(state.view === "compare"));
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
function fillHours() {
  hourSelect.replaceChildren();
  for (const slot of catalog?.hours || [{ hour: 8, label: "08:00 · morning peak" }]) {
    const option = document.createElement("option");
    option.value = String(slot.hour);
    option.textContent = hourText(state.lang, slot.label);
    hourSelect.append(option);
  }
  hourSelect.value = String(state.hour);
}
fillHours();

let dayTimer = 0;
const dayButton = document.getElementById("play-day");
function stopDay() {
  if (dayTimer) {
    clearInterval(dayTimer);
    dayTimer = 0;
  }
  dayButton.textContent = t("control.playDay");
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
  if (!state.air) state.heatmap = true;
  dayButton.textContent = t("control.stopDay");
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
  if (state.view === "before" && state.lines.some((id) => id !== "rossa")) {
    state.view = "after";
    state.scenario = "after";
  }
  paintPanel({ keep: Boolean(metrics.live) });
  paintRoutes();
  traffic.seed(state.params, shown());
});

function setView(view) {
  state.view = view;
  state.scenario = view === "before" ? "before" : "after";
  paintPanel({ keep: Boolean(metrics.live) });
  paintRoutes();
}
document.getElementById("show-before").addEventListener("click", () => setView("before"));
document.getElementById("show-after").addEventListener("click", () => setView("after"));
document.getElementById("show-compare").addEventListener("click", () => setView("compare"));

const heatToggle = document.getElementById("heat-toggle");
if (!centre) heatToggle.hidden = true;
heatToggle.addEventListener("click", () => {
  state.heatmap = !state.heatmap;
  if (state.heatmap) state.air = false;
  paintHeat();
  paintAir();
});

const airCanvas = document.getElementById("air");
const air = centre && airData ? createAir(map, airCanvas, centre, linesPlan) : null;
if (!air) document.getElementById("air-toggle").hidden = true;
if (air) {
  const airResize = () => {
    air.resize();
    paintAir();
  };
  airResize();
  window.addEventListener("resize", airResize);
}

function paintAir() {
  if (!air) return;
  const current = shown();
  air.paint({
    air: state.air,
    scenario: state.scenario,
    cars: hourCars(catalog, state.hour),
    peakCars: centre.peakCars,
    carFlow: current[state.scenario].carFlow,
    beforeCarFlow: current.before.carFlow,
    activeLines: state.lines,
    stations: airData.stations,
  });
  document.getElementById("vehicles").classList.toggle("dim", state.heatmap || state.air);
  document.getElementById("air-toggle").setAttribute("aria-pressed", String(state.air));
  document.getElementById("air-key").hidden = !state.air;
  const serving = state.scenario === "after" && state.lines.length > 0;
  const readings = airData.stations.map((station) => `${station.name} ${station.no2}`).join(" · ");
  document.getElementById("air-note").textContent = state.air
    ? serving
      ? t("air.serving", { readings })
      : t("air.idle", { readings })
    : "";
}

document.getElementById("air-toggle").addEventListener("click", () => {
  state.air = !state.air;
  if (state.air) state.heatmap = false;
  paintHeat();
  paintAir();
});

const sensorsToggle = document.getElementById("sensors-toggle");
if (!sensorLayer) sensorsToggle.hidden = true;
function paintSensors() {
  if (!sensorLayer) return;
  sensorsToggle.setAttribute("aria-pressed", String(state.sensors));
  document.getElementById("sensor-key").hidden = !state.sensors;
  document.getElementById("sensor-note").textContent = state.sensors
    ? t("sensor.note", { readings: airData.stations.map((station) => `${station.name} NO2 ${station.no2}`).join(" · ") })
    : "";
  if (state.sensors) sensorLayer.addTo(map);
  else map.removeLayer(sensorLayer);
}
sensorsToggle.addEventListener("click", () => {
  state.sensors = !state.sensors;
  paintSensors();
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
  document.getElementById("headway-value").textContent = `${Number(headway.value).toLocaleString(locale(state.lang))} min`;
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

function predictionNote(best) {
  const extra = Math.round(best.after.carFieraMin - best.before.carFieraMin);
  const change = extra > 0
    ? t("prediction.longer", { n: extra })
    : extra < 0
      ? t("prediction.shorter", { n: Math.abs(extra) })
      : t("prediction.same");
  return t("prediction", {
    model: modelLabel(),
    hour: hourLabel(state.hour),
    pct: Math.round(best.shiftValue * 100),
    headway: best.headwayMin.toLocaleString(locale(state.lang)),
    people: count(state.lang, best.after.peoplePerHour),
    waiting: count(state.lang, best.after.unserved),
    change,
  });
}

document.getElementById("predict").addEventListener("click", () => {
  const note = document.getElementById("predict-note");
  const found = currentBest();
  if (!found) {
    note.textContent = catalog ? t("predict.noSetups") : t("predict.needCatalog");
    return;
  }
  const { best } = found;
  state.params.modalShift = best.shiftValue;
  state.params.tramHeadwayMin = best.headwayMin;
  state.view = "after";
  state.scenario = "after";
  shift.value = String(Math.round(best.shiftValue * 100));
  headway.value = String(best.headwayMin);
  document.getElementById("shift-value").textContent = `${shift.value}%`;
  document.getElementById("headway-value").textContent = `${best.headwayMin.toLocaleString(locale(state.lang))} min`;
  note.textContent = predictionNote(best);
  paintPanel();
  paintRoutes();
  traffic.seed(state.params, shown());
  refreshLive();
});

document.getElementById("export-report").addEventListener("click", () => {
  const note = document.getElementById("predict-note");
  const found = currentBest();
  if (!found) {
    note.textContent = catalog ? t("predict.noSetups") : t("report.needCatalog");
    return;
  }
  const slot = catalog.hours?.find((item) => item.hour === state.hour);
  const supply = catalog.supply;
  const html = reportHtml({
    modelLabel: tr("en", `model.${state.model}`),
    hourLabel: slot?.label || hourLabel(state.hour),
    hourSlot: slot,
    best: found.best,
    ranked: found.ranked,
    notes: [
      supply?.notes?.cars,
      supply?.notes?.bikes,
      supply?.notes?.buses,
      supply?.signalTiming,
      tr("en", "assume.report"),
    ],
    generatedAt: new Date().toLocaleString("en-GB", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "Europe/Rome",
    }),
  });
  const hour = String(state.hour).padStart(2, "0");
  downloadReport(`linea-rossa-${hour}-${state.model}.html`, html);
  note.textContent = predictionNote(found.best);
});

document.getElementById("play").addEventListener("click", () => {
  state.playing = !state.playing;
  paintPlay();
});

function paintPlay() {
  document.getElementById("play").textContent = t(state.playing ? "control.pause" : "control.play");
}

for (const button of document.querySelectorAll(".lang button")) {
  button.addEventListener("click", () => {
    if (button.dataset.lang === state.lang) return;
    state.lang = button.dataset.lang;
    localStorage.setItem("lang", state.lang);
    applyStatic();
    fillHours();
    paintPlay();
    dayButton.textContent = t(dayTimer ? "control.stopDay" : "control.playDay");
    document.getElementById("headway-value").textContent = `${state.params.tramHeadwayMin.toLocaleString(locale(state.lang))} min`;
    document.getElementById("predict-note").textContent = "";
    paintPanel({ keep: true });
    paintRoutes();
    paintSensors();
  });
}
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
  }   else if (event.key === "1") document.getElementById("show-before").click();
  else if (event.key === "2") document.getElementById("show-after").click();
  else if (event.key === "3") document.getElementById("show-compare").click();
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
  const vehicles = state.scenario === "after" ? traffic.vehicles("after") : [];
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

paintPlay();
document.getElementById("headway-value").textContent = `${state.params.tramHeadwayMin.toLocaleString(locale(state.lang))} min`;
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
