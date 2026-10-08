import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { DEFAULTS, prepare, evaluate, applyTramPriority, carGreenSec } from "./model.js";
import { LANGS, tr, count, hourText, noteText, locale } from "./i18n.js";
import { caseKey, reportHtml, downloadReport, searchBestSetup } from "./report.js";
import { createHeat, hourCars, placeCongestion } from "./heatmap.js";
import { stationSummary } from "./air.js";
import { extraShift, withLines } from "./lines.js";
import { createTraffic } from "./traffic.js";
import { queueChange, queueDiameter, queueShare } from "./queue.js";
import {
  airBand,
  changeTrend,
  levelBand,
  measureDiameter,
  noiseDb,
  percentChange,
  pickAnchors,
  spreadBoxes,
} from "./measures.js";

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
  layers: { traffic: true, queues: true, air: false, noise: false },
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
  const shiftSnapped = Math.abs(shift - state.params.modalShift) >= 0.001;
  return applyTramPriority({
    before,
    after,
    snapped: shiftSnapped,
    shift,
    headway: state.params.tramHeadwayMin,
  }, state.params.tramHeadwayMin);
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

map.createPane("queues");
map.getPane("queues").style.zIndex = 625;
map.getPane("queues").style.pointerEvents = "none";
map.createPane("leaders");
map.getPane("leaders").style.zIndex = 635;
map.getPane("leaders").style.pointerEvents = "none";
map.createPane("labels");
map.getPane("labels").style.zIndex = 640;
map.getPane("labels").style.pointerEvents = "none";

const plannedLines = [];
const bypassSamples = (geo.pieces.car.bypass?.points || [])
  .filter((point, index) => index % 2 === 0)
  .map((point) => ({ lat: point.lat, lon: point.lon, bypass: true, rank: 0.7 }));
const trunkPoints = geo.pieces.car.trunk?.points || [];
const approachSamples = trunkPoints
  .filter((point, index) => index % 3 === 0)
  .map((point) => ({ lat: point.lat, lon: point.lon, approach: true, rank: 0.8 }));
const queueStops = [0, 0.28, 0.52, 0.76, 1].map((share) => {
  const index = Math.min(trunkPoints.length - 1, Math.round(share * (trunkPoints.length - 1)));
  return trunkPoints[index];
}).filter(Boolean);
function samplesFor(id) {
  const samples = centre?.samples || [];
  if (id === "centre") return samples.filter((sample) => !sample.ring && !sample.tram);
  if (id === "avenues") return samples.filter((sample) => sample.ring);
  if (id === "bypass") return bypassSamples;
  const line = linesPlan?.lines?.find((item) => item.id === id)?.samples || [];
  const gate = queueStops.at(-1);
  return id === "rossa" && gate ? line.filter((sample) => sample.lon > gate.lon) : line;
}
const PLACES = ["centre", "rossa", "verde", "gialla", "blu", "avenues", "bypass"];
const placeAnchors = pickAnchors(
  PLACES.map((id) => ({ id, line: ["rossa", "verde", "gialla", "blu"].includes(id), samples: samplesFor(id) })),
  [...queueStops, ...(airData?.stations || [])],
);
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

const queueLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);

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
const heat = centre ? createHeat(map, heatCanvas, centre, linesPlan, [...bypassSamples, ...approachSamples]) : null;
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
  const beforeCars = carAccount(current.before, "before");
  const afterCars = carAccount(current.after, "after");
  const carFlow = current[state.scenario].carFlow;
  const beforeCarFlow = current.before.carFlow;
  heat.paint({
    heatmap: state.layers.traffic,
    mode: state.view,
    scenario: state.scenario,
    cars: hourCars(catalog, state.hour),
    peakCars: centre.peakCars,
    carFlow,
    beforeCarFlow,
    afterCarFlow: current.after.carFlow,
    queueShare: queueShare(state.view === "before" ? beforeCars.queued : afterCars.queued, state.view === "before" ? beforeCars.demand : afterCars.demand),
    beforeQueueShare: queueShare(beforeCars.queued, beforeCars.demand),
    afterQueueShare: queueShare(afterCars.queued, afterCars.demand),
    activeLines: state.lines,
  });
  document.getElementById("vehicles").classList.toggle("dim", state.layers.traffic);
  document.querySelector(".scale-key").hidden = !state.layers.traffic;
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

function congestionLines(beforeCars, afterCars) {
  const n = (value) => count(state.lang, value);
  if (state.view !== "compare") {
    const account = state.view === "after" ? afterCars : beforeCars;
    return [
      account.queued < 1 ? t("congestion.none") : t("congestion.now", { queue: n(account.queued) }),
      t("congestion.flow", { demand: n(account.demand), pass: n(account.passing) }),
    ];
  }
  const queued = beforeCars.queued >= 1 || afterCars.queued >= 1;
  return [
    queued
      ? t("congestion.compare", { before: n(beforeCars.queued), after: n(afterCars.queued) })
      : t("congestion.none"),
    t("congestion.flowCompare", {
      demandBefore: n(beforeCars.demand),
      demandAfter: n(afterCars.demand),
      passBefore: n(beforeCars.passing),
      passAfter: n(afterCars.passing),
    }),
  ];
}

function placeLevels(current) {
  const base = {
    cars: hourCars(catalog, state.hour),
    peakCars: centre?.peakCars,
    beforeCarFlow: current.before.carFlow,
    activeLines: state.lines,
  };
  const levelOf = (places) => Object.fromEntries(places.map((place) => [place.id, place.level]));
  return {
    before: levelOf(placeCongestion(centre, linesPlan, { ...base, scenario: "before", carFlow: current.before.carFlow })),
    after: levelOf(placeCongestion(centre, linesPlan, { ...base, scenario: "after", carFlow: current.after.carFlow })),
  };
}

function shownPlaces() {
  return PLACES.filter((id) => placeAnchors[id] && (!["rossa", "verde", "gialla", "blu"].includes(id) || state.lines.includes(id)));
}

function queueBubble(point, account, phase, trend, offset, scale, labeled) {
  const size = Math.round(queueDiameter(account.queued, scale) * (labeled ? 0.78 : 0.46));
  const phaseText = t(`queue.${phase}`);
  const queueText = t("queue.queued");
  const label = t("queue.label", {
    phase: phaseText,
    queue: count(state.lang, account.queued),
  });
  const html = `
    <div class="queue-bubble-wrap ${offset} ${trend} ${labeled ? "labeled" : "dot"}" style="--queue-size:${size}px" role="img" aria-label="${label}">
      ${labeled ? `<span class="queue-phase">${phaseText}</span>` : ""}
      <span class="queue-bubble">
        ${labeled ? `<strong>${count(state.lang, account.queued)}</strong><small>${queueText}</small>` : ""}
      </span>
    </div>`;
  return L.marker([point.lat, point.lon], {
    pane: "queues",
    interactive: false,
    icon: L.divIcon({
      className: "queue-map-icon",
      html,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    }),
  });
}

function paintQueues(current) {
  queueLayer.clearLayers();
  if (!state.layers.queues || !queueStops.length) return;
  const before = carAccount(current.before, "before");
  const after = carAccount(current.after, "after");
  const scale = Math.max(1000, before.queued, after.queued);
  queueStops.forEach((point, index) => {
    const labeled = index === queueStops.length - 1;
    if (state.view === "compare") {
      queueBubble(point, before, "before", "baseline", "compare-before", scale, labeled).addTo(queueLayer);
      queueBubble(point, after, "after", queueChange(before.queued, after.queued), "compare-after", scale, labeled).addTo(queueLayer);
      return;
    }
    const account = state.view === "after" ? after : before;
    queueBubble(point, account, state.view, "current", "single", scale, labeled).addTo(queueLayer);
  });
}

function labelMarker(point, html) {
  return L.marker([point.lat, point.lon], {
    pane: "labels",
    interactive: false,
    icon: L.divIcon({
      className: "measure-map-icon",
      html,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    }),
  });
}

function signed(value, digits = 0) {
  const text = Math.abs(value).toLocaleString(locale(state.lang), { maximumFractionDigits: digits });
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}`;
}

function areaRow(measure, before, after) {
  const name = t(`area.${measure}`);
  let value;
  let tone;
  if (state.view === "compare") {
    const change = measure === "noise" ? noiseDb(before, after) : percentChange(before, after);
    tone = changeTrend(change, measure === "noise" ? 0.5 : 4);
    value = tone === "same" ? t("area.same") : measure === "noise" ? `${signed(change, 1)} dB` : `${signed(change)}%`;
  } else {
    tone = levelBand(state.view === "before" ? before : after);
    value = t(`level.${measure}.${tone}`);
  }
  return { text: `${name} ${value}`, html: `<span class="area-row ${tone}"><b>${name}</b> ${value}</span>` };
}

function queueBoxes(current) {
  if (!state.layers.queues) return [];
  const before = carAccount(current.before, "before");
  const after = carAccount(current.after, "after");
  const queued = Math.max(before.queued, after.queued);
  const scale = Math.max(1000, queued);
  const offset = state.view === "compare" ? 36 : 0;
  return queueStops.map((point, index) => {
    const at = map.latLngToContainerPoint([point.lat, point.lon]);
    const labeled = index === queueStops.length - 1;
    const size = queueDiameter(queued, scale) * (labeled ? 0.78 : 0.46) + offset;
    return { x: at.x, y: at.y, w: size + 8, h: size + (labeled ? 24 : 8) };
  });
}

function paintLabels(current, levels) {
  labelLayer.clearLayers();
  const measures = ["traffic", "air", "noise"].filter((id) => state.layers[id]);
  const items = [];
  if (measures.length && centre) {
    for (const id of shownPlaces()) {
      const rows = measures.map((measure) => areaRow(measure, levels.before[id] ?? 0, levels.after[id] ?? 0));
      const name = t(`place.${id}`);
      const label = `${name}: ${rows.map((row) => row.text).join(", ")}`;
      items.push({
        anchor: placeAnchors[id],
        w: Math.max(name.length, ...rows.map((row) => row.text.length)) * 6.6 + 20,
        h: 22 + rows.length * 17,
        html: `<div class="area-label" role="img" aria-label="${label}"><span class="area-name">${name}</span>${rows.map((row) => row.html).join("")}</div>`,
      });
    }
  }
  if (state.layers.air) {
    const scale = Math.max(30, ...(airData?.stations || []).map((station) => station.no2));
    for (const station of airData?.stations || []) {
      const size = measureDiameter(station.no2, scale, 34, 22);
      const label = `${station.name}: ${stationSummary(station, state.lang)}`;
      items.push({
        anchor: station,
        w: Math.max(station.name.length * 6.6 + 16, size + 8),
        h: size + 26,
        html: `<div class="station-label" role="img" aria-label="${label}"><span class="area-name">${station.name}</span><span class="measure-bubble ${airBand(station.no2)}" style="--measure-size:${size}px"><strong>${station.no2}</strong><small>NO2</small></span></div>`,
      });
    }
  }
  if (!items.length) return;
  const boxes = items.map((item) => {
    const at = map.latLngToContainerPoint([item.anchor.lat, item.anchor.lon]);
    return { x: at.x, y: at.y, w: item.w, h: item.h, item, startX: at.x, startY: at.y };
  });
  spreadBoxes(boxes, queueBoxes(current));
  for (const box of boxes) {
    const at = map.containerPointToLatLng([box.x, box.y]);
    if (Math.hypot(box.x - box.startX, box.y - box.startY) > 14) {
      const anchor = [box.item.anchor.lat, box.item.anchor.lon];
      L.polyline([anchor, at], { pane: "leaders", color: "#ffffff", weight: 1, opacity: 0.75, interactive: false }).addTo(labelLayer);
      L.circleMarker(anchor, {
        pane: "leaders",
        radius: 3,
        color: "#ffffff",
        weight: 1,
        fillColor: "#1e1e1e",
        fillOpacity: 1,
        interactive: false,
      }).addTo(labelLayer);
    }
    labelMarker({ lat: at.lat, lon: at.lng }, box.item.html).addTo(labelLayer);
  }
}

function busiest(levels) {
  return Object.entries(levels).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function trafficShift(levels) {
  const changes = Object.keys(levels.before)
    .map((id) => ({ id, pct: percentChange(levels.before[id], levels.after[id]) }))
    .sort((a, b) => a.pct - b.pct);
  const less = changes[0];
  const more = changes[changes.length - 1];
  if (!less || less.pct > -4) return t("traffic.same");
  const place = (id) => t(`place.${id}`);
  return more.pct >= 4
    ? t("traffic.shift", { less: place(less.id), lessPct: signed(less.pct), more: place(more.id), morePct: signed(more.pct) })
    : t("traffic.less", { less: place(less.id), lessPct: signed(less.pct) });
}

function noiseLine(levels) {
  const place = (id) => t(`place.${id}`);
  if (state.view === "before") return t("impact.noiseNow", { place: place(busiest(levels.before)) });
  if (!state.lines.length) return t("impact.noiseSame");
  const changes = Object.keys(levels.before)
    .map((id) => ({ id, db: noiseDb(levels.before[id], levels.after[id]) }))
    .sort((a, b) => a.db - b.db);
  const quiet = changes[0];
  const loud = changes[changes.length - 1];
  if (quiet.db > -0.5) return t("impact.noiseSame");
  return loud.db >= 0.5
    ? t("impact.noiseShift", { quiet: place(quiet.id), quietDb: signed(quiet.db, 1), loud: place(loud.id), loudDb: signed(loud.db, 1) })
    : t("impact.noiseQuiet", { quiet: place(quiet.id), quietDb: signed(quiet.db, 1) });
}

function paintImpact(current, levels) {
  const { before, after } = current;
  const rossaOn = state.lines.includes("rossa");
  const compare = state.view === "compare";
  const record = state.view === "before" ? before : after;
  const set = (id, text) => {
    document.getElementById(id).textContent = text;
  };
  const trips = (fieraKey, agrariaKey) => (compare
    ? t("impact.tripsDelta", {
      fieraBefore: Math.round(before[fieraKey]),
      fieraAfter: Math.round(after[fieraKey]),
      agrariaBefore: Math.round(before[agrariaKey]),
      agrariaAfter: Math.round(after[agrariaKey]),
    })
    : t("impact.trips", { fiera: Math.round(record[fieraKey]), agraria: Math.round(record[agrariaKey]) }));

  set("impact-traffic-value", trips("carFieraMin", "carPilastroMin"));
  set("impact-traffic-detail", state.view === "before" || !state.lines.length
    ? t("traffic.busiest", { place: t(`place.${busiest(levels[state.view === "before" ? "before" : "after"])}`) })
    : trafficShift(levels));

  const [queueValue, queueDetail] = congestionLines(carAccount(before, "before"), carAccount(after, "after"));
  set("impact-congestion-value", queueValue);
  set("impact-congestion-detail", queueDetail);

  const serving = state.view !== "before" && state.lines.length > 0;
  set("impact-air-value", serving ? t("impact.airShift") : compare ? t("impact.airSame") : t("impact.airNow"));
  set("impact-air-detail", t("air.measured", {
    readings: (airData?.stations || []).map((station) => `${station.name} ${station.no2}`).join(" · "),
  }));

  set("impact-noise-value", noiseLine(levels));

  const tram = state.view === "after" && rossaOn;
  set("impact-transit-value", `${t("impact.transit")}: ${compare
    ? t(rossaOn ? "impact.busToTram" : "impact.transitSame")
    : t(tram ? "impact.tram" : "impact.bus")}`);
  set("impact-transit-detail", compare && !rossaOn ? "" : trips("transitFieraMin", "transitPilastroMin"));
  const bikeBefore = Math.round(before.bikeFieraMin);
  const bikeAfter = Math.round(after.bikeFieraMin);
  const bikes = !compare
    ? t("impact.bikesNow", { n: Math.round(record.bikeFieraMin) })
    : bikeBefore === bikeAfter
      ? t("impact.bikesSame", { n: bikeAfter })
      : t("impact.bikesChange", { before: bikeBefore, after: bikeAfter });
  set("impact-bikes-value", `${t("impact.bikes")}: ${bikes}`);
}

function paintSwitches() {
  for (const button of document.querySelectorAll(".map-switch")) {
    const layer = button.dataset.layer;
    button.setAttribute("aria-pressed", String(Boolean(state.layers[layer])));
    button.setAttribute("aria-label", t(`layer.${layer}`));
  }
  document.getElementById("sensor-key").hidden = !state.layers.air;
}

function paintMapLayers() {
  const current = shown();
  paintHeat();
  paintQueues(current);
  paintLabels(current, placeLevels(current));
  paintSwitches();
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
  document.getElementById("map-caption").textContent = t(`caption.${state.view}`);
  document.getElementById("when").textContent = `Bologna · ${hourLabel(state.hour)}`;
  const priority = document.getElementById("priority-note");
  if (priority) {
    priority.textContent = state.view === "before"
      ? ""
      : t("priority.note", { green: Math.round(carGreenSec(state.params.tramHeadwayMin)) });
  }
  document.getElementById("assumptions").textContent = assumptionText();
  document.getElementById("model-use").textContent = t(`modelUse.${state.model}`);
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
  const levels = placeLevels(current);
  paintImpact(current, levels);
  paintQueues(current);
  paintLabels(current, levels);
  paintSwitches();
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

for (const button of document.querySelectorAll(".map-switch")) {
  const layer = button.dataset.layer;
  if ((layer === "traffic" || layer === "noise") && !centre) button.hidden = true;
  if (layer === "air" && !airData?.stations?.length) button.hidden = true;
  button.addEventListener("click", () => {
    state.layers[layer] = !state.layers[layer];
    paintMapLayers();
  });
}

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
function frame(now) {
  const wall = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.playing) traffic.step(wall * state.timeScale, state.params, shown());
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
map.on("zoomend resize", () => {
  const current = shown();
  paintLabels(current, placeLevels(current));
});
requestAnimationFrame(frame);
}

main().catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<p id="boot-error">${error.message}</p>`);
  console.error(error);
});
