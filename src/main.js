import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { LANGS, tr, count, hourText, joinNames, noteText, locale } from "./i18n.js";
import { ANIMATION, prepare } from "./geometry.js";
import { createTraffic } from "./traffic.js";
import { HEAT_MEASURES, createRoadHeat } from "./heatmap.js";
import {
  CROSS_MIN_S,
  defaultDesign,
  hourRow,
  junctionCount,
  loadCorridor,
  merge,
  runModel,
  runPair,
  signalPlan,
  streetLayout,
} from "./sim/index.js";
import { loadRoads, runCity, sideMeasured } from "./roads.js";
import {
  PIECE_ORDER,
  areaSummaries,
  changedStreets,
  decibels,
  minutesLost,
  modeImpacts,
  optimiseLights,
  percent,
  prepareAreas,
  searchBestSetup,
} from "./impacts.js";
import { downloadReport, reportHtml } from "./report.js";
import { readingText, stationReading, stationSummary } from "./air.js";
import { queueChange, queueDiameter } from "./queue.js";
import { airBand, measureDiameter, spreadBoxes, tipSide } from "./measures.js";
import { BUBBLE_LIMIT, bubbleDiameter, changeTone, placeBubbles, rankStretches, streetStretches } from "./bubbles.js";

const LOS_COLOR = { A: "#1f8a4c", B: "#6cc04a", C: "#d4c21a", D: "#f0a020", E: "#e8590c", F: "#c0262d" };
const LINE_IDS = ["rossa", "verde", "gialla", "blu"];
const LAYER_ORDER = ["congestion", "traffic", "air", "noise"];

async function getJson(url) {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const [network, corridorData, roadsData, linesPlan, airData] = await Promise.all(
    ["/network.json", "/corridor.json", "/roads.json", "/lines.json", "/air.json"].map(getJson),
  );
  if (!network || !corridorData) throw new Error("network.json or corridor.json is missing.");
  const geo = prepare(network);
  const corridor = loadCorridor(corridorData);
  const city = roadsData ? prepareAreas(loadRoads(roadsData)) : null;
  const stretches = city ? streetStretches(city) : [];
  const trunkLength = (stretch) => stretch.ids.reduce((sum, id) => sum + (city.roads[id].piece === "trunk" ? city.roads[id].length : 0), 0);
  const onTrunk = new Set(stretches.filter((stretch) => trunkLength(stretch) >= stretch.length / 2).map((stretch) => stretch.key));

  const state = {
    view: "before",
    mapView: "numbers",
    layers: { traffic: false, congestion: true, air: false, noise: false },
    bubbles: true,
    panels: { design: true, results: true },
    lines: ["rossa"],
    shift: 0.25,
    headway: 4.5,
    hour: corridorData.defaultHour || 8,
    model: corridorData.defaultModel || "ctm",
    design: defaultDesign(),
    street: "trunk",
    playing: true,
    timeScale: 40,
    lang: startLang(),
    busy: false,
    search: null,
  };

  function startLang() {
    const asked = new URLSearchParams(location.search).get("lang");
    if (LANGS.includes(asked)) return asked;
    const saved = localStorage.getItem("lang");
    if (LANGS.includes(saved)) return saved;
    return navigator.language?.toLowerCase().startsWith("it") ? "it" : "en";
  }

  const t = (key, vars) => tr(state.lang, key, vars);
  const n = (value) => count(state.lang, value);
  const share = (value) => `${Math.round(value * 100)}%`;
  const minutes = (value) => `${Math.round(value)} min`;
  const decimal = (value, digits = 1) => value.toLocaleString(locale(state.lang), { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const signed = (value, digits = 0) => {
    const rounded = Number(value.toFixed(digits));
    const text = Math.abs(rounded).toLocaleString(locale(state.lang), { maximumFractionDigits: digits, minimumFractionDigits: digits });
    return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${text}`;
  };
  const signedPct = (before, after) => `${signed(percent(before, after))}%`;
  const signedDb = (before, after) => `${signed(decibels(before, after), 1)} dB`;
  const streetName = (name) => t(`street.${name}`);
  const years = corridorData.years || { before: 2024, after: 2026 };
  const yearText = (view = state.view) => (view === "compare" ? `${years.before} → ${years.after}` : String(years[scenarioOf(view)]));
  const dayMonth = (monthDay) => {
    const [month, day] = monthDay.split("-").map(Number);
    return new Date(Date.UTC(2000, month - 1, day)).toLocaleDateString(locale(state.lang), { day: "numeric", month: "long", timeZone: "UTC" });
  };
  const element = (id) => document.getElementById(id);
  const setText = (id, text) => {
    element(id).textContent = text;
  };

  function applyStatic() {
    document.documentElement.lang = state.lang;
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", t(node.dataset.i18nAria));
    for (const node of document.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
    for (const button of document.querySelectorAll(".lang button")) {
      button.setAttribute("aria-pressed", String(button.dataset.lang === state.lang));
    }
  }

  function hourLabel(hour) {
    const slot = corridor.hours.find((item) => Number(item.hour) === Number(hour));
    return slot?.label ? hourText(state.lang, slot.label) : `${String(hour).padStart(2, "0")}:00`;
  }

  // ---------- model runs ----------

  function compute() {
    const rossaOpen = state.lines.includes("rossa");
    const setup = { shift: state.shift, headway: state.headway, hour: state.hour, design: state.design };
    const raw = runPair(state.model, corridor, setup);
    const pair = rossaOpen
      ? raw
      : { before: raw.before, after: runModel(state.model, corridor, "before", state.shift, state.headway, { ...setup, year: "after" }) };
    const out = { raw, pair, rossaOpen };
    if (city) {
      const options = {
        hour: state.hour,
        lines: state.lines,
        shift: state.shift,
        extraShift: linesPlan?.extraShift || {},
        headway: state.headway,
        priority: state.design.priority,
        corridor: pair,
      };
      out.cityBefore = runCity(city, { ...options, scenario: "before", buses: hourRow(corridor, state.hour, "before").buses });
      out.cityAfter = runCity(city, { ...options, scenario: "after", buses: hourRow(corridor, state.hour, "after").buses });
      out.impacts = modeImpacts({
        pair,
        corridor,
        hour: state.hour,
        headway: state.headway,
        rossaOpen,
        city,
        cityBefore: out.cityBefore,
        cityAfter: out.cityAfter,
      });
      out.areas = areaSummaries(city, out.cityBefore, out.cityAfter);
      out.changed = changedStreets(city, out.cityBefore, out.cityAfter);
    }
    out.lost = [minutesLost(pair.before, corridor), minutesLost(pair.after, corridor)];
    return out;
  }

  let result = compute();
  let pending = 0;
  function refresh({ reseed = false } = {}) {
    if (reseed) needsSeed = true;
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      result = compute();
      if (needsSeed) {
        traffic.seed(ANIMATION, result.pair);
        needsSeed = false;
      }
      paintAll();
    });
  }
  let needsSeed = false;

  // ---------- map ----------

  const map = L.map("map", { zoomControl: false, minZoom: 11, maxZoom: 18, preferCanvas: true });
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Comune di Bologna',
  }).addTo(map);
  L.control.scale({ imperial: false, position: "topright" }).addTo(map);

  for (const [name, zIndex] of [["roads", 405], ["tramlines", 450], ["bubbles", 620], ["queues", 625], ["leaders", 635], ["labels", 640]]) {
    map.createPane(name);
    map.getPane(name).style.zIndex = zIndex;
    if (name !== "roads" && name !== "bubbles") map.getPane(name).style.pointerEvents = "none";
  }

  const roadRenderer = L.canvas({ pane: "roads", padding: 0.3, tolerance: 4 });
  const roadLayers = [];
  if (city) {
    for (const road of city.roads) {
      road.bounds = L.latLngBounds(road.path);
      const layer = L.polyline(road.path, { renderer: roadRenderer, pane: "roads", weight: 2, opacity: 0.6, color: "#8a8a8a" });
      layer.on("mousemove", (event) => Object.assign(layer.getTooltip().options, tipSide(event.containerPoint, freeArea())));
      layer.bindTooltip(() => roadTooltip(road), { sticky: true, direction: "top", className: "road-tip", opacity: 1 });
      layer.addTo(map);
      roadLayers.push(layer);
    }
  }

  const plannedLines = [];
  for (const poly of Object.values(geo.pieces.tram)) {
    const latlngs = poly.points.map((point) => [point.lat, point.lon]);
    const casing = L.polyline(latlngs, { pane: "tramlines", color: "#fffaf3", weight: 9, opacity: 0, lineCap: "round", interactive: false }).addTo(map);
    const line = L.polyline(latlngs, { pane: "tramlines", color: "#e30613", weight: 5, opacity: 0, lineCap: "round", interactive: false }).addTo(map);
    plannedLines.push({ casing, line });
  }
  const extraLines = [];
  for (const line of linesPlan?.lines || []) {
    if (line.id === "rossa") continue;
    const casing = line.segments.map((segment) => L.polyline(segment, { pane: "tramlines", color: "#fffaf3", weight: 9, opacity: 0, lineCap: "round", interactive: false }).addTo(map));
    const layers = line.segments.map((segment) => L.polyline(segment, { pane: "tramlines", color: line.color, weight: 5, opacity: 0, lineCap: "round", interactive: false }).addTo(map));
    extraLines.push({ id: line.id, casing, layers });
  }
  const stopLayer = L.layerGroup();
  for (const stop of network.stops) {
    L.circleMarker([stop.lat, stop.lon], { pane: "tramlines", radius: 4, color: "#1b1714", weight: 1, fillColor: "#fffaf3", fillOpacity: 1 })
      .bindTooltip(stop.name, { direction: "top", offset: [0, -6], opacity: 1 })
      .addTo(stopLayer);
  }
  const queueLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);
  const bubbleLayer = L.layerGroup().addTo(map);
  let labelBoxes = [];
  let queueMarkers = [];

  const bounds = L.latLngBounds(network.stops.map((stop) => [stop.lat, stop.lon]));
  for (const line of linesPlan?.lines || []) for (const segment of line.segments || []) bounds.extend(segment);
  const wide = window.innerWidth > 1100;
  map.fitBounds(bounds, { paddingTopLeft: [wide ? 380 : 24, 24], paddingBottomRight: [wide ? 400 : 24, 70] });

  const heat = createRoadHeat(map, element("heat"));
  const canvas = element("vehicles");
  const ctx = canvas.getContext("2d");
  const vehiclePane = map.createPane("vehicles");
  vehiclePane.style.zIndex = 610;
  vehiclePane.style.pointerEvents = "none";
  vehiclePane.appendChild(canvas);
  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const size = map.getSize();
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    canvas.width = size.x * ratio;
    canvas.height = size.y * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  resize();
  map.on("resize", () => {
    resize();
    paintMap();
  });

  const trunkPoints = geo.pieces.car.trunk?.points || [];
  const queueStops = [0, 0.28, 0.52, 0.76, 1].map((at) => trunkPoints[Math.min(trunkPoints.length - 1, Math.round(at * (trunkPoints.length - 1)))]).filter(Boolean);

  const traffic = createTraffic(geo);
  traffic.seed(ANIMATION, result.pair);

  // ---------- map painting ----------

  function scenarioOf(view = state.view) {
    return view === "before" ? "before" : "after";
  }

  function roadStyle(road, before, after) {
    const weight = road.kind === "tertiary" ? 2 : road.kind === "secondary" ? 2.6 : 3.2;
    if (state.mapView === "heat") return { color: "#9a9a9a", weight: 1, opacity: 0.22 };
    if (!state.layers.congestion) return { color: "#7a7a7a", weight: weight * 0.7, opacity: 0.4 };
    if (state.view === "compare") {
      const delta = after.worst - before.worst;
      if (Math.abs(delta) < 0.03) return { color: "#8a8a8a", weight: weight * 0.7, opacity: 0.4 };
      const color = delta > 0.15 ? "#c0262d" : delta > 0 ? "#f0a020" : delta < -0.15 ? "#1f8a4c" : "#6cc04a";
      return { color, weight: weight + 1, opacity: 0.95 };
    }
    const current = state.view === "after" ? after : before;
    return { color: LOS_COLOR[current.los] || "#8a8a8a", weight, opacity: 0.9 };
  }

  function paintRoads() {
    if (!city) return;
    roadLayers.forEach((layer, i) => {
      layer.setStyle(roadStyle(city.roads[i], result.cityBefore.roads[i], result.cityAfter.roads[i]));
    });
  }

  function laneCount(lanes, oneWay) {
    return t(oneWay ? "lanes.oneWay" : "lanes.each", { n: lanes });
  }

  function lanesText(lanes, oneWay) {
    if (!lanes[1] || oneWay) return t("lanes.short.one", { n: lanes[0] });
    return lanes[0] === lanes[1] ? t("lanes.short.each", { n: lanes[0] }) : t("lanes.short.split", { a: lanes[0], b: lanes[1] });
  }

  function roadTooltip(road) {
    const before = result.cityBefore.roads[road.id];
    const after = result.cityAfter.roads[road.id];
    const name = road.name || t("road.unnamed");
    const counted = (state.view === "compare" ? ["before", "after"] : [scenarioOf()])
      .filter((scenario) => [0, 1].some((side) => sideMeasured(road, side, scenario)))
      .map((scenario) => String(years[scenario]));
    const source = road.piece
      ? t("road.model", { street: streetName(road.piece) })
      : counted.length ? t("road.measured", { years: joinNames(state.lang, counted) }) : t("road.estimated");
    const lines = [];
    if (state.view === "compare") {
      lines.push(t("road.compare", {
        loadBefore: share(before.worst),
        loadAfter: share(after.worst),
        before: before.los,
        after: after.los,
        carsBefore: n(before.cars),
        carsAfter: n(after.cars),
      }));
    } else {
      const current = state.view === "after" ? after : before;
      lines.push(t("road.single", { lanes: lanesText(current.lanes, road.oneWay), cars: n(current.cars), load: share(current.worst), level: current.los }));
    }
    if (state.view !== "before" && after.open.length) lines.push(t("road.tram", { lines: after.open.map((id) => t(`place.${id}`)).join(", ") }));
    if (state.view !== "before" && after.extra > 1) lines.push(t("road.extra", { n: n(after.extra) }));
    return `<strong>${name}</strong><br>${lines.join("<br>")}<br><span class="tip-source">${source}</span>`;
  }

  function activeHeatMeasure() {
    return LAYER_ORDER.find((layer) => state.layers[layer]) || null;
  }

  function paintHeat() {
    if (!city) return;
    heat.paint({
      visible: state.mapView === "heat",
      city,
      measure: activeHeatMeasure(),
      mode: state.view,
      before: result.cityBefore,
      after: result.cityAfter,
    });
  }

  function paintLines() {
    const after = state.view !== "before";
    const heatView = state.mapView === "heat";
    const weight = heatView ? 2.5 : 5;
    const rossaOn = after && state.lines.includes("rossa");
    for (const { casing, line } of plannedLines) {
      casing.setStyle({ opacity: rossaOn && !heatView ? 1 : 0 });
      line.setStyle({ opacity: rossaOn ? 1 : 0, weight });
    }
    if (rossaOn) stopLayer.addTo(map);
    else stopLayer.remove();
    for (const item of extraLines) {
      const open = after && state.lines.includes(item.id);
      for (const layer of item.casing) layer.setStyle({ opacity: open && !heatView ? 1 : 0 });
      for (const layer of item.layers) layer.setStyle({ opacity: open ? 0.95 : 0, weight });
    }
  }

  function queueOf(record) {
    const trunk = record.pieces.trunk;
    return Math.max(0, trunk.carIn - Math.min(trunk.carOut, trunk.capacity));
  }

  function queueBubble(point, queued, phase, trend, offset, scale, labeled) {
    const size = Math.round(queueDiameter(queued, scale) * (labeled ? 0.78 : 0.46));
    const phaseText = t(`queue.${phase}`);
    const label = t("queue.label", { phase: phaseText, queue: n(queued) });
    const html = `
      <div class="queue-bubble-wrap ${offset} ${trend} ${labeled ? "labeled" : "dot"}" style="--queue-size:${size}px" role="img" aria-label="${label}">
        ${labeled ? `<span class="queue-phase">${phaseText}</span>` : ""}
        <span class="queue-bubble">${labeled ? `<strong>${n(queued)}</strong><small>${t("queue.queued")}</small>` : ""}</span>
      </div>`;
    return L.marker([point.lat, point.lon], {
      pane: "queues",
      interactive: false,
      icon: L.divIcon({ className: "queue-map-icon", html, iconSize: [1, 1], iconAnchor: [0, 0] }),
    });
  }

  function paintQueues() {
    queueLayer.clearLayers();
    queueMarkers = [];
    if (state.mapView !== "numbers" || !state.layers.congestion || !queueStops.length) return;
    const before = queueOf(result.pair.before);
    const after = queueOf(result.pair.after);
    const scale = Math.max(1000, before, after);
    queueMarkers = queueStops.map((point, index) => {
      const labeled = index === queueStops.length - 1;
      const markers = state.view === "compare"
        ? [
            queueBubble(point, before, "before", "baseline", "compare-before", scale, labeled),
            queueBubble(point, after, "after", queueChange(before, after), "compare-after", scale, labeled),
          ]
        : [queueBubble(point, state.view === "after" ? after : before, state.view, "current", "single", scale, labeled)];
      for (const marker of markers) marker.addTo(queueLayer);
      return markers;
    });
  }

  function queueBoxes() {
    if (state.mapView !== "numbers" || !state.layers.congestion) return [];
    const queued = Math.max(queueOf(result.pair.before), queueOf(result.pair.after));
    const scale = Math.max(1000, queued);
    const offset = state.view === "compare" ? 36 : 0;
    return queueStops.map((point, index) => {
      const at = map.latLngToContainerPoint([point.lat, point.lon]);
      const labeled = index === queueStops.length - 1;
      const size = queueDiameter(queued, scale) * (labeled ? 0.78 : 0.46) + offset;
      return { x: at.x, y: at.y, w: size + 8, h: size + (labeled ? 24 : 8), index, trail: !labeled };
    });
  }

  function exhaustBand(summary) {
    const perKm = summary.exhaust / Math.max(0.1, summary.km);
    if (perKm > 1800) return "peak";
    if (perKm > 1200) return "high";
    if (perKm > 700) return "mid";
    return "low";
  }

  function noiseBand(summary) {
    const db = 10 * Math.log10(Math.max(1, summary.noise));
    if (db > 31) return "peak";
    if (db > 28.5) return "high";
    if (db > 25.5) return "mid";
    return "low";
  }

  function carsBand(summary) {
    const cars = summary.carKm / Math.max(0.1, summary.km);
    if (cars > 1500) return "peak";
    if (cars > 900) return "high";
    if (cars > 450) return "mid";
    return "low";
  }

  function areaRow(measure, summary) {
    const name = t(`area.${measure}`);
    const { before, after } = summary;
    let value;
    let tone;
    if (state.view === "compare") {
      if (measure === "congestion") {
        const delta = after.congestedShare - before.congestedShare;
        tone = delta > 0.02 ? "more" : delta < -0.02 ? "less" : "same";
        value = `${share(before.congestedShare)} → ${share(after.congestedShare)}`;
      } else if (measure === "noise") {
        const db = decibels(before.noise, after.noise);
        tone = db > 0.5 ? "more" : db < -0.5 ? "less" : "same";
        value = tone === "same" ? t("area.same") : signedDb(before.noise, after.noise);
      } else {
        const [b, a] = measure === "traffic" ? [before.carKm, after.carKm] : [before.exhaust, after.exhaust];
        const change = percent(b, a);
        tone = change > 4 ? "more" : change < -4 ? "less" : "same";
        value = tone === "same" ? t("area.same") : `${signed(change)}%`;
      }
    } else {
      const current = state.view === "after" ? after : before;
      if (measure === "congestion") {
        tone = current.congestedShare > 0.4 ? "peak" : current.congestedShare > 0.2 ? "high" : current.congestedShare > 0.05 ? "mid" : "low";
        value = t("area.congested", { pct: share(current.congestedShare) });
      } else if (measure === "traffic") {
        tone = carsBand(current);
        value = t("area.carsPerHour", { n: n(current.carKm / Math.max(0.1, current.km)) });
      } else {
        tone = measure === "air" ? exhaustBand(current) : noiseBand(current);
        value = t(`level.${measure}.${tone}`);
      }
    }
    return { text: `${name} ${value}`, html: `<span class="area-row ${tone}"><b>${name}</b> ${value}</span>` };
  }

  function shownAreas() {
    if (!result.areas) return [];
    return Object.keys(result.areas).filter((id) => {
      if (LINE_IDS.includes(id)) return state.lines.includes(id);
      if (id === "parallel") return state.view !== "before";
      return true;
    });
  }

  const stacked = window.matchMedia("(max-width: 800px)");

  function freeArea() {
    const size = map.getSize();
    const frame = map.getContainer().getBoundingClientRect();
    const panel = (id) => (state.panels[id] ? element(id).getBoundingClientRect() : null);
    const design = panel("design");
    const results = panel("results");
    const legend = element("legend").getBoundingClientRect();
    const gap = 8;
    const floor = legend.height ? Math.min(size.y, legend.top - frame.top) : size.y;
    if (!stacked.matches) {
      return {
        left: (design ? design.right - frame.left : 0) + gap,
        top: gap,
        right: (results ? results.left - frame.left : size.x) - gap,
        bottom: floor - gap,
      };
    }
    return {
      left: gap,
      top: (design ? design.bottom - frame.top : 0) + gap,
      right: size.x - gap,
      bottom: (results ? results.top - frame.top : floor) - gap,
    };
  }

  function paintLabels() {
    labelLayer.clearLayers();
    labelBoxes = [];
    if (state.mapView !== "numbers") return;
    const measures = LAYER_ORDER.filter((id) => state.layers[id]);
    const items = [];
    if (measures.length && city) {
      for (const id of shownAreas()) {
        const summary = result.areas[id];
        const anchor = id === "parallel" ? summary.anchor : city.anchors[id];
        if (!anchor) continue;
        const rows = measures.map((measure) => areaRow(measure, summary));
        const name = t(id === "rossa" && state.view === "before" ? "place.corridor" : `place.${id}`);
        const label = `${name}: ${rows.map((row) => row.text).join(", ")}`;
        items.push({
          anchor,
          w: Math.max(name.length, ...rows.map((row) => row.text.length)) * 6.4 + 20,
          h: 22 + rows.length * 17,
          html: `<div class="area-label" role="img" aria-label="${label}"><span class="area-name">${name}</span>${rows.map((row) => row.html).join("")}</div>`,
        });
      }
    }
    if (state.layers.air) {
      const stations = airData?.stations || [];
      const scale = Math.max(30, ...stations.flatMap((station) => [station.no2, stationReading(station, "after").no2]));
      for (const station of stations) {
        const no2 = stationReading(station, scenarioOf()).no2;
        const size = measureDiameter(no2, scale, 34, 22);
        const label = `${station.name}: ${stationSummary(station, state.lang, state.view)}`;
        items.push({
          anchor: station,
          w: Math.max(station.name.length * 6.6 + 16, size + 8),
          h: size + 26,
          html: `<div class="station-label" role="img" aria-label="${label}"><span class="area-name">${station.name}</span><span class="measure-bubble ${airBand(no2)}" style="--measure-size:${size}px"><strong>${readingText(station, "no2", state.view)}</strong><small>NO2</small></span></div>`,
        });
      }
    }
    if (!items.length) return;
    const boxes = items.map((item) => {
      const at = map.latLngToContainerPoint([item.anchor.lat, item.anchor.lon]);
      return { x: at.x, y: at.y, w: item.w, h: item.h, item, startX: at.x, startY: at.y };
    });
    spreadBoxes(boxes, queueBoxes(), { area: freeArea() });
    labelBoxes = boxes.map(({ x, y, w, h }) => ({ x, y, w, h }));
    for (const box of boxes) {
      const at = map.containerPointToLatLng([box.x, box.y]);
      if (Math.hypot(box.x - box.startX, box.y - box.startY) > 14) {
        const anchor = [box.item.anchor.lat, box.item.anchor.lon];
        L.polyline([anchor, at], { pane: "leaders", color: "#ffffff", weight: 1, opacity: 0.75, interactive: false }).addTo(labelLayer);
        L.circleMarker(anchor, { pane: "leaders", radius: 3, color: "#ffffff", weight: 1, fillColor: "#1e1e1e", fillOpacity: 1, interactive: false }).addTo(labelLayer);
      }
      L.marker(at, {
        pane: "labels",
        interactive: false,
        icon: L.divIcon({ className: "measure-map-icon", html: box.item.html, iconSize: [1, 1], iconAnchor: [0, 0] }),
      }).addTo(labelLayer);
    }
  }

  function bubblesShown() {
    return Boolean(city) && state.mapView === "numbers" && state.layers.congestion && state.bubbles;
  }

  function bubbleTooltip(stretch, was, now) {
    const lines = [];
    if (was) {
      lines.push(t("bubble.compare", { before: was.level, after: now.level, loadBefore: share(was.load), loadAfter: share(now.load) }));
      lines.push(t("bubble.cars", { before: n(was.cars), after: n(now.cars) }));
    } else {
      lines.push(t("bubble.single", { level: now.level, load: share(now.load), cars: n(now.cars) }));
    }
    lines.push(t("bubble.peak", { load: share(now.peak), level: now.peakLevel }));
    const sources = [t("bubble.stretch", { km: decimal(stretch.length / 1000) })];
    const modelled = stretch.ids.reduce((sum, id) => sum + (city.roads[id].piece ? city.roads[id].length : 0), 0);
    if (modelled >= stretch.length / 2) sources.push(t("bubble.model"));
    return `<strong>${stretch.name}</strong><br>${lines.join("<br>")}<br><span class="tip-source">${sources.join("<br>")}</span>`;
  }

  function paintBubbles() {
    bubbleLayer.clearLayers();
    if (!bubblesShown()) return;
    const compare = state.view === "compare";
    const view = map.getBounds();
    const area = freeArea();
    const candidates = [];
    for (const item of rankStretches(stretches, city, result.cityBefore, result.cityAfter)) {
      const spots = item.stretch.spots
        .filter(({ lat, lon }) => view.contains([lat, lon]))
        .map(({ lat, lon }) => ({ ...map.latLngToContainerPoint([lat, lon]), lat, lon }));
      if (!spots.length) continue;
      const now = state.view === "before" ? item.before : item.after;
      candidates.push({ spots, d: compare ? 46 : bubbleDiameter(now.load), item, now, onTrail: onTrunk.has(item.stretch.key) });
    }
    const shown = placeBubbles(candidates, { area, taken: [...queueBoxes(), ...labelBoxes], limit: BUBBLE_LIMIT });
    const covered = new Set(shown.flatMap((bubble) => bubble.covers.map((box) => box.index)));
    queueMarkers.forEach((markers, index) => {
      for (const marker of markers) marker.setOpacity(covered.has(index) ? 0 : 1);
    });
    for (const { d, item, now, spot } of shown) {
      const was = compare ? item.before : null;
      const tone = was ? changeTone(now.load - was.load) : `los-${now.level}`;
      const main = !was || was.level === now.level ? now.level : `${was.level}→${now.level}`;
      const sub = was ? `${Math.round(was.load * 100)}→${share(now.load)}` : share(now.load);
      const label = t("bubble.label", { name: item.stretch.name, level: now.level, load: share(now.load) });
      const html = `<div class="road-bubble ${tone}" role="img" aria-label="${label}"><strong>${main}</strong><small>${sub}</small></div>`;
      L.marker([spot.lat, spot.lon], {
        pane: "bubbles",
        keyboard: false,
        icon: L.divIcon({ className: "bubble-map-icon", html, iconSize: [d, d], iconAnchor: [d / 2, d / 2] }),
      })
        .bindTooltip(() => bubbleTooltip(item.stretch, was, now), { ...tipSide(spot, area, d / 2), className: "road-tip", opacity: 1 })
        .addTo(bubbleLayer);
    }
  }

  function paintLegend() {
    const numbers = state.mapView === "numbers";
    const measure = activeHeatMeasure();
    element("los-key").hidden = !(numbers && state.layers.congestion && state.view !== "compare");
    element("change-key").hidden = !(state.view === "compare" && (numbers ? state.layers.congestion : Boolean(measure)));
    element("heat-key").hidden = !(state.mapView === "heat" && measure && state.view !== "compare");
    if (measure) element("heat-title").textContent = t(`impact.${measure}`);
    element("sensor-key").hidden = !(numbers && state.layers.air && airData?.stations?.length);
    element("legend-tram").hidden = state.view === "before";
  }

  function paintSwitches() {
    for (const button of document.querySelectorAll(".map-switch[data-layer]")) {
      const layer = button.dataset.layer;
      button.setAttribute("aria-pressed", String(Boolean(state.layers[layer])));
      button.setAttribute("aria-label", t(`layer.${layer}`));
    }
    const bubbles = element("bubbles");
    bubbles.setAttribute("aria-pressed", String(state.bubbles));
    bubbles.setAttribute("aria-label", t("layer.bubblesLabel"));
    bubbles.disabled = !city || state.mapView !== "numbers" || !state.layers.congestion;
    for (const button of document.querySelectorAll(".view-switch button")) {
      button.setAttribute("aria-pressed", String(button.dataset.view === state.mapView));
    }
    setText("view-note", t(state.mapView === "heat" ? "view.heatNote" : "view.numbersNote"));
  }

  function paintMap() {
    map.getContainer().classList.toggle("heat-view", state.mapView === "heat");
    paintRoads();
    paintHeat();
    paintLines();
    paintQueues();
    paintLabels();
    paintBubbles();
    paintLegend();
    paintSwitches();
  }

  // ---------- panel painting ----------

  function paintEditor() {
    const street = state.design.streets[state.street];
    const piece = corridor.pieces[state.street];
    const select = element("street");
    if (!select.options.length || select.dataset.lang !== state.lang) {
      select.replaceChildren(...PIECE_ORDER.map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = streetName(name);
        return option;
      }));
      select.dataset.lang = state.lang;
    }
    select.value = state.street;
    element("width").value = String(street.width);
    setText("width-value", `${decimal(Number(street.width))} m`);
    const baseline = streetLayout(piece, "before", street);
    const after = streetLayout(piece, "after", street);
    for (const button of element("direction").querySelectorAll("button")) {
      const oneWay = button.dataset.way === "one";
      button.setAttribute("aria-pressed", String(oneWay === Boolean(street.oneWay || after.forced)));
      button.disabled = Boolean(after.forced) && !oneWay;
    }
    const baselineText = t("lanes.today", { text: laneCount(baseline.lanes, false) });
    const afterLanes = laneCount(after.lanes, after.oneWay);
    const afterText = !piece.affected
      ? t("lanes.noTracks", { text: afterLanes })
      : after.forced
        ? t("lanes.forced", { text: afterLanes })
        : t("lanes.withTracks", { text: afterLanes });
    setText("lanes-note", state.view === "before" ? baselineText : `${baselineText} ${afterText}`);
    const cycle = element("cycle");
    const green = element("green");
    cycle.value = String(street.cycle);
    green.max = String(Number(street.cycle) - CROSS_MIN_S);
    green.value = String(Math.min(Number(street.green), Number(street.cycle) - CROSS_MIN_S));
    setText("cycle-value", `${street.cycle} s`);
    setText("green-value", `${Math.min(Number(street.green), Number(street.cycle) - CROSS_MIN_S)} s`);
    element("wave").setAttribute("aria-pressed", String(Boolean(street.wave)));
    const noSignals = !piece.signals.length;
    for (const id of ["cycle", "green"]) element(id).disabled = noSignals;
    element("wave").disabled = noSignals;
  }

  function priorityText() {
    const priority = state.design.priority;
    const trunk = state.design.streets.trunk;
    const plan = signalPlan(corridor.pieces.trunk, "after", trunk, priority, state.headway);
    if (priority) return t("priority.on", { car: Math.round(plan.carGreen), green: Math.round(plan.green), street: streetName("trunk") });
    let wait = 0;
    for (const name of ["trunk", "city", "fiera"]) {
      const piece = corridor.pieces[name];
      wait += junctionCount(piece.signals) * signalPlan(piece, "after", state.design.streets[name], false, state.headway).tramWait;
    }
    return t("priority.off", { each: Math.round(plan.tramWait), total: decimal(wait / 60) });
  }

  function paintControls() {
    const tram = state.view !== "before";
    for (const input of document.querySelectorAll("#tram-lines input, #tram-service input, #tram-service button")) input.disabled = !tram;
    for (const input of document.querySelectorAll("#lines input")) input.checked = state.lines.includes(input.value);
    element("shift").value = String(Math.round(state.shift * 100));
    setText("shift-value", `${Math.round(state.shift * 100)}%`);
    element("headway").value = String(state.headway);
    setText("headway-value", `${state.headway.toLocaleString(locale(state.lang))} min`);
    element("priority").setAttribute("aria-pressed", String(state.design.priority));
    setText("priority-note", priorityText());
    element("model").value = state.model;
    setText("model-use", t(`modelUse.${state.model}`));
    element("hour").value = String(state.hour);
    for (const id of ["predict", "optimise", "export-report"]) element(id).disabled = state.busy;
    paintEditor();
  }

  function pickRecord(view = state.view) {
    return view === "before" ? result.pair.before : result.pair.after;
  }

  function hardest(rows) {
    return [...rows].sort((a, b) => b.los.localeCompare(a.los) || b.ratio - a.ratio)[0];
  }

  function paintCards() {
    const compare = state.view === "compare";
    const after = state.view !== "before";
    const transitLabel = t(after ? "mode.transit" : "mode.buses");
    for (const node of document.querySelectorAll('[data-i18n="mode.transit"]')) node.textContent = transitLabel;
    for (const node of document.querySelectorAll('[data-i18n="mode.route"]')) node.textContent = t(after ? "mode.route" : "mode.corridor");
    const { before: b, after: a } = result.pair;
    const record = pickRecord();
    const impacts = result.impacts;
    const rossa = result.rossaOpen;

    setText("traffic-cars", compare
      ? t("cars.reachCompare", { before: n(b.carFlow), after: n(a.carFlow) })
      : t("cars.reach", { n: n(record.carFlow) }));
    const buses = hourRow(corridor, state.hour, "before").buses;
    const busesAfter = hourRow(corridor, state.hour, "after").buses;
    const trams = 60 / state.headway;
    setText("traffic-transit", compare
      ? rossa ? t("transit.busesToTrams", { buses: n(buses), trams: decimal(trams) }) : t("transit.busesCompare", { before: n(buses), after: n(busesAfter) })
      : after && rossa ? t("transit.trams", { n: decimal(trams) }) : t("transit.buses", { n: n(after ? busesAfter : buses) }));
    setText("traffic-bikes", compare
      ? t("bikes.flowCompare", { before: n(b.bikeFlow), after: n(a.bikeFlow) })
      : t("bikes.flow", { n: n(record.bikeFlow) }));

    if (impacts) {
      const carKm = impacts.traffic.carKm;
      setText("traffic-city", compare
        ? t("city.carKmChange", { pct: signedPct(carKm[0], carKm[1]) })
        : t("city.carKm", { n: n((after ? carKm[1] : carKm[0]) / 1000) }));
      const cong = impacts.congestion.city;
      const km = n(impacts.congestion.cityKm);
      setText("congestion-city", compare
        ? t("city.congestedCompare", { before: share(cong[0]), after: share(cong[1]), km })
        : t("city.congested", { pct: share(after ? cong[1] : cong[0]), km }));
    } else {
      setText("traffic-city", t("city.missing"));
      setText("congestion-city", t("city.missing"));
    }

    const queues = [queueOf(b), queueOf(a)];
    const diverted = impacts?.congestion.diverted || 0;
    let queueText = compare
      ? t("queue.compare", { before: n(queues[0]), after: n(queues[1]) })
      : (after ? queues[1] : queues[0]) < 1 ? t("queue.none") : t("queue.cars", { n: n(after ? queues[1] : queues[0]) });
    if (after && diverted >= 1) queueText += ` ${t("queue.diverted", { n: n(diverted) })}`;
    setText("congestion-queue", queueText);

    if (impacts) {
      const rowsBefore = impacts.streets.before;
      const rowsAfter = impacts.streets.after;
      const worst = hardest(compare || after ? rowsAfter : rowsBefore);
      if (compare) {
        const prior = rowsBefore.find((row) => row.name === worst.name);
        setText("congestion-worst", t("worst.compare", { street: streetName(worst.name), before: prior.los, after: worst.los }));
      } else {
        setText("congestion-worst", t("worst.single", { street: streetName(worst.name), level: worst.los, load: share(worst.ratio) }));
      }

      const air = impacts.air;
      const total = (i) => Math.max(1e-9, air.corridor[i]);
      if (compare) {
        setText("air-cars", t("air.change", { pct: signedPct(air.cars[0], air.cars[1]) }));
        setText("air-transit", rossa ? t("air.busesGone") : t("air.change", { pct: signedPct(air.buses[0], air.buses[1]) }));
        setText("air-city", t("air.cityChange", { pct: signedPct(air.city[0], air.city[1]) }));
      } else {
        const i = after ? 1 : 0;
        setText("air-cars", t("air.share", { pct: share(air.cars[i] / total(i)) }));
        setText("air-transit", after && rossa ? t("air.trams") : t("air.share", { pct: share(air.buses[i] / total(i)) }));
        setText("air-city", t("air.cityTotal", { pct: share(air.corridor[i] / Math.max(1e-9, air.city[i])) }));
      }

      const noise = impacts.noise;
      const parallel = result.areas?.parallel;
      if (compare) {
        setText("noise-route", t("noise.change", {
          db: signedDb(noise.corridor[0], noise.corridor[1]),
          cars: signedDb(noise.cars[0], noise.cars[1]),
        }));
        setText("noise-parallel", parallel
          ? t("noise.parallel", { db: signedDb(parallel.before.noise, parallel.after.noise), km: decimal(parallel.after.km) })
          : t("noise.noParallel"));
        setText("noise-city", t("noise.city", { db: signedDb(noise.city[0], noise.city[1]) }));
      } else {
        const i = after ? 1 : 0;
        const whole = Math.max(1e-9, noise.corridor[i]);
        const parts = {
          cars: share(noise.cars[i] / whole),
          buses: share(noise.buses[i] / whole),
          trams: share(noise.trams[i] / whole),
        };
        setText("noise-route", t(after ? "noise.split" : "noise.busesOnly", parts));
        setText("noise-parallel", !after ? "" : parallel
          ? t("noise.parallelKm", { km: decimal(parallel.after.km) })
          : t("noise.noParallel"));
        const loudest = city ? loudestRoad(after ? result.cityAfter : result.cityBefore) : null;
        setText("noise-city", loudest ? t("noise.loudest", { street: loudest }) : "");
      }
    }
    if (airData?.stations?.length) {
      const readings = airData.stations.map((station) => `${station.name} ${readingText(station, "no2", state.view)}`).join(" · ");
      const measured = t("air.measured", { from: dayMonth("01-01"), to: dayMonth(airData.through || "12-31"), year: yearText(), readings });
      setText("air-measured", after ? `${measured}. ${t("air.beforeTram")}` : measured);
    } else {
      setText("air-measured", "");
    }

    setText("trip-car", compare
      ? t("trip.carCompare", { fb: minutes(b.carFieraMin), fa: minutes(a.carFieraMin), ab: minutes(b.carPilastroMin), aa: minutes(a.carPilastroMin) })
      : t("trip.car", { fiera: minutes(record.carFieraMin), agraria: minutes(record.carPilastroMin) }));
    setText("trip-transit", compare
      ? t(rossa ? "trip.transitCompare" : "trip.busCompare", { fb: minutes(b.transitFieraMin), fa: minutes(a.transitFieraMin), ab: minutes(b.transitPilastroMin), aa: minutes(a.transitPilastroMin) })
      : t(after && rossa ? "trip.tram" : "trip.bus", { fiera: minutes(record.transitFieraMin), agraria: minutes(record.transitPilastroMin) }));
    setText("trip-bike", compare
      ? t("trip.bikeCompare", { before: minutes(b.bikeFieraMin), after: minutes(a.bikeFieraMin) })
      : t("trip.bike", { fiera: minutes(record.bikeFieraMin) }));
    let people = compare
      ? t("trip.peopleCompare", { before: n(b.peoplePerHour), after: n(a.peoplePerHour) })
      : t("trip.people", { n: n(record.peoplePerHour) });
    const waiting = compare ? a.unserved : record.unserved;
    if (waiting >= 1) people += ` ${t("trip.waiting", { n: n(waiting) })}`;
    setText("trip-people", people);
  }

  function loudestRoad(cityState) {
    let best = null;
    for (const roadState of cityState.roads) {
      const road = city.roads[roadState.id];
      if (!road.name || road.length < 150) continue;
      if (!best || roadState.noise > best.noise) best = { noise: roadState.noise, name: road.name };
    }
    return best?.name;
  }

  function levelBadge(letter) {
    return `<span class="los-badge" style="--los:${LOS_COLOR[letter]}">${letter}</span>`;
  }

  function paintStreets() {
    const body = document.querySelector("#street-table tbody");
    if (!result.impacts) return;
    const { before, after } = result.impacts.streets;
    const compare = state.view === "compare";
    const editable = state.view !== "before";
    const rows = editable ? after : before;
    for (const node of document.querySelectorAll('[data-i18n="streets.note"]')) node.textContent = t(editable ? "streets.note" : "streets.noteBefore");
    body.replaceChildren(...rows.map((row) => {
      const prior = before.find((item) => item.name === row.name);
      const tr = document.createElement("tr");
      if (editable) {
        tr.dataset.street = row.name;
        tr.tabIndex = 0;
        tr.classList.toggle("selected", row.name === state.street);
      }
      const lanes = laneCount(row.lanes, row.oneWay);
      const load = compare ? `${share(prior.ratio)} → ${share(row.ratio)}` : share(row.ratio);
      const level = compare ? `${levelBadge(prior.los)}→${levelBadge(row.los)}` : levelBadge(row.los);
      const queue = compare ? `${n(prior.queue)} → ${n(row.queue)}` : row.queue >= 1 ? n(row.queue) : "–";
      tr.innerHTML = `<th>${streetName(row.name)}</th><td>${compare ? `${laneCount(prior.lanes, prior.oneWay)} → ${lanes}` : lanes}</td><td>${load}</td><td>${level}</td><td>${queue}</td>`;
      return tr;
    }));
  }

  function paintChanged() {
    const list = element("changed");
    if (!city || !result.changed) {
      list.replaceChildren();
      return;
    }
    let items;
    if (state.view === "compare") {
      items = result.changed.filter((entry) => entry.after - entry.before > 0.02).map((entry) => t("changed.compare", {
        street: entry.name,
        before: entry.losBefore,
        after: entry.losAfter,
        cars: signedPct(entry.carsBefore, entry.carsAfter),
      }));
      if (!items.length) items = [t("changed.none")];
    } else {
      const cityState = state.view === "after" ? result.cityAfter : result.cityBefore;
      const byName = new Map();
      cityState.roads.forEach((roadState) => {
        const road = city.roads[roadState.id];
        if (!road.name || road.length < 80) return;
        const entry = byName.get(road.name) || { name: road.name, worst: 0, los: "A" };
        if (roadState.worst > entry.worst) Object.assign(entry, { worst: roadState.worst, los: roadState.los });
        byName.set(road.name, entry);
      });
      items = [...byName.values()].sort((a, b) => b.worst - a.worst).slice(0, 5)
        .map((entry) => t("changed.single", { street: entry.name, level: entry.los, load: share(entry.worst) }));
    }
    list.replaceChildren(...items.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }));
    document.querySelector("#city-roads h3").textContent = t(state.view === "compare" ? "changed.title" : "changed.titleBusiest");
    setText("roads-source", roadNotes().map((text) => noteText(state.lang, text)).join(" "));
  }

  function paintNumbers() {
    const { before, after } = result.pair;
    const rows = {
      carFieraMin: [before.carFieraMin, after.carFieraMin],
      carPilastroMin: [before.carPilastroMin, after.carPilastroMin],
      bikeFieraMin: [before.bikeFieraMin, after.bikeFieraMin],
      transitFieraMin: [before.transitFieraMin, after.transitFieraMin],
      transitPilastroMin: [before.transitPilastroMin, after.transitPilastroMin],
      viaEmiliaKmh: [before.viaEmiliaKmh, after.viaEmiliaKmh],
      carDemand: [before.pieces.trunk.carIn, after.pieces.trunk.carIn],
      carFlow: [before.carFlow, after.carFlow],
      carQueue: [queueOf(before), queueOf(after)],
      peoplePerHour: [before.peoplePerHour, after.peoplePerHour],
      unserved: [before.unserved, after.unserved],
      minutesLost: result.lost,
    };
    for (const [key, values] of Object.entries(rows)) {
      const cells = document.querySelectorAll(`tr[data-key="${key}"] td`);
      values.forEach((value, index) => {
        cells[index].textContent = key.endsWith("Min") ? minutes(value) : key === "viaEmiliaKmh" ? `${Math.round(value)} km/h` : n(value);
        cells[index].classList.toggle("active", (index === 0 ? "before" : "after") === scenarioOf());
      });
    }
  }

  /** The scenarios the current view shows: one, or both in Compare. */
  function shownScenarios() {
    return state.view === "compare" ? ["before", "after"] : [scenarioOf()];
  }

  function corridorNotes() {
    const supply = corridorData.supply;
    return shownScenarios().flatMap((scenario) => {
      const notes = (scenario === "after" && supply.after?.notes) || supply.notes;
      return [notes.cars, notes.bikes, notes.buses];
    });
  }

  function roadNotes() {
    if (!city) return [];
    return shownScenarios().map((scenario) => (scenario === "after" ? city.noteAfter : city.note));
  }

  function assumptionText() {
    const supply = corridorData.supply;
    const note = (text) => noteText(state.lang, text);
    return [
      ...corridorNotes().map(note),
      note(supply.signalTiming),
      t("assume.surrogate", { mae: decimal(corridorData.surrogate.holdoutMinutesMae, 2) }),
      t("assume.browser"),
      ...(state.view === "before" ? [] : [t("assume.scenario"), note(linesPlan?.note)]),
      t("assume.city"),
      ...roadNotes().map(note),
      note(airData?.notes?.[state.view] ?? airData?.note),
    ].filter(Boolean).join(" ");
  }

  function paintPanel() {
    document.body.classList.remove("view-before", "view-after", "view-compare");
    document.body.classList.add(`view-${state.view}`);
    const before = state.view === "before";
    document.title = t(before ? "page.titleBefore" : "page.title");
    for (const node of document.querySelectorAll('[data-i18n="page.heading"]')) node.textContent = t(before ? "page.headingBefore" : "page.heading");
    for (const node of document.querySelectorAll('[data-i18n="page.lede"]')) node.textContent = t(before ? "page.ledeBefore" : "page.lede");
    setText("map-caption", t(`caption.${state.view}`));
    setText("when", `Bologna · ${yearText()} · ${hourLabel(state.hour)}`);
    for (const view of ["before", "after", "compare"]) element(`show-${view}`).setAttribute("aria-pressed", String(state.view === view));
    paintControls();
    paintCards();
    paintStreets();
    paintChanged();
    paintNumbers();
    setText("assumptions", assumptionText());
  }

  function paintAll() {
    paintPanel();
    paintMap();
  }

  // ---------- controls ----------

  function setView(view) {
    state.view = view;
    refresh();
  }

  /** Levers that only exist with the tram move the map to After, so the change is visible. */
  function afterLever() {
    if (state.view === "before") state.view = "after";
  }

  function clearNotes() {
    setText("predict-note", "");
    setText("optimise-note", "");
  }

  element("show-before").addEventListener("click", () => setView("before"));
  element("show-after").addEventListener("click", () => setView("after"));
  element("show-compare").addEventListener("click", () => setView("compare"));

  element("lines").addEventListener("change", () => {
    state.lines = [...document.querySelectorAll("#lines input:checked")].map((input) => input.value);
    afterLever();
    clearNotes();
    refresh({ reseed: true });
  });

  element("shift").addEventListener("input", (event) => {
    state.shift = Number(event.target.value) / 100;
    afterLever();
    clearNotes();
    refresh();
  });
  element("headway").addEventListener("input", (event) => {
    state.headway = Number(event.target.value);
    afterLever();
    clearNotes();
    refresh({ reseed: true });
  });
  element("priority").addEventListener("click", () => {
    state.design.priority = !state.design.priority;
    afterLever();
    clearNotes();
    refresh();
  });

  element("street").addEventListener("change", (event) => {
    state.street = event.target.value;
    paintEditor();
    paintStreets();
  });
  document.querySelector("#street-table tbody").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-street]");
    if (!row) return;
    state.street = row.dataset.street;
    paintEditor();
    paintStreets();
    element("street-editor").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  document.querySelector("#street-table tbody").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.target.closest("tr[data-street]")?.click();
    }
  });

  const street = () => state.design.streets[state.street];
  element("width").addEventListener("input", (event) => {
    street().width = Number(event.target.value);
    clearNotes();
    refresh({ reseed: true });
  });
  element("direction").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-way]");
    if (!button) return;
    street().oneWay = button.dataset.way === "one";
    afterLever();
    clearNotes();
    refresh({ reseed: true });
  });
  element("cycle").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    street().cycle = value;
    street().green = Math.min(Number(street().green), value - CROSS_MIN_S);
    afterLever();
    clearNotes();
    refresh();
  });
  element("green").addEventListener("input", (event) => {
    street().green = Number(event.target.value);
    afterLever();
    clearNotes();
    refresh();
  });
  element("wave").addEventListener("click", () => {
    street().wave = !street().wave;
    afterLever();
    clearNotes();
    refresh();
  });
  element("reset-design").addEventListener("click", () => {
    state.design = defaultDesign();
    clearNotes();
    refresh({ reseed: true });
  });

  function modelLabel() {
    return t(`model.${state.model}`);
  }

  function timingSummary(design) {
    return PIECE_ORDER.filter((name) => corridor.pieces[name].signals.length).map((name) => {
      const item = design.streets[name];
      return t(item.wave ? "timing.wave" : "timing.plain", { street: streetName(name), cycle: item.cycle, green: item.green });
    }).join("; ");
  }

  async function busy(task) {
    state.busy = true;
    paintControls();
    try {
      return await task();
    } finally {
      state.busy = false;
      paintControls();
    }
  }

  element("optimise").addEventListener("click", () => busy(async () => {
    const note = element("optimise-note");
    const lostBefore = minutesLost(result.pair.after, corridor);
    const tuned = await optimiseLights(corridor, state.design, {
      model: state.model,
      shift: state.shift,
      headway: state.headway,
      hour: state.hour,
    }, { onProgress: (done) => { note.textContent = t("optimise.progress", { pct: share(done) }); } });
    state.design = tuned.design;
    afterLever();
    result = compute();
    paintAll();
    note.textContent = t("optimise.done", {
      model: modelLabel(),
      hour: hourLabel(state.hour),
      timings: timingSummary(tuned.design),
      before: n(lostBefore),
      after: n(tuned.minutesLost),
    });
  }));

  function setupText(found) {
    const best = found.best;
    const extra = Math.round(best.after.carFieraMin - best.before.carFieraMin);
    const change = extra > 0 ? t("prediction.longer", { n: extra }) : extra < 0 ? t("prediction.shorter", { n: -extra }) : t("prediction.same");
    return t("prediction", {
      model: modelLabel(),
      hour: hourLabel(state.hour),
      headway: best.headway.toLocaleString(locale(state.lang)),
      priority: t(best.priority ? "prediction.priorityOn" : "prediction.priorityOff"),
      direction: t(best.direction === "oneWay" ? "prediction.oneWay" : "prediction.asSet"),
      lights: t(best.lights === "optimised" ? "prediction.lightsOptimised" : "prediction.lightsAsSet"),
      people: n(best.after.peoplePerHour),
      waiting: n(best.after.unserved),
      change,
    });
  }

  async function runSearch() {
    const note = element("predict-note");
    const found = await searchBestSetup(corridor, {
      model: state.model,
      shift: state.shift,
      hour: state.hour,
      design: state.design,
    }, { onProgress: (done) => { note.textContent = t("predict.progress", { pct: share(done) }); } });
    state.search = { key: searchKey(), found };
    return found;
  }

  function searchKey() {
    return JSON.stringify([state.model, state.shift, state.hour]);
  }

  element("predict").addEventListener("click", () => busy(async () => {
    const found = await runSearch();
    const best = found.best;
    state.headway = best.headway;
    state.design = structuredClone(best.design);
    state.view = "after";
    result = compute();
    traffic.seed(ANIMATION, result.pair);
    paintAll();
    setText("predict-note", setupText(found));
  }));

  element("export-report").addEventListener("click", () => busy(async () => {
    const found = state.search?.key === searchKey() ? state.search.found : await runSearch();
    const slot = corridor.hours.find((item) => Number(item.hour) === Number(state.hour));
    const supply = corridorData.supply;
    const html = reportHtml({
      modelLabel: tr("en", `model.${state.model}`),
      hourLabel: slot?.label || hourLabel(state.hour),
      hourSlots: { before: hourRow(corridor, state.hour, "before"), after: hourRow(corridor, state.hour, "after") },
      years,
      setup: {
        shift: state.shift,
        headway: state.headway,
        lines: state.lines,
        design: merge(state.design),
      },
      current: result,
      found,
      streetName: (name) => tr("en", `street.${name}`),
      notes: [
        ...[supply.notes, supply.after?.notes].filter(Boolean).flatMap((notes) => [notes.cars, notes.bikes, notes.buses]),
        supply.signalTiming,
        tr("en", "assume.scenario"),
        tr("en", "assume.city"),
        city?.note,
        city?.noteAfter,
        airData?.note,
      ],
      generatedAt: new Date().toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Rome" }),
    });
    downloadReport(`bologna-tram-${String(state.hour).padStart(2, "0")}-${state.model}.html`, html);
    setText("predict-note", setupText(found));
  }));

  const hourSelect = element("hour");
  function fillHours() {
    hourSelect.replaceChildren(...corridor.hours.map((slot) => {
      const option = document.createElement("option");
      option.value = String(slot.hour);
      option.textContent = hourText(state.lang, slot.label || `${slot.hour}:00`);
      return option;
    }));
    hourSelect.value = String(state.hour);
  }
  fillHours();

  let dayTimer = 0;
  const dayButton = element("play-day");
  function stopDay() {
    if (dayTimer) {
      clearInterval(dayTimer);
      dayTimer = 0;
    }
    dayButton.textContent = t("control.playDay");
    dayButton.setAttribute("aria-pressed", "false");
  }
  function applyHour(hour) {
    state.hour = hour;
    clearNotes();
    refresh({ reseed: true });
  }
  hourSelect.addEventListener("change", () => {
    stopDay();
    applyHour(Number(hourSelect.value));
  });
  dayButton.addEventListener("click", () => {
    if (dayTimer) {
      stopDay();
      return;
    }
    const hours = corridor.hours.map((slot) => Number(slot.hour));
    dayButton.textContent = t("control.stopDay");
    dayButton.setAttribute("aria-pressed", "true");
    let index = 0;
    applyHour(hours[0]);
    dayTimer = setInterval(() => {
      index += 1;
      if (index >= hours.length) {
        stopDay();
        return;
      }
      applyHour(hours[index]);
    }, 1400);
  });

  element("model").addEventListener("change", (event) => {
    state.model = event.target.value;
    clearNotes();
    refresh({ reseed: true });
  });

  for (const button of document.querySelectorAll(".view-switch button")) {
    button.addEventListener("click", () => {
      state.mapView = button.dataset.view;
      if (state.mapView === "heat") {
        const keep = activeHeatMeasure() || "congestion";
        for (const layer of LAYER_ORDER) state.layers[layer] = layer === keep;
      }
      paintMap();
    });
  }
  element("bubbles").addEventListener("click", () => {
    state.bubbles = !state.bubbles;
    paintMap();
  });
  for (const button of document.querySelectorAll(".map-switch[data-layer]")) {
    const layer = button.dataset.layer;
    if (layer === "air" && !airData?.stations?.length && !city) button.hidden = true;
    button.addEventListener("click", () => {
      const on = !state.layers[layer];
      if (state.mapView === "heat" && HEAT_MEASURES.includes(layer)) {
        for (const other of LAYER_ORDER) state.layers[other] = false;
      }
      state.layers[layer] = on;
      paintMap();
    });
  }

  element("play").addEventListener("click", () => {
    state.playing = !state.playing;
    paintPlay();
  });
  function paintPlay() {
    element("play").textContent = t(state.playing ? "control.pause" : "control.play");
  }
  for (const button of document.querySelectorAll(".scale button")) {
    button.addEventListener("click", () => {
      state.timeScale = Number(button.dataset.scale);
      for (const other of document.querySelectorAll(".scale button")) other.setAttribute("aria-pressed", String(other === button));
    });
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
      clearNotes();
      paintAll();
    });
  }

  function setPanels(shown) {
    for (const [id, on] of Object.entries(shown)) {
      state.panels[id] = on;
      document.body.classList.toggle(`${id}-hidden`, !on);
    }
    paintMap();
  }
  for (const id of ["design", "results"]) {
    element(`hide-${id}`).addEventListener("click", () => {
      setPanels({ [id]: false });
      element(`show-${id}`).focus({ preventScroll: true });
    });
    element(`show-${id}`).addEventListener("click", () => {
      setPanels({ [id]: true });
      element(`hide-${id}`).focus({ preventScroll: true });
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.metaKey || (event.ctrlKey && !event.altKey)) return;
    if (event.code === "Space" && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      element("play").click();
    } else if (event.key === "1") element("show-before").click();
    else if (event.key === "2") element("show-after").click();
    else if (event.key === "3") element("show-compare").click();
    else if (event.key === "[") setPanels({ design: !state.panels.design });
    else if (event.key === "]") setPanels({ results: !state.panels.results });
    else if (event.key === "\\") {
      const show = !state.panels.design && !state.panels.results;
      setPanels({ design: show, results: show });
    }
  });

  // ---------- animation ----------

  function drawVehicle(vehicle, kind, size, scale) {
    const here = traffic.locate(vehicle);
    const point = map.latLngToContainerPoint([here.lat, here.lon]);
    const ahead = map.latLngToContainerPoint([here.lat2, here.lon2]);
    if (point.x < -20 || point.y < -20 || point.x > size.x + 20 || point.y > size.y + 20) return;
    const angle = Math.atan2(ahead.y - point.y, ahead.x - point.x);
    const side = scale * (kind === "tram" ? 0 : kind === "bike" ? 12 * (vehicle.dir > 0 ? 1 : -1) : kind === "bus" ? 7 : 8 * (vehicle.dir > 0 ? 1 : -1));
    ctx.save();
    ctx.translate(point.x + Math.sin(angle) * side, point.y - Math.cos(angle) * side);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
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
    if (state.playing) traffic.step(wall * state.timeScale, ANIMATION, result.pair);
    const size = map.getSize();
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    ctx.clearRect(0, 0, size.x, size.y);
    const vehicles = state.view === "before" ? [] : traffic.vehicles(scenarioOf());
    const zoom = map.getZoom();
    const scale = Math.max(0.45, Math.min(1, 2 ** (zoom - 15)));
    const carStride = zoom >= 15 ? 1 : zoom >= 14 ? 3 : 10;
    let carIndex = 0;
    for (const vehicle of vehicles) {
      if (vehicle.mode !== "car") continue;
      if (carIndex++ % carStride !== 0) continue;
      drawVehicle(vehicle, "car", size, scale);
    }
    for (const vehicle of vehicles) {
      if (vehicle.mode !== "car") drawVehicle(vehicle, vehicle.mode, size, scale);
    }
    requestAnimationFrame(frame);
  }

  applyStatic();
  paintPlay();
  paintAll();
  map.on("zoomend moveend resize", () => {
    paintHeat();
    paintQueues();
    paintLabels();
    paintBubbles();
  });
  map.on("move", () => paintHeat());
  requestAnimationFrame(frame);
}

main().catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<p id="boot-error">${error.message}</p>`);
  console.error(error);
});
